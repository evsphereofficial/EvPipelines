import { config } from "dotenv";
import { chromium } from "playwright";
import { parseCookies } from "./src/platforms/twitter-browser.js";

config();

const raw = process.env.TWITTER_COOKIE_HEADER?.trim() ?? "";
if (!raw) throw new Error("TWITTER_COOKIE_HEADER missing");

const cookies = parseCookies(raw).map((c) => ({
  name: c.name,
  value: c.value,
  domain: ".x.com",
  path: "/",
  expires: Math.floor(Date.now() / 1000) + 60 * 60 * 24,
  httpOnly: true,
  secure: true,
  sameSite: "Lax" as const,
}));

const browser = await chromium.launch({ headless: true, args: ["--disable-blink-features=AutomationControlled"] });
const context = await browser.newContext({
  userAgent: "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/140.0.0.0 Safari/537.36",
  locale: "en-US",
  storageState: { cookies, origins: [] },
});
const page = await context.newPage();
await page.goto("https://x.com/theforexclue/status/2111299507426386383", { waitUntil: "domcontentloaded", timeout: 60000 });
await page.waitForTimeout(6000);

const data = await page.evaluate(() => {
  const articles = [...document.querySelectorAll('article[data-testid="tweet"]')].slice(0, 12).map((a) => {
    const user = a.querySelector('[data-testid="User-Name"]')?.textContent ?? "";
    const text = a.querySelector('[data-testid="tweetText"]')?.textContent ?? "";
    const links = [...a.querySelectorAll('a[href*="/status/"]')].map((l) => l.getAttribute("href")).filter(Boolean);
    return { user, text: text.slice(0, 140), firstLink: links[0] ?? "" };
  });
  return { url: location.href, count: articles.length, articles };
});

console.log(JSON.stringify(data, null, 2));
await browser.close();
