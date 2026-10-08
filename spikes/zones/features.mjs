/*
 * The zone's features beyond a static page, in a real browser: a dynamic route reached by a soft navigation, the
 * zone's CSS (a CSS module) on a soft navigation and on a direct load, a server action of the zone, and a client module
 * of the zone with a top-level await (the runtime's async-module support, which the shell's runtime has through
 * @runsnip/next-zones/client).
 */
import { createRequire } from "node:module";

const require = createRequire(import.meta.url);
const { chromium } = require("playwright");
/* The shell's nav links every zone: install them all, so prefetches answer 200. */
const installed = {};
for (const [name, version] of [["blog", 1], ["shop", 1]]) {
  const r = await fetch(`http://127.0.0.1:3900/_next-zones/images/${name}/${version}/install`, { method: "POST" });
  if (!r.ok) installed[name] = await r.text();
}
if (Object.keys(installed).length) { console.log(JSON.stringify({ wrong: { install: installed } }, null, 2)); process.exit(1); }
const BASE = "http://127.0.0.1:3900";

const browser = await chromium.launch();
const page = await browser.newPage();
const errors = [];
page.on("pageerror", (e) => errors.push(e.message));
page.on("console", (m) => { if (m.type() === "error") errors.push(m.text()); });
const border = () => page.evaluate(() => { const b = document.querySelector("#box"); return b ? getComputedStyle(b).borderTopColor : null; });

await page.goto(`${BASE}/`);
await page.evaluate(() => { window.__marker = "kept"; });

await page.click("#to-item");
await page.waitForSelector("#title >> text=/zone blog item 42/");
const dynamicSoft = await page.evaluate(() => window.__marker === "kept");

await page.click("#to-blog");
await page.waitForSelector("#box");
const cssSoft = await border();
const awaited = await page.textContent("#awaited").catch(() => null);

await page.fill("#editor", "hello");
await page.click("#shout");
await page.waitForSelector("#answer >> text=/HELLO/", { timeout: 10000 }).catch(() => {});
const action = await page.textContent("#answer");
const stillSoft = await page.evaluate(() => window.__marker === "kept");

await page.goto(`${BASE}/blog`);
await page.waitForSelector("#box");
const cssDirect = await border();

const wrong = {};
if (!dynamicSoft) wrong.dynamicSoft = "the dynamic route was a document load";
if (awaited !== "awaited in the zone") wrong.awaited = awaited;
if (!/HELLO/.test(action ?? "")) wrong.action = action;
if (!stillSoft) wrong.stillSoft = "a document load";
if (!cssSoft || cssSoft !== cssDirect) wrong.css = { cssSoft, cssDirect };
console.log(JSON.stringify({ dynamicSoft, cssSoft, cssDirect, awaited, action, stillSoft, errors, wrong }, null, 2));
await browser.close();
