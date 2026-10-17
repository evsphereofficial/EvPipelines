import { config } from "dotenv";
import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import { parseArgs } from "node:util";
import { executeTimeline, type DiscordHandler, type TwitterHandler } from "./executor.js";
import { createDiscord } from "./platforms/discord.js";
import { createTwitter } from "./platforms/twitter.js";
import { createCookieTwitter } from "./platforms/twitter-cookies.js";
import { createBrowserTwitter } from "./platforms/twitter-browser.js";
import { validateTimeline } from "./timeline.js";

config();

async function main(): Promise<void> {
  const { values } = parseArgs({
    options: {
      "dry-run": { type: "boolean", default: false },
      fast: { type: "boolean", default: false },
      timeline: { type: "string", default: "timeline.json" },
      check: { type: "boolean", default: false },
      delete: { type: "string" },
    },
  });

  const wantsCookiePosting =
    Boolean(process.env.TWITTER_AUTH_TOKEN) && Boolean(process.env.TWITTER_CT0);
  const wantsBrowserTransport = process.env.POST_TRANSPORT === "browser";

  if (values.delete) {
    if (!wantsBrowserTransport) {
      console.error("Delete mode needs POST_TRANSPORT=browser");
      process.exit(1);
    }
    try {
      const client = createBrowserTwitter(process.env);
      await client.init();
      await client.delete(values.delete);
      await client.close();
    } catch (error) {
      console.error(error instanceof Error ? error.message : String(error));
      process.exit(1);
    }
    return;
  }

  if (values.check) {
    if (wantsBrowserTransport) {
      try {
        const client = createBrowserTwitter(process.env);
        await client.init();
        const check = await client.verify();
        console.log(`[check] session valid - UI=@${check.handle} session_twid=${check.twid ?? "unknown"}`);
        await client.close();
      } catch (error) {
        console.error(error instanceof Error ? error.message : String(error));
        process.exit(1);
      }
      return;
    }
    if (!wantsCookiePosting) {
      console.error("Check mode needs TWITTER_AUTH_TOKEN + TWITTER_CT0 in .env (cookie posting).");
      process.exit(1);
    }
    try {
      const client = createCookieTwitter(process.env);
      await client.init();
      const screenName = await client.verify();
      console.log(`[check] session valid - logged in as @${screenName}`);
    } catch (error) {
      console.error(error instanceof Error ? error.message : String(error));
      process.exit(1);
    }
    return;
  }

  const dryRun = values["dry-run"] ?? false;
  const fast = values.fast ?? false;
  const timelinePath = resolve(process.cwd(), values.timeline ?? "timeline.json");

  let raw: string;
  try {
    raw = readFileSync(timelinePath, "utf8");
    if (raw.charCodeAt(0) === 0xfeff) raw = raw.slice(1);
  } catch {
    console.error(`Could not read timeline file: ${timelinePath}`);
    process.exit(1);
  }

  let parsed: unknown;
  try {
    parsed = JSON.parse(raw);
  } catch (error) {
    console.error(`Timeline file is not valid JSON: ${error instanceof Error ? error.message : error}`);
    process.exit(1);
  }

  let actions;
  try {
    actions = validateTimeline(parsed);
  } catch (error) {
    console.error(`Invalid timeline: ${error instanceof Error ? error.message : error}`);
    process.exit(1);
  }

  const needsTwitter = actions.some((a) => a.platform === "twitter");
  const needsDiscord = actions.some((a) => a.platform === "discord");

  let twitter: TwitterHandler | null = null;
  let discord: DiscordHandler | null = null;

  try {
    if (dryRun) {
      console.log("Dry run: no API calls will be made, credentials not required.");
    } else {
      if (needsTwitter) {
        if (wantsBrowserTransport) {
          console.log("Auth mode: browser session (Playwright + cookies) â€” real Chrome fingerprint");
          const client = createBrowserTwitter(process.env);
          await client.init();
          twitter = client;
        } else if (wantsCookiePosting) {
          console.log("Auth mode: cookie session (auth_token + ct0)");
          const client = createCookieTwitter(process.env);
          await client.init();
          twitter = client;
        } else {
          console.log("Auth mode: official X API keys (OAuth 1.0a)");
          twitter = createTwitter(process.env);
        }
      }
      if (needsDiscord) discord = createDiscord(process.env);
    }
  } catch (error) {
    console.error(error instanceof Error ? error.message : error);
    process.exit(1);
  }

  console.log(`Loaded ${actions.length} action(s) from ${timelinePath}`);
  console.log(
    fast
      ? "Fast mode: delays skipped, actions run immediately."
      : "Running with real delays. Press Ctrl+C to abort."
  );
  console.log("");

  const jitterMin = Number(process.env.HUMAN_PAUSE_MIN_MS ?? 6_000);
  const jitterMax = Number(process.env.HUMAN_PAUSE_MAX_MS ?? 18_000);
  const outcomes = await executeTimeline(actions, {
    dryRun,
    fast,
    twitter,
    discord,
    jitterMs: { min: jitterMin, max: jitterMax },
  });

  console.log("");
  console.log("Summary:");
  for (const outcome of outcomes) {
    const detail = outcome.resultId
      ? ` (${outcome.resultId})`
      : outcome.error
        ? ` - ${outcome.error}`
        : "";
    console.log(`  ${outcome.status.padEnd(8)} ${outcome.id} [${outcome.platform}]${detail}`);
  }

  const failed = outcomes.filter((o) => o.status === "failed").length;
  if (failed > 0) {
    console.error(`\n${failed} action(s) failed.`);
    process.exitCode = 1;
  }
}

main().catch((error) => {
  console.error(error instanceof Error ? error.message : error);
  process.exit(1);
});
