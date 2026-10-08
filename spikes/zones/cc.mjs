/*
 * Cache Components in a zone (a shell and a zone both with cacheComponents): the 'use cache' value stays across
 * requests while the dynamic hole (a cookie) follows each request (PPR), revalidateTag renews the cached value, and
 * a soft navigation from the shell renders both.
 *
 *   PORT=3901 NEXT_ZONES_SHELL=fixtures-cc/shell NEXT_ZONES_STORE=.zones-store-cc node zones.cjs   then   node cc.mjs
 */
import { createRequire } from "node:module";

const require = createRequire(import.meta.url);
const { chromium } = require("playwright");
const BASE = `http://127.0.0.1:${process.env.PORT ?? 3901}`;
await fetch(`${BASE}/_next-zones/images/notes/1/install`, { method: "POST" });
const read = async (who) => {
  const r = await fetch(`${BASE}/notes`, { headers: { cookie: `who=${who}` } });
  const html = await r.text();
  return { status: r.status, cache: r.headers.get("x-nextjs-cache"), cached: /id="cached">([^<]+)</.exec(html)?.[1], visitor: /id="visitor">([^<]+)</.exec(html)?.[1] };
};
const alice = await read("alice"), bob = await read("bob");
await fetch(`${BASE}/notes/api/revalidate`, { method: "POST" });
let renewed = null;
for (let i = 0; i < 10 && !renewed; i++) { const r = await read("carol"); if (r.cached && r.cached !== alice.cached) renewed = { ...r, reads: i + 1 }; else await new Promise((res) => setTimeout(res, 100)); }

const browser = await chromium.launch();
const page = await browser.newPage();
const errors = [];
page.on("pageerror", (e) => errors.push(e.message));
page.on("response", (r) => { if (r.status() >= 400) errors.push(`${r.status()} ${new URL(r.url()).pathname}`); });
await page.context().addCookies([{ name: "who", value: "dave", url: BASE }]);
await page.goto(`${BASE}/`);
await page.evaluate(() => { window.__marker = "kept"; });
await page.click("#count");
await page.click("#to-notes");
await page.waitForSelector("#visitor");
const soft = { title: await page.textContent("#title"), visitor: await page.textContent("#visitor"), cached: !!(await page.textContent("#cached")), soft: await page.evaluate(() => window.__marker === "kept"), counter: await page.textContent("#count") };
await browser.close();
console.log(JSON.stringify({ alice, bob, sameCachedValue: alice.cached === bob.cached, renewed, soft, errors }, null, 2));
