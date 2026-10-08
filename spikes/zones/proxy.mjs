/*
 * The shell's proxy on soft navigations into a zone: signed out, a <Link> to the zone's private page lands on the
 * shell's /login; signed in, it reaches the page, which sees the proxy's header. The document should stay the same.
 */
import { createRequire } from "node:module";

const require = createRequire(import.meta.url);
const { chromium } = require("playwright");
/* The shell's nav links every zone: install them all, so prefetches answer 200. */
for (const [name, version] of [["blog", 1], ["shop", 1]]) await fetch(`http://127.0.0.1:3900/_next-zones/images/${name}/${version}/install`, { method: "POST" });
const BASE = "http://127.0.0.1:3900";

const browser = await chromium.launch();
const context = await browser.newContext();
const page = await context.newPage();
const errors = [];
page.on("pageerror", (e) => errors.push(e.message));
page.on("console", (m) => { if (m.type() === "error") errors.push(m.text()); });
const notFound = [];
page.on("response", (r) => { if (r.status() >= 400) notFound.push(`${r.status()} ${new URL(r.url()).pathname}${new URL(r.url()).search}`); });

await page.goto(`${BASE}/`);
await page.evaluate(() => { window.__marker = "kept"; });
await page.click("#count");
await page.click("#to-private");
await page.waitForSelector("#title >> text=shell login");
const signedOut = { url: new URL(page.url()).pathname + new URL(page.url()).search, soft: await page.evaluate(() => window.__marker === "kept") };

/* Signing in: the session cookie, then router.refresh(), as a real sign-in does to drop the router's cached redirect. */
await context.addCookies([{ name: "session", value: "1", url: BASE }]);
await page.evaluate(() => window.next.router.refresh());
await page.waitForTimeout(300);
await page.click("text=home"); await page.waitForSelector("#title >> text=shell home");
await page.click("#to-private");
await page.waitForSelector("#title >> text=/zone blog private|shell login/");
const signedIn = {
  url: new URL(page.url()).pathname,
  title: await page.textContent("#title"),
  proxyHeader: await page.$eval("#proxy", (e) => e.textContent).catch(() => null),
  soft: await page.evaluate(() => window.__marker === "kept"),
  counter: await page.textContent("#count"),
};
console.log(JSON.stringify({ signedOut, signedIn, errors, notFound }, null, 2));
await browser.close();
