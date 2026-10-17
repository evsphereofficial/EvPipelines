import type { ResolvedAction } from "./timeline.js";

export interface TwitterHandler {
  post(text: string): Promise<string>;
  reply(text: string, tweetId: string): Promise<string>;
}

export interface DiscordHandler {
  send(text: string): Promise<void>;
}

export interface ExecuteOptions {
  dryRun: boolean;
  fast: boolean;
  twitter: TwitterHandler | null;
  discord: DiscordHandler | null;
  jitterMs?: { min: number; max: number };
}

export interface ActionOutcome {
  id: string;
  platform: string;
  status: "posted" | "failed" | "dry-run";
  resultId?: string;
  error?: string;
}

function timestamp(): string {
  return new Date().toLocaleTimeString("en-GB", { hour12: false });
}

function log(message: string): void {
  console.log(`[${timestamp()}] ${message}`);
}

function formatDuration(ms: number): string {
  const total = Math.max(0, Math.round(ms / 1000));
  const hours = Math.floor(total / 3600);
  const minutes = Math.floor((total % 3600) / 60);
  const seconds = total % 60;
  if (hours > 0) return `${hours}h ${minutes}m`;
  if (minutes > 0) return `${minutes}m ${seconds}s`;
  return `${seconds}s`;
}

function sleep(ms: number): Promise<void> {
  return new Promise((resolveSleep) => {
    const end = Date.now() + ms;
    const tick = () => {
      const remaining = end - Date.now();
      if (remaining <= 0) resolveSleep();
      else setTimeout(tick, Math.min(remaining, 60_000));
    };
    tick();
  });
}

function truncate(text: string, max = 80): string {
  const flat = text.replace(/\s+/g, " ").trim();
  return flat.length > max ? `${flat.slice(0, max - 1)}...` : flat;
}

function resolveParentId(replyTo: string, posted: Map<string, string>): string {
  const parentId = posted.get(replyTo);
  if (parentId) return parentId;
  if (/^\d+$/.test(replyTo)) return replyTo;
  throw new Error(`Parent tweet for "${replyTo}" has not been posted`);
}

export async function executeTimeline(
  actions: ResolvedAction[],
  opts: ExecuteOptions
): Promise<ActionOutcome[]> {
  const sorted = [...actions].sort((a, b) => a.runAt - b.runAt);
  const posted = new Map<string, string>();
  const outcomes: ActionOutcome[] = [];

  for (const action of sorted) {
    const waitMs = action.runAt - Date.now();

    if (waitMs > 0) {
      if (opts.fast) {
        log(`[${action.id}] would run in ${formatDuration(waitMs)} (fast mode: running now)`);
      } else {
        log(`[${action.id}] next up in ${formatDuration(waitMs)} (${action.platform})`);
        await sleep(waitMs);
      }
    }

    const kind = action.replyTo ? `reply to "${action.replyTo}"` : "post";
    log(`[${action.id}] ${action.platform} ${kind}: "${truncate(action.text)}"`);

    if (opts.jitterMs) {
      const pause = Math.floor(opts.jitterMs.min + Math.random() * (opts.jitterMs.max - opts.jitterMs.min));
      log(`[${action.id}] human-paced pause ${Math.round(pause / 1000)}s`);
      await sleep(pause);
    }

    if (opts.dryRun) {
      log(`[${action.id}] dry-run, nothing sent`);
      outcomes.push({ id: action.id, platform: action.platform, status: "dry-run" });
      continue;
    }

    try {
      if (action.platform === "twitter") {
        if (!opts.twitter) throw new Error("Twitter client not configured");
        const tweetId = action.replyTo
          ? await opts.twitter.reply(action.text, resolveParentId(action.replyTo, posted))
          : await opts.twitter.post(action.text);
        posted.set(action.id, tweetId);
        log(`[${action.id}] tweet id ${tweetId}`);
        outcomes.push({ id: action.id, platform: action.platform, status: "posted", resultId: tweetId });
      } else {
        if (!opts.discord) throw new Error("Discord client not configured");
        await opts.discord.send(action.text);
        log(`[${action.id}] discord message sent`);
        outcomes.push({ id: action.id, platform: action.platform, status: "posted" });
      }
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      log(`[${action.id}] FAILED: ${message}`);
      outcomes.push({ id: action.id, platform: action.platform, status: "failed", error: message });
    }
  }

  return outcomes;
}
