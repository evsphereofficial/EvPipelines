import { TwitterApi } from "twitter-api-v2";
import type { TwitterHandler } from "../executor.js";

const REQUIRED_ENV = [
  "TWITTER_API_KEY",
  "TWITTER_API_SECRET",
  "TWITTER_ACCESS_TOKEN",
  "TWITTER_ACCESS_SECRET",
] as const;

export function createTwitter(env: NodeJS.ProcessEnv): TwitterHandler {
  const missing = REQUIRED_ENV.filter((key) => !env[key]);
  if (missing.length > 0) {
    throw new Error(`Missing Twitter credentials in .env: ${missing.join(", ")}`);
  }

  const client = new TwitterApi({
    appKey: env.TWITTER_API_KEY!,
    appSecret: env.TWITTER_API_SECRET!,
    accessToken: env.TWITTER_ACCESS_TOKEN!,
    accessSecret: env.TWITTER_ACCESS_SECRET!,
  });

  return {
    async post(text: string): Promise<string> {
      const result = await client.v2.tweet({ text });
      return result.data.id;
    },
    async reply(text: string, tweetId: string): Promise<string> {
      const result = await client.v2.reply(text, tweetId);
      return result.data.id;
    },
  };
}
