import { chromium, type BrowserContext, type Page } from "playwright";
import { ClientTransaction, fetchXDocument } from "x-client-transaction-id";
import type { TwitterHandler } from "../executor.js";

const BEARER =
  "AAAAAAAAAAAAAAAAAAAAANRILgAAAAAAnNwIzUejRCOuH5E6I8xnZz4puTs=1Zv7ttfk8LF81IUq16cHjhLTvJu4FA33AGWWjCpTnA";
const USER_AGENT =
  "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/140.0.0.0 Safari/537.36";
const HOME_URL = "https://x.com/home";
const FALLBACK_QUERY_ID = "nwlaCCZoDFeS0AcfTS0dOQ";

export interface ParsedCookie {
  name: string;
  value: string;
}

/** Accepts "a=b; c=d", "a=b\nc=d" or DevTools tab-separated cookie table dumps. */
export function parseCookies(raw: string): ParsedCookie[] {
  const cookies: ParsedCookie[] = [];
  const seen = new Set<string>();

  const push = (name: string, value: string): void => {
    if (!name || seen.has(name)) return;
    seen.add(name);
    cookies.push({ name, value });
  };

  const rows = raw
    .split(/\r?\n/)
    .map((r) => r.trim())
    .filter(Boolean);

  const isTable = rows.some((r) => r.includes("\t"));
  if (isTable) {
    for (const row of rows) {
      const cols = row.split("\t").map((c) => c.trim());
      const name = cols[0];
      let value = cols[1] ?? "";
      value = value.replace(/^"|"$/g, "");
      if (name && name !== "name" && !name.includes(" ")) push(name, value);
    }
    return cookies;
  }

  for (const part of raw.split(/[;\n]/)) {
    const eq = part.indexOf("=");
    if (eq <= 0) continue;
    push(part.slice(0, eq).trim(), part.slice(eq + 1).trim());
  }
  return cookies;
}

const FULL_FEATURES: Record<string, boolean> = {
  premium_content_api_read_enabled: false,
  communities_web_enable_tweet_community_results_fetch: true,
  c9s_tweet_anatomy_moderator_badge_enabled: true,
  responsive_web_grok_analyze_button_fetch_trends_enabled: false,
  responsive_web_grok_analyze_post_followups_enabled: true,
  rweb_cashtags_composer_attachment_enabled: true,
  responsive_web_jetfuel_frame: true,
  rweb_sports_post_context_enabled: true,
  responsive_web_grok_share_attachment_enabled: true,
  responsive_web_grok_annotations_enabled: true,
  responsive_web_edit_tweet_api_enabled: true,
  rweb_conversational_replies_downvote_enabled: false,
  graphql_is_translatable_rweb_tweet_is_translatable_enabled: true,
  view_counts_everywhere_api_enabled: true,
  longform_notetweets_consumption_enabled: true,
  responsive_web_twitter_article_tweet_consumption_enabled: true,
  content_disclosure_indicator_enabled: true,
  content_disclosure_ai_generated_indicator_enabled: true,
  responsive_web_grok_show_grok_translated_post: true,
  responsive_web_grok_analysis_button_from_backend: true,
  post_ctas_fetch_enabled: false,
  longform_notetweets_rich_text_read_enabled: true,
  longform_notetweets_inline_media_enabled: false,
  profile_label_improvements_pcf_label_in_post_enabled: true,
  responsive_web_profile_redirect_enabled: true,
  rweb_tipjar_consumption_enabled: false,
  verified_phone_label_enabled: true,
  responsive_web_nested_quote_preview_enabled: true,
  articles_preview_enabled: true,
  rweb_cashtags_enabled: true,
  responsive_web_grok_community_note_auto_translation_is_enabled: true,
  freedom_of_speech_not_reach_fetch_enabled: true,
  standardized_nudges_misinfo: true,
  tweet_with_visibility_results_prefer_gql_limited_actions_policy_enabled: true,
  responsive_web_grok_image_annotation_enabled: true,
  responsive_web_grok_imagine_annotation_enabled: true,
  responsive_web_graphql_timeline_navigation_enabled: true,
};

