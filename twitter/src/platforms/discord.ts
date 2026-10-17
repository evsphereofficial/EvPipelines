import type { DiscordHandler } from "../executor.js";

export function createDiscord(env: NodeJS.ProcessEnv): DiscordHandler {
  const url = env.DISCORD_WEBHOOK_URL;
  if (!url) {
    throw new Error("Missing Discord webhook URL in .env: DISCORD_WEBHOOK_URL");
  }

  return {
    async send(text: string): Promise<void> {
      const response = await fetch(url, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ content: text }),
      });
      if (!response.ok) {
        const body = await response.text();
        throw new Error(`Discord webhook failed: ${response.status} ${body.slice(0, 200)}`);
      }
    },
  };
}
