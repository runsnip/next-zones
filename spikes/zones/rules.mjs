/*
 * A zone's own routing rules under Zones: headers, a permanent redirect, rewrites before files (one conditioned on
 * a query), after files and fallback, all from its next.config; and intercepting routes (the modal on a soft
 * navigation, the full page on a direct load).
 */
import { createRequire } from "node:module";

const require = createRequire(import.meta.url);
const { chromium } = require("playwright");
const BASE = "http://127.0.0.1:3900";
await fetch(`${BASE}/_next-zones/images/blog/1/install`, { method: "POST" });
await fetch(`${BASE}/_next-zones/images/shop/1/install`, { method: "POST" });
const title = (html) => /id="title"[^>]*>(.*?)<\/h1>/.exec(html)?.[1]?.replaceAll("<!-- -->", "") ?? null;
const get = async (p) => { const r = await fetch(BASE + p, { redirect: "manual" }); return { r, html: await r.text() }; };

const header = (await get("/blog/api/x")).r.headers.get("x-zone-header");
const redirect = await get("/blog/old/5");
const results = {
  header,
  redirect: { status: redirect.r.status, location: redirect.r.headers.get("location") },
  beforeFiles: title((await get("/blog/b4/6")).html),
  conditionMet: title((await get("/blog/cond?to=shop")).html) ?? /zone shop/.exec((await get("/blog/cond?to=shop")).html)?.[0],
  conditionNotMet: (await get("/blog/cond")).r.status,
  afterFiles: title((await get("/blog/af/7")).html),
  fallback: title((await get("/blog/fb/x/y")).html),
};

const browser = await chromium.launch();
const page = await browser.newPage();
await page.goto(`${BASE}/blog/gallery`);
await page.click("#open-photo");
await page.waitForSelector("#modal");
const intercepted = { url: new URL(page.url()).pathname, modal: await page.textContent("#modal"), galleryStill: await page.textContent("#title") };
await page.goto(`${BASE}/blog/photo/1`);
const directPhoto = { title: await page.textContent("#title"), modal: await page.$("#modal") !== null };
await browser.close();
console.log(JSON.stringify({ ...results, intercepted, directPhoto }, null, 2));
