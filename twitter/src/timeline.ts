export type Platform = "twitter" | "discord";

export interface TimelineAction {
  id: string;
  at: string;
  platform: Platform;
  text: string;
  replyTo?: string;
}

export interface ResolvedAction extends TimelineAction {
  runAt: number;
}

const PLATFORMS: Platform[] = ["twitter", "discord"];
const RELATIVE_FULL = /^(?:\d+(?:s|m|h))+$/;
const RELATIVE_PART = /\d+(?:s|m|h)/g;
const TWITTER_LIMIT = 25_000; // X Premium (delegate account) allows up to 25,000 chars
const DISCORD_LIMIT = 2000;

function parseRelative(at: string): number | null {
  if (!RELATIVE_FULL.test(at)) return null;
  const parts = at.match(RELATIVE_PART);
  if (!parts) return null;
  let total = 0;
  for (const part of parts) {
    const value = Number(part.slice(0, -1));
    const unit = part.slice(-1);
    total += value * (unit === "s" ? 1_000 : unit === "m" ? 60_000 : 3_600_000);
  }
  return total;
}

export function parseAt(at: string, startMs: number): number {
  const trimmed = at.trim();
  const relative = parseRelative(trimmed);
  if (relative !== null) return startMs + relative;
  const absolute = Date.parse(trimmed);
  if (!Number.isNaN(absolute)) return absolute;
  throw new Error(
    `Invalid "at" value "${at}". Use relative ("45s", "10m", "1h30m") or an ISO datetime ("2026-10-15T09:00:00").`
  );
}

export function validateTimeline(raw: unknown): ResolvedAction[] {
  if (raw === null || typeof raw !== "object" || !Array.isArray((raw as { actions?: unknown }).actions)) {
    throw new Error('Timeline must be a JSON object like { "actions": [ ... ] }');
  }
  const actions = (raw as { actions: unknown[] }).actions;
  if (actions.length === 0) throw new Error("Timeline contains no actions.");

  const startMs = Date.now();
  const resolved: ResolvedAction[] = [];
  const indexById = new Map<string, number>();

  for (let i = 0; i < actions.length; i++) {
    const entry = actions[i];
    const where = `actions[${i}]`;
    if (entry === null || typeof entry !== "object") {
      throw new Error(`${where} must be an object`);
    }
    const a = entry as Record<string, unknown>;
    const label = typeof a.id === "string" && a.id ? ` (${a.id})` : "";

    if (typeof a.id !== "string" || !a.id.trim()) {
      throw new Error(`${where}.id must be a non-empty string`);
    }
    if (indexById.has(a.id)) {
      throw new Error(`${where}: duplicate action id "${a.id}"`);
    }
    if (typeof a.at !== "string") {
      throw new Error(`${where}${label}.at must be a string`);
    }
    if (typeof a.platform !== "string" || !PLATFORMS.includes(a.platform as Platform)) {
      throw new Error(`${where}${label}.platform must be one of: ${PLATFORMS.join(", ")}`);
    }
    if (typeof a.text !== "string" || !a.text.trim()) {
      throw new Error(`${where}${label}.text must be a non-empty string`);
    }
    if (a.replyTo !== undefined && typeof a.replyTo !== "string") {
      throw new Error(`${where}${label}.replyTo must be a string`);
    }
    if (a.replyTo !== undefined && a.platform !== "twitter") {
      throw new Error(`${where}${label}: replyTo is only supported on the twitter platform`);
    }

    const limit = a.platform === "twitter" ? TWITTER_LIMIT : DISCORD_LIMIT;
    const length = [...a.text].length;
    if (length > limit) {
      throw new Error(`${where}${label}: text is ${length} chars but ${a.platform} allows ${limit}`);
    }

    const action: ResolvedAction = {
      id: a.id,
      at: a.at,
      platform: a.platform as Platform,
      text: a.text,
      replyTo: a.replyTo as string | undefined,
      runAt: parseAt(a.at, startMs),
    };
    indexById.set(action.id, resolved.length);
    resolved.push(action);
  }

  for (const action of resolved) {
    if (!action.replyTo) continue;
    const parentIndex = indexById.get(action.replyTo);
    if (parentIndex === undefined) {
      if (/^\d+$/.test(action.replyTo)) continue;
      throw new Error(
        `"${action.id}" replies to "${action.replyTo}", which is not an action id in this timeline`
      );
    }
    const parent = resolved[parentIndex]!;
    if (parent.runAt > action.runAt) {
      throw new Error(`"${action.id}" is scheduled before its parent "${parent.id}"`);
    }
    if (parent.runAt === action.runAt && parentIndex > indexById.get(action.id)!) {
      throw new Error(
        `"${action.id}" and its parent "${parent.id}" run at the same time but the parent is listed later; list the parent first`
      );
    }
  }

  return resolved;
}

