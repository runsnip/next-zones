/*
 * Two builds with different versions of one shared client component (@spike/shared/badge): the shell's and shop v1
 * render "badge <label>", shop v2 renders "badge v2 <label>". Same module path, so the same module id. After a soft
 * navigation from the shell into shop v2, the browser must run shop v2's component, and the shell's own must stay
 * the shell's. The badge counts its evaluations (state of its own), so installing shop v2 reports it: the shop gets a
 * copy of its own, which is right here, and a warning, which would tell of two copies of a context.
 */
import { createRequire } from "node:module";

const require = createRequire(import.meta.url);
const { chromium } = require("playwright");
const BASE = "http://127.0.0.1:3900";
const warnings = {};
for (const [name, version] of [["blog", 1], ["shop", 2]]) {
  const r = await (await fetch(`${BASE}/_next-zones/images/${name}/${version}/install`, { method: "POST" })).json();
  if (!r.name) { console.log(JSON.stringify(r)); process.exit(1); }
  warnings[name] = r.warnings ?? [];
}
const browser = await chromium.launch();
const page = await browser.newPage();
const errors = [];
page.on("pageerror", (e) => errors.push(e.message));
await page.goto(`${BASE}/`);
await page.evaluate(() => { window.__marker = "kept"; });
const shellBadge = await page.textContent("#badge-shell");
await page.click("#to-shop");
await page.waitForSelector("#badge-shop");
const soft = { badge: await page.textContent("#badge-shop"), soft: await page.evaluate(() => window.__marker === "kept") };
await page.click("text=home"); await page.waitForSelector("#badge-shell");
const shellAgain = await page.textContent("#badge-shell");
await page.goto(`${BASE}/shop`);
const direct = await page.textContent("#badge-shop");
const warned = { blog: warnings.blog.length, shop: warnings.shop.some((w) => w.includes("__sharedClientEvals")) };
const wrong = soft.badge !== "badge v2 shop" || direct !== "badge v2 shop" || shellAgain !== "badge shell" || warned.blog !== 0 || !warned.shop ? "yes" : {};
console.log(JSON.stringify({ shellBadge, soft, shellAgain, direct, warned, warnings: warnings.shop, wrong, errors }, null, 2));
await browser.close();
