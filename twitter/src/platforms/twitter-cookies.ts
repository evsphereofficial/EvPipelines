import { ClientTransaction, fetchXDocument } from "x-client-transaction-id";
import type { TwitterHandler } from "../executor.js";

const BEARER =
  "AAAAAAAAAAAAAAAAAAAAANRILgAAAAAAnNwIzUejRCOuH5E6I8xnZz4puTs=1Zv7ttfk8LF81IUq16cHjhLTvJu4FA33AGWWjCpTnA";
const USER_AGENT =
  "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/140.0.0.0 Safari/537.36";

const HOME_URL = "https://x.com";
const CREATE_TWEET_PATH = "/i/api/graphql";
const FALLBACK_QUERY_ID = "nwlaCCZoDFeS0AcfTS0dOQ";

const BROWSER_HEADERS: Record<string, string> = {
  "user-agent": USER_AGENT,
  accept: "*/*",
  "accept-language": "en-US,en;q=0.9",
  "content-type": "application/json",
  origin: "https://x.com",
  referer: "https://x.com/home",
  "x-twitter-auth-type": "OAuth2Session",
  "x-twitter-active-user": "yes",
  "x-twitter-client-language": "en",
};

export interface CookieTwitterOptions {
  authToken: string;
  ct0: string;
  extraCookies?: string;
  /** Full raw cookie header (paste from browser). Overrides manual compose when set. */
  cookieHeader?: string;
}

interface CreateTweetResponse {
  data?: {
    create_tweet?: {
      tweet_results?: {
        result?: {
          rest_id?: string;
        };
      };
    };
  };
  errors?: Array<{ message?: string; code?: number }>;
}

function sleep(ms: number): Promise<void> {
  return new Promise((r) => setTimeout(r, ms));
}

function jitter(minMs: number, maxMs: number): number {
  return Math.floor(minMs + Math.random() * (maxMs - minMs));
}

function baseHeaders(cookies: string, ct0: string): Record<string, string> {
  return {
    ...BROWSER_HEADERS,
    authorization: `Bearer ${BEARER}`,
    "x-csrf-token": ct0,
    cookie: cookies,
  };
}

export class CookieTwitterClient implements TwitterHandler {
  private readonly cookies: string;
  private readonly ct0: string;
  private transaction: ClientTransaction | null = null;
  private queryId: string = FALLBACK_QUERY_ID;

  constructor(opts: CookieTwitterOptions) {
    this.cookies =
      opts.cookieHeader?.trim() ||
      `auth_token=${opts.authToken}; ct0=${opts.ct0}` +
        (opts.extraCookies?.trim() ? `; ${opts.extraCookies.trim()}` : "");
    this.ct0 = opts.ct0;
  }

  async init(): Promise<void> {
    console.log("[cookies] warming session (fetching x.com home)...");
    const doc = await fetchXDocument();
    this.transaction = await ClientTransaction.create(doc);
    console.log("[cookies] transaction id generator ready");

    const page = await fetch(HOME_URL, {
      headers: { ...baseHeaders(this.cookies, this.ct0), accept: "text/html" },
    });
    if (!page.ok) {
      throw new Error(`x.com home returned ${page.status} — cookies may be expired`);
    }
    this.queryId = await this.discoverQueryId(await page.text());
    console.log(`[cookies] using CreateTweet queryId ${this.queryId.slice(0, 8)}...`);
  }