interface TweetResult {
  tweet_results?: {
    result?: {
      rest_id?: string;
      core?: { user_results?: { result?: { rest_id?: string } } };
    };
  };
}

interface CookieTwitterBrowserOptions {
  rawCookies: string;
  authToken: string;
  ct0: string;
  headless?: boolean;
  /** Handle to switch into via the delegation switcher after login (e.g. "theforexclue"). */
  actAsHandle?: string;
  /** The real user id of the target account — sent as x-act-as-user-id (X delegation header). */
  actingUserId?: string;
  /** The real twid user-id of the target account — posting hard-fails if the session doesn't match. */
  expectedTwid?: string;
}

function sleep(ms: number): Promise<void> {
  return new Promise((r) => setTimeout(r, ms));
}

export class BrowserTwitterClient implements TwitterHandler {
  private readonly rawCookies: string;
  private ct0: string;
  private readonly headless: boolean;
  private readonly actAsHandle: string | null;
  private readonly actingUserId: string | null;
  private readonly expectedTwid: string | null;
  private context: BrowserContext | null = null;
  private page: Page | null = null;
  private transaction: ClientTransaction | null = null;
  private queryId: string = FALLBACK_QUERY_ID;
  constructor(opts: CookieTwitterBrowserOptions) {
    this.rawCookies = opts.rawCookies;
    this.ct0 = opts.ct0;
    this.headless = opts.headless ?? true;
    this.actAsHandle = opts.actAsHandle?.replace(/^@/, "") ?? null;
    this.actingUserId = opts.actingUserId ?? null;
    this.expectedTwid = opts.expectedTwid ?? null;
  }

  async init(): Promise<void> {
    const cookies = parseCookies(this.rawCookies);
    if (cookies.length === 0) throw new Error("No parsable cookies found in input");
    console.log(`[browser] loaded ${cookies.length} cookies`);

    const browser = await chromium.launch({
      headless: this.headless,
      args: ["--disable-blink-features=AutomationControlled"],
    });
    const context = await browser.newContext({
      userAgent: USER_AGENT,
      locale: "en-US",
      viewport: { width: 1366, height: 900 },
      storageState: {
        cookies: cookies.map((c) => ({
          name: c.name,
          value: c.value,
          domain: ".x.com",
          path: "/",
          expires: Math.floor(Date.now() / 1000) + 60 * 60 * 24 * 365,
          httpOnly: true,
          secure: true,
          sameSite: "Lax" as const,
        })),
        origins: [],
      },
    });
    this.context = context;
    const page = await context.newPage();
    this.page = page;
    await page.goto(HOME_URL, { waitUntil: "domcontentloaded", timeout: 60_000 });
    await sleep(2_000);

    let current: { handle: string; twid: string | null } | null = null;
    for (let attempt = 1; attempt <= 3; attempt++) {
      try {
        current = await this.verify();
        break;
      } catch (error) {
        console.log(`[browser] identity read failed (attempt ${attempt}/3): ${String(error).slice(0, 120)}`);
        if (attempt === 3) throw error;
        await page.goto(HOME_URL, { waitUntil: "domcontentloaded" });
        await sleep(4_000);
      }
    }
    if (!current) throw new Error("Could not establish session identity");
    console.log(`[browser] logged in as @${current.handle} (session twid=${current.twid ?? "unknown"})`);

    // With the x-act-as-user-id header, API posts still work — but UI-driven replies
    // need the browser switched to the delegate account, so run the switch when possible.
    if (this.actAsHandle && current.handle.toLowerCase() !== this.actAsHandle.toLowerCase()) {
      try {
        await this.switchToDelegated(this.actAsHandle);
      } catch (error) {
        console.log(`[browser] UI switch failed (${String(error)}) — API posts still work, UI replies may misfire`);
      }
    }
    if (this.actingUserId) {
      console.log(`[browser] delegate posting enabled: x-act-as-user-id=${this.actingUserId}`);
    }

    const doc = await fetchXDocument();
    this.transaction = await ClientTransaction.create(doc);
    const ids = await this.discoverQueryIds();
    this.queryId = ids.create;
    console.log(`[browser] transaction id generator ready (CreateTweet queryId ${this.queryId.slice(0, 8)}...)`);
  }

