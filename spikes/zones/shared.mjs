/*
 * Is a module shared by the shell and the zones loaded once? On the server: how many times the shared module ran.
 * In the browser: across shell → blog → shop, how many times the shared client module ran, and which JS files were
 * fetched more than once or with the same content under two names. Then a v1 → v2 swap: does an open tab run v2's
 * client code (its module id is the same as v1's)?
 */
import { createRequire } from "node:module";
import { createHash } from "node:crypto";

const require = createRequire(import.meta.url);
const { chromium } = require("playwright");
const BASE = "http://127.0.0.1:3900";
const post = (zone, version) => fetch(`${BASE}/_next-zones/images/${zone}/${version}/install`, { method: "POST" }).then((r) => r.json());
const debug = () => fetch(`${BASE}/_next-zones/debug`).then((r) => r.json());

await post("blog", "1");
await post("shop", "1");
for (const u of ["/about", "/blog/42", "/shop"]) await fetch(BASE + u).then((r) => r.text());
const server = await debug();

const browser = await chromium.launch();
const page = await browser.newPage();
const js = [];
page.on("response", async (r) => {
  if (!r.url().endsWith(".js")) return;
  const body = await r.body().catch(() => null);
  js.push({ url: new URL(r.url()).pathname, sha: body ? createHash("sha1").update(body).digest("hex").slice(0, 10) : null, bytes: body?.length ?? 0 });
});
const errors = [];
page.on("pageerror", (e) => errors.push(e.message));
await page.goto(`${BASE}/`);
await page.evaluate(() => { window.__marker = "kept"; });
await page.click("#to-blog"); await page.waitForSelector("#badge-blog");
await page.click("#to-shop"); await page.waitForSelector("#badge-shop");
await page.click("#to-item"); await page.waitForSelector("#title >> text=/item 42/");
const client = await page.evaluate(() => ({ sharedClientEvals: window.__sharedClientEvals, soft: window.__marker === "kept" }));

const byUrl = new Map(), bySha = new Map();
for (const f of js) { byUrl.set(f.url, (byUrl.get(f.url) ?? 0) + 1); if (f.sha) (bySha.get(f.sha) ?? bySha.set(f.sha, new Set()).get(f.sha)).add(f.url); }
const fetchedTwice = [...byUrl].filter(([, n]) => n > 1).map(([u]) => u);
const sameContentTwoNames = [...bySha.values()].filter((s) => s.size > 1).map((s) => [...s]);

/* The swap: v2's editor prints "editor v2"; its client module has the same id as v1's. */
await page.click("#to-blog"); await page.waitForSelector("#editor-version");
const before = await page.textContent("#editor-version");
await post("blog", "2");
await page.click("text=home"); await page.waitForSelector("#title >> text=shell home");
await page.evaluate(() => window.next?.router?.refresh?.()); await page.waitForTimeout(400);
await page.click("#to-blog"); await page.waitForSelector("#title >> text=/zone blog v2/");
const after = { title: await page.textContent("#title"), editor: await page.textContent("#editor-version"), soft: await page.evaluate(() => window.__marker === "kept") };

console.log(JSON.stringify({ server, client, jsFiles: js.length, jsBytes: js.reduce((a, f) => a + f.bytes, 0), fetchedTwice, sameContentTwoNames, swap: { before, after }, errors }, null, 2));
await browser.close();
await post("blog", "1");