  private async discoverQueryId(html: string): Promise<string> {
    try {
      const bundleUrls = new Set<string>();
      const patterns = [
        /https:\/\/abs\.twimg\.com\/responsive-web\/client-web[^"'\\]+?\.js/g,
        /https:\/\/abs\.twimg\.com\/responsive-web\/client-web-legacy[^"'\\]+?\.js/g,
      ];
      for (const re of patterns) {
        for (const m of html.matchAll(re)) {
          if (m[0]) bundleUrls.add(m[0].replace(/\\u002F/g, "/"));
        }
      }
      const urls = [...bundleUrls].slice(0, 4);
      for (const url of urls) {
        const res = await fetch(url, {
          headers: { "user-agent": USER_AGENT, accept: "*/*" },
        });
        if (!res.ok) continue;
        const js = await res.text();
        const found = js.match(/queryId:"([A-Za-z0-9_-]+)",operationName:"CreateTweet"/);
        if (found && found[1]) return found[1];
      }
    } catch (error) {
      console.log(`[cookies] queryId discovery failed (${String(error)}), using fallback`);
    }
    return FALLBACK_QUERY_ID;
  }

  private async transactionId(method: string, path: string): Promise<string> {
    if (!this.transaction) throw new Error("Client not initialized — call init() first");
    return this.transaction.generateTransactionId(method, path);
  }

  private async createTweet(
    text: string,
    replyToTweetId?: string,
  ): Promise<string> {
    await sleep(jitter(1_500, 4_500));

    const path = `${CREATE_TWEET_PATH}/${this.queryId}/CreateTweet`;
    const txId = await this.transactionId("POST", path);

    const variables: Record<string, unknown> = {
      tweet_text: text,
      dark_request: false,
      media: { media_entities: [], possibly_sensitive: false },
      semantic_annotation_ids: [],
    };
    if (replyToTweetId) {
      variables.reply = {
        in_reply_to_tweet_id: replyToTweetId,
        excluded_reply_user_ids: [],
      };
    }

    const res = await fetch(`https://x.com${path}`, {
      method: "POST",
      headers: {
        ...baseHeaders(this.cookies, this.ct0),
        "x-client-transaction-id": txId,
        referer: replyToTweetId
          ? `https://x.com/i/status/${replyToTweetId}`
          : "https://x.com/compose/post",
      },
      body: JSON.stringify({
        features: {},
        variables,
        queryId: this.queryId,
      }),
    });

    const body = (await res.json().catch(() => null)) as CreateTweetResponse | null;

    if (!res.ok || !body) {
      throw new Error(`CreateTweet failed: HTTP ${res.status}`);
    }
    if (body.errors && body.errors.length > 0) {
      const first = body.errors[0];
      throw new Error(`CreateTweet rejected: ${first?.message ?? "unknown"}${first?.code ? ` (code ${first.code})` : ""}`);
    }
    const tweetId = body.data?.create_tweet?.tweet_results?.result?.rest_id;
    if (!tweetId) throw new Error("CreateTweet returned no tweet id");
    return tweetId;
  }

  async post(text: string): Promise<string> {
    return this.createTweet(text);
  }

  async reply(text: string, tweetId: string): Promise<string> {
    return this.createTweet(text, tweetId);
  }

  /** Verify the session is valid and return the logged-in screen name. */
  async verify(): Promise<string> {
    const path = "/1.1/account/settings.json";
    const txId = await this.transactionId("GET", path);
    const res = await fetch(`https://x.com/i/api${path}`, {
      headers: {
        ...baseHeaders(this.cookies, this.ct0),
        "x-client-transaction-id": txId,
      },
    });
    if (!res.ok) {
      throw new Error(`settings check failed: HTTP ${res.status} — cookies invalid or expired`);
    }
    const json = (await res.json()) as { screen_name?: string };
    if (!json.screen_name) throw new Error("settings response missing screen_name");
    return json.screen_name;
  }
}

export function createCookieTwitter(env: NodeJS.ProcessEnv): CookieTwitterClient {
  const authToken = env.TWITTER_AUTH_TOKEN;
  const ct0 = env.TWITTER_CT0;
  if (!authToken || !ct0) {
    throw new Error(
      "Cookie posting requires TWITTER_AUTH_TOKEN and TWITTER_CT0 in .env",
    );
  }
  return new CookieTwitterClient({
    authToken,
    ct0,
    extraCookies: env.TWITTER_EXTRA_COOKIES,
    cookieHeader: env.TWITTER_COOKIE_HEADER,
  });
}