  /** Discover CreateTweet/CreateNoteTweet/DeleteTweet queryIds from X's JS bundles. */
  private async discoverQueryIds(): Promise<{ create: string; note: string; del: string }> {
    const page = this.requirePage();
    let del = "ZYKyu6cgfwrpQnCRJsJKrQ";
    let note = "H7QXYuKegEKuUJvkuW5_dg";
    try {
      const html = await page.content();
      const urls = new Set<string>();
      for (const re of [
        /https:\/\/abs\.twimg\.com\/responsive-web\/client-web[^"'\s\\]+?\.js/g,
        /https:\/\/abs\.twimg\.com\/responsive-web\/client-web-legacy[^"'\s\\]+?\.js/g,
      ]) {
        for (const m of html.matchAll(re)) {
          if (m[0]) urls.add(m[0].replace(/\\u002F/g, "/"));
        }
      }
      console.log(`[browser] scanning ${Math.min(urls.size, 4)} JS bundle(s) for operation queryIds...`);
      for (const url of [...urls].slice(0, 4)) {
        const res = await fetch(url, { headers: { "user-agent": USER_AGENT } });
        if (!res.ok) continue;
        const js = await res.text();
        const create = js.match(/queryId:"([A-Za-z0-9_-]+)",operationName:"CreateTweet"/);
        if (create && create[1]) this.queryId = create[1];
        const noteFound = js.match(/queryId:"([A-Za-z0-9_-]+)",operationName:"CreateNoteTweet"/);
        if (noteFound && noteFound[1]) note = noteFound[1];
        const delFound = js.match(/queryId:"([A-Za-z0-9_-]+)",operationName:"DeleteTweet"/);
        if (delFound && delFound[1]) del = delFound[1];
      }
    } catch (error) {
      console.log(`[browser] queryId discovery error: ${String(error)}`);
    }
    return { create: this.queryId, note, del };
  }

  /** Dismiss leftover dialogs/masks that intercept clicks after account switches. */
  private async dismissOverlays(page: Page): Promise<void> {
    await page.keyboard.press("Escape").catch(() => undefined);
    await sleep(500);
    await page.keyboard.press("Escape").catch(() => undefined);
    await sleep(400);
    await page
      .evaluate(() => {
        const layers = document.getElementById("layers");
        if (layers) {
          while (layers.firstChild) layers.removeChild(layers.firstChild);
        }
        for (const el of document.querySelectorAll('[data-testid="mask"]')) {
          (el as HTMLElement).remove();
        }
      })
      .catch(() => undefined);
    await sleep(400);
  }

  /** Reply to a tweet by driving the real UI (correct delegate context guaranteed). */
  private async replyViaUI(text: string, tweetId: string): Promise<string> {
    const page = this.requirePage();
    const expected = this.actAsHandle;
    if (expected) {
      let before = await this.verify();
      if (before.handle.toLowerCase() !== expected.toLowerCase()) {
        console.log(`[browser] UI on @${before.handle} — re-running delegate switch before reply`);
        await this.switchToDelegated(expected);
        before = await this.verify();
        if (before.handle.toLowerCase() !== expected.toLowerCase()) {
          throw new Error(
            `Refusing to reply: UI shows @${before.handle}, expected @${expected} (delegate switch failed)`,
          );
        }
      }
    }
    const statusUrl = `https://x.com/${expected ?? "theforexclue"}/status/${tweetId}`;
    console.log(`[browser] replying via UI at ${statusUrl}`);
    await page.goto(statusUrl, { waitUntil: "domcontentloaded", timeout: 60_000 });
    await sleep(3_000);
    await this.dismissOverlays(page);

    const replyBtn = page.locator('[data-testid="reply"]').first();
    await replyBtn.click({ timeout: 15_000 });
    await sleep(2_500);

    const composer = page.locator('[data-testid="tweetTextarea_0"]:visible').first();
    await composer.click({ timeout: 10_000 });
    await page.keyboard.type(text, { delay: 35 });
    await sleep(1_500);

    let submitted = "";
    for (let attempt = 0; attempt < 8; attempt++) {
      submitted = await page.evaluate(() => {
        const textareas = [...document.querySelectorAll('[data-testid^="tweetTextarea_"]')].filter(
          (t) => (t as HTMLElement).getClientRects().length > 0 && (t.textContent ?? "").trim().length > 0,
        );
        if (textareas.length === 0) return "no-composer";
        for (const ta of textareas) {
          let node: Element | null = ta;
          for (let i = 0; i < 60 && node && node !== document.body; i++) {
            node = node.parentElement;
            if (!node) break;
            const btn = node.querySelector(
              '[data-testid="tweetButton"], [data-testid="tweetButtonInline"], [data-testid="tweetButtonButton"]',
            );
            if (btn instanceof HTMLButtonElement && !btn.disabled && btn.getClientRects().length > 0) {
              btn.click();
              return "clicked";
            }
          }
        }
        for (const btn of document.querySelectorAll('[data-testid="tweetButton"], [data-testid="tweetButtonInline"]')) {
          if (btn instanceof HTMLButtonElement && !btn.disabled && btn.getClientRects().length > 0) {
            btn.click();
            return "clicked-global";
          }
        }
        return "no-button";
      });
      if (submitted.startsWith("clicked")) break;
      await sleep(1_000);
    }
    if (!submitted.startsWith("clicked")) {
      const html = await page.content();
      const { writeFileSync } = await import("node:fs");
      writeFileSync("reply_debug.html", html);
      console.log(`[browser] reply debug HTML saved (${html.length} bytes) — composer state: ${submitted}`);
      throw new Error(`Reply submit failed: composer button state "${submitted}"`);
    }
    await sleep(6_000);

    if (!page.url().includes(statusUrl)) {
      // dialog usually stays; navigate away only for cleanliness
      await page.goto(HOME_URL, { waitUntil: "domcontentloaded" }).catch(() => undefined);
    }
    const postedId = await page.evaluate(() => {
      const link = document.querySelector(`a[href*="/status/"]`);
      return link?.getAttribute("href") ?? null;
    });

    // SAFETY NET: the first status link should be under the delegate handle
    if (postedId && expected) {
      const authorMatch = postedId.match(/^\/([A-Za-z0-9_]+)\//);
      const wrongId = postedId.match(/\/status\/(\d+)/)?.[1];
      const authorHandle = authorMatch?.[1];
      if (authorHandle && wrongId && authorHandle.toLowerCase() !== expected.toLowerCase()) {
        console.log(`[browser] WRONG ACCOUNT on reply (@${authorHandle}) — deleting ${wrongId}`);
        await this.delete(wrongId).catch(() => undefined);
        throw new Error(`Reply posted under @${authorHandle} instead of @${expected} — auto-deleted`);
      }
    }
    // The reply id isn't reliably available from the DOM — return the parent id marker
    return postedId ?? tweetId;
  }
  async delete(tweetId: string): Promise<void> {
    const page = this.requirePage();
    const csrf = await this.refreshCsrf();
    const ids = await this.discoverQueryIds();
    const path = `/i/api/graphql/${ids.del}/DeleteTweet`;
    const txId = this.transaction
      ? await this.transaction.generateTransactionId("POST", path)
      : "0";
    const raw = await page.evaluate(
      async ([bearer, csrfToken, tx, qid, id]) => {
        const res = await fetch(`/i/api/graphql/${qid}/DeleteTweet`, {
          method: "POST",
          credentials: "include",
          headers: {
            authorization: `Bearer ${bearer}`,
            "content-type": "application/json",
            "x-csrf-token": csrfToken,
            "x-client-transaction-id": tx,
            "x-twitter-auth-type": "OAuth2Session",
            "x-twitter-active-user": "yes",
          },
          body: JSON.stringify({
            variables: { tweet_id: id, dark_request: false },
            queryId: qid,
          }),
        });
        return { status: res.status, body: await res.text() };
      },
      [BEARER, csrf, txId, ids.del, tweetId] as const,
    );
    if (raw.status !== 200) {
      throw new Error(`DeleteTweet HTTP ${raw.status}: ${raw.body.slice(0, 200)}`);
    }
    const parsed = JSON.parse(raw.body) as {
      errors?: Array<{ message?: string }>;
      data?: { tweet_result_by_rest_id?: { result?: { typename?: string } } };
    };
    const err = parsed.errors?.[0]?.message;
    if (err) throw new Error(`DeleteTweet rejected: ${err}`);
    console.log(`[browser] deleted tweet ${tweetId}`);
  }

  /** Click the account switcher and switch into a delegated account. */
  private async switchToDelegated(handle: string): Promise<void> {
    const page = this.requirePage();
    console.log(`[browser] switching into @${handle} via delegation...`);

    const bodyText = (): Promise<string> => page.evaluate(() => document.body.innerText);
    for (let attempt = 1; attempt <= 3; attempt++) {
      if (attempt > 1) {
        console.log(`[browser] reloading home (attempt ${attempt})...`);
        await page.goto(HOME_URL, { waitUntil: "domcontentloaded" });
        await sleep(4_000);
      }
      await page.keyboard.press("Escape").catch(() => undefined);
      await sleep(700);
      await page.click('[data-testid="SideNav_AccountSwitcher_Button"]', { timeout: 10_000 });
      const target = page.locator(`text=/@${handle}/i`).first();
      const visible = await target
        .waitFor({ state: "visible", timeout: 8_000 })
        .then(() => true)
        .catch(() => false);
      if (visible) {
        await target.click();
        await sleep(2_000);
        // X shows a confirmation modal for delegate-account switches
        const confirm = page.locator(
          'button:has-text("Switch accounts"), [data-testid="confirmationSheetConfirm"]',
        );
        if (await confirm.first().isVisible().catch(() => false)) {
          console.log("[browser] confirming delegate switch dialog...");
          await confirm.first().click();
        }
        await sleep(3_000);
        // Full reload so the session actually rotates if X supports cookie-based delegation
        await page.goto(HOME_URL, { waitUntil: "domcontentloaded" });
        await sleep(3_000);
        await this.refreshCsrf();
        const verified = await this.verify();
        const now = verified.handle;
        if (now.toLowerCase() !== handle.toLowerCase()) {
          throw new Error(`Switch failed - still @${now}, expected @${handle}`);
        }
        const expected = this.expectedTwid;
        if (expected && verified.twid && verified.twid !== expected) {
          if (this.actingUserId) {
            // Header-based delegate posting: twid staying on the base account is normal
            console.log(`[browser] note: session twid=${verified.twid} (UI switched to @${now}, API posts use x-act-as-user-id)`);
          } else {
            throw new Error(
              `DANGER: UI shows @${now} but session twid=${verified.twid} is NOT the target account (${expected}). Refusing to post.`,
            );
          }
        }
        console.log(`[browser] now acting as @${now} (session twid=${verified.twid ?? "unknown"})`);
        return;
      }
      await page.keyboard.press("Escape").catch(() => undefined);
    }

    const text = (await bodyText()).replace(/\n+/g, " | ");
    throw new Error(
      `Delegated account @${handle} never rendered in switcher (2 attempts). Menu/timeline text: ${text.slice(0, 300)}`,
    );
  }

  /** Re-read the current ct0 from the browser (it rotates on account switch). */
  private async refreshCsrf(): Promise<string> {
    if (!this.context) throw new Error("No browser context");
    const cookies = await this.context.cookies("https://x.com");
    const found = cookies.find((c) => c.name === "ct0");
    if (!found) throw new Error("ct0 cookie missing from live session");
    this.ct0 = found.value;
    return this.ct0;
  }

  /** Read the logged-in screen name + the real session user id (twid cookie). */
  async verify(): Promise<{ handle: string; twid: string | null }> {
    const page = this.requirePage();
    if (page.url().includes("/i/flow/login")) {
      throw new Error("Session is logged out (redirected to login flow)");
    }
    const identity = await page.evaluate(() => {
      const text = document.querySelector('[data-testid="SideNav_AccountSwitcher_Button"]')?.textContent ?? "";
      const match = text.match(/@[A-Za-z0-9_]{1,15}/);
      if (match) return match[0];
      const alt = document.querySelector('[data-testid="AppTabBar_Account_Avatar"]')?.getAttribute("alt");
      return alt ?? null;
    });
    if (!identity) {
      throw new Error("Could not read account identity from page DOM — session may be logged out");
    }
    const twid = await this.readTwid();
    return { handle: identity.replace(/^@/, ""), twid };
  }

  /** The twid cookie is the ground truth of which account the SESSION posts as. */
  private async readTwid(): Promise<string | null> {
    if (!this.context) return null;
    const cookies = await this.context.cookies("https://x.com");
    const twid = cookies.find((c) => c.name === "twid");
    if (!twid) return null;
    const m = decodeURIComponent(twid.value).match(/u%3D(\d+)|u=(\d+)/);
    return m ? (m[1] ?? m[2] ?? null) : null;
  }

  private requirePage(): Page {
    if (!this.page) throw new Error("Client not initialized — call init() first");
    return this.page;
  }

  private async createTweet(text: string, replyToTweetId?: string): Promise<string> {
    const page = this.requirePage();
    await sleep(1_500 + Math.random() * 3_000);

    if (!page.url().startsWith("https://x.com")) {
      await page.goto(HOME_URL, { waitUntil: "domcontentloaded" });
      await sleep(2_000);
    }

    const csrf = await this.refreshCsrf();
    // Delegate (contributor) posting MUST go through CreateNoteTweet on api.x.com —
    // classic CreateTweet rejects contributor access (error code 90).
    const useNotePath = Boolean(this.actingUserId);
    const ids = await this.discoverQueryIds();
    const opPath = useNotePath
      ? `https://api.x.com/graphql/${ids.note}/CreateNoteTweet`
      : `/i/api/graphql/${this.queryId}/CreateTweet`;
    const txId = this.transaction
      ? await this.transaction.generateTransactionId("POST", useNotePath ? `/graphql/${ids.note}/CreateNoteTweet` : `/i/api/graphql/${this.queryId}/CreateTweet`)
      : "0";

    const raw = await page.evaluate(
      async ([bearer, csrfToken, tx, fullPath, tweetText, replyTo, actingId, featuresJson]) => {
        const variables: Record<string, unknown> = {
          tweet_text: tweetText,
          media: { media_entities: [], possibly_sensitive: false },
          semantic_annotation_ids: [],
          disallowed_reply_options: null,
          semantic_annotation_options: { source: "Profile" },
        };
        if (replyTo) {
          variables.reply = {
            in_reply_to_tweet_id: replyTo,
            excluded_reply_user_ids: [],
          };
        }
        const headers: Record<string, string> = {
          authorization: `Bearer ${bearer}`,
          "content-type": "application/json",
          "x-csrf-token": csrfToken,
          "x-client-transaction-id": tx,
          "x-twitter-auth-type": "OAuth2Session",
          "x-twitter-active-user": "yes",
          "x-twitter-client-language": "en",
        };
        if (actingId) {
          headers["x-act-as-user-id"] = actingId;
          headers["x-contributor-version"] = "1";
        }
        const res = await fetch(fullPath, {
          method: "POST",
          credentials: "include",
          headers,
          body: JSON.stringify({
            features: JSON.parse(featuresJson as string),
            variables,
            queryId: fullPath.split("/").pop(),
          }),
        });
        return { status: res.status, body: await res.text() };
      },
      [
        BEARER,
        csrf,
        txId,
        opPath,
        text,
        replyToTweetId ?? "",
        this.actingUserId ?? "",
        JSON.stringify(FULL_FEATURES),
      ] as const,
    );

    if (raw.status !== 200) {
      throw new Error(`CreateTweet HTTP ${raw.status}: ${raw.body.slice(0, 200)}`);
    }
    let parsed: {
      data?: { create_tweet?: TweetResult }; errors?: Array<{ message?: string }>;
    } & { data?: { notetweet_create?: TweetResult } };
    try {
      parsed = JSON.parse(raw.body) as typeof parsed;
    } catch {
      throw new Error(`CreateTweet returned non-JSON: ${raw.body.slice(0, 120)}`);
    }
    const err = parsed.errors?.[0]?.message;
    if (err) throw new Error(`CreateTweet rejected: ${err}`);
    const tweet = parsed.data?.create_tweet?.tweet_results?.result
      ?? parsed.data?.notetweet_create?.tweet_results?.result;
    const id = tweet?.rest_id;
    if (!id) throw new Error("CreateTweet returned no tweet id");

    // SAFETY NET: confirm the post landed on the intended account; auto-delete if not
    const authorId = tweet?.core?.user_results?.result?.rest_id;
    if (this.actingUserId && authorId && authorId !== this.actingUserId) {
      console.log(`[browser] WRONG ACCOUNT (posted as ${authorId}) — auto-deleting ${id}`);
      await this.delete(id);
      throw new Error(`Posted as ${authorId} instead of ${this.actingUserId} — auto-deleted`);
    }
    if (this.actingUserId && !authorId) {
      console.log(`[browser] WARNING: could not confirm author from response — tweet ${id} may be on the wrong account`);
    }
    return id;
  }

  async post(text: string): Promise<string> {
    return this.createTweet(text);
  }

  async reply(text: string, tweetId: string): Promise<string> {
    if (this.actingUserId) {
      // Delegate context: API note-path ignores reply vars — drive the real UI instead
      return this.replyViaUI(text, tweetId);
    }
    return this.createTweet(text, tweetId);
  }

  async close(): Promise<void> {
    await this.context?.close().catch(() => undefined);
    this.context = null;
    this.page = null;
  }
}

export function createBrowserTwitter(env: NodeJS.ProcessEnv): BrowserTwitterClient {
  const rawCookies = env.TWITTER_COOKIE_HEADER?.trim() || env.TWITTER_EXTRA_COOKIES?.trim() || "";
  const ct0 = env.TWITTER_CT0 ?? "";
  if (!rawCookies) {
    throw new Error("Browser transport needs cookies in TWITTER_COOKIE_HEADER");
  }
  if (!ct0) {
    const found = parseCookies(rawCookies).find((c) => c.name === "ct0");
    if (!found) throw new Error("No ct0 cookie found — needed for x-csrf-token");
    return new BrowserTwitterClient({ rawCookies, authToken: "", ct0: found.value });
  }
  return new BrowserTwitterClient({
    rawCookies,
    authToken: env.TWITTER_AUTH_TOKEN ?? "",
    ct0,
    actAsHandle: env.ACT_AS_HANDLE,
    actingUserId: env.ACT_AS_USER_ID,
    expectedTwid: env.EXPECTED_TWID,
  });
}
