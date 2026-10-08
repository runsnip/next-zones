/*
 * Routing features inside a zone, by direct request and by soft navigation from the shell: catch-all and optional
 * catch-all, a route group, parallel routes, loading (streaming), an error boundary, the zone's not-found, redirect()
 * into another zone, and the router hooks (with router.push into another zone).
 */
import { createRequire } from "node:module";

const require = createRequire(import.meta.url);
const { chromium } = require("playwright");
const BASE = "http://127.0.0.1:3900";
await fetch(`${BASE}/_next-zones/images/blog/1/install`, { method: "POST" });
await fetch(`${BASE}/_next-zones/images/shop/1/install`, { method: "POST" });

const title = (html) => /id="title"[^>]*>([^<]*(?:<!-- -->[^<]*)*)</.exec(html)?.[1]?.replaceAll("<!-- -->", "") ?? null;
const direct = {};
for (const p of ["/blog/docs/a/b", "/blog/wiki", "/blog/wiki/x/y", "/blog/grouped", "/blog/dash", "/blog/missing", "/blog/go", "/blog/broken"]) {
  const res = await fetch(BASE + p, { redirect: "manual" });
  const html = await res.text();
  direct[p] = { status: res.status, title: title(html), location: res.headers.get("location"), stats: /id="stats"><p>([^<]+)/.exec(html)?.[1], boundary: html.includes("zone blog error boundary") || undefined };
}

const browser = await chromium.launch();
const page = await browser.newPage();
const errors = [];
page.on("pageerror", (e) => errors.push(e.message));
const home = async () => { await page.goto(`${BASE}/`); await page.evaluate(() => { window.__marker = "kept"; }); };
const soft = () => page.evaluate(() => window.__marker === "kept");
const nav = {};

await home(); await page.click("#to-slow");
const sawLoading = await page.waitForSelector("#loading", { timeout: 3000 }).then(() => true).catch(() => false);
await page.waitForSelector("#title >> text=zone blog slow done");
nav.slow = { sawLoading, soft: await soft() };

await home(); await page.click("#to-broken"); await page.waitForSelector("#error-boundary");
nav.broken = { boundary: true, soft: await soft() };

await home(); await page.click("#to-missing"); await page.waitForSelector("#title >> text=zone blog not found");
nav.missing = { notFound: true, soft: await soft() };

await home(); await page.click("#to-go"); await page.waitForSelector("#title >> text=zone shop");
nav.go = { url: new URL(page.url()).pathname, soft: await soft() };

await home(); await page.click("#to-docs"); await page.waitForSelector("#title >> text=zone blog docs a/b");
nav.docs = { soft: await soft() };

await home(); await page.click("#to-hooks"); await page.waitForSelector("#hooks");
const hooks = JSON.parse(await page.textContent("#hooks"));
await page.click("#push-shop"); await page.waitForSelector("#title >> text=zone shop");
nav.hooks = { hooks, pushedTo: new URL(page.url()).pathname, soft: await soft() };

console.log(JSON.stringify({ direct, nav, errors: errors.filter((e) => !e.includes("broken on purpose")) }, null, 2));
await browser.close();
