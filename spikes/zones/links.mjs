/*
 * <Link> from inside one zone's page to another zone, both ways, with each zone's own client state checked: blog
 * (editor text) → shop (a list) → blog. A soft navigation keeps the document and the shell's counter.
 */
import { createRequire } from "node:module";

const require = createRequire(import.meta.url);
const { chromium } = require("playwright");
const BASE = "http://127.0.0.1:3900";
await fetch(`${BASE}/_next-zones/images/blog/1/install`, { method: "POST" });
await fetch(`${BASE}/_next-zones/images/shop/1/install`, { method: "POST" });

const browser = await chromium.launch();
const page = await browser.newPage();
const errors = [];
page.on("pageerror", (e) => errors.push(e.message));
page.on("response", (r) => { if (r.status() >= 400) errors.push(`${r.status()} ${new URL(r.url()).pathname}`); });

await page.goto(`${BASE}/blog`);
await page.evaluate(() => { window.__marker = "kept"; });
await page.click("#count");
await page.fill("#editor", "draft");
await page.click("#blog-to-shop");
await page.waitForSelector("#title >> text=zone shop");
await page.click("#add"); await page.click("#add");
const inShop = { items: await page.$$eval("#items li", (l) => l.length), soft: await page.evaluate(() => window.__marker === "kept") };
await page.click("#shop-to-blog");
await page.waitForSelector("#title >> text=/zone blog item 42/");
const backInBlog = { soft: await page.evaluate(() => window.__marker === "kept"), counter: await page.textContent("#count") };
await page.goBack();
await page.waitForSelector("#title >> text=zone shop");
const afterBack = { soft: await page.evaluate(() => window.__marker === "kept"), url: new URL(page.url()).pathname };
console.log(JSON.stringify({ inShop, backInBlog, afterBack, errors }, null, 2));
await browser.close();
