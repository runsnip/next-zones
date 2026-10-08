/*
 * The swap signal: an open tab that has already visited a zone's prerendered page (cached by the client router) sees
 * the new version on its next soft navigation after a swap, without any refresh of its own, in the same document.
 */
import { createRequire } from "node:module";

const require = createRequire(import.meta.url);
const { chromium } = require("playwright");
const BASE = "http://127.0.0.1:3900";
const install = (v) => fetch(`${BASE}/_next-zones/images/blog/${v}/install`, { method: "POST" });
await install(1);
await fetch(`${BASE}/_next-zones/images/shop/1/install`, { method: "POST" });

const browser = await chromium.launch();
const page = await browser.newPage();
const errors = [];
page.on("pageerror", (e) => errors.push(e.message));
await page.goto(`${BASE}/`);
await page.evaluate(() => { window.__marker = "kept"; });
await page.click("#count");
await page.click("#to-blog"); await page.waitForSelector("#title >> text=/zone blog v1/");
await page.click("text=home"); await page.waitForSelector("#title >> text=shell home");

await install(2);
await page.waitForTimeout(500);                            // the event reaches the tab; no refresh of our own
await page.click("#to-blog"); await page.waitForSelector("#title >> text=/zone blog v\\d/");
const after = { title: await page.textContent("#title"), editor: await page.textContent("#editor-version"), soft: await page.evaluate(() => window.__marker === "kept"), counter: await page.textContent("#count") };
await install(1);
console.log(JSON.stringify({ after, errors }, null, 2));
await browser.close();
