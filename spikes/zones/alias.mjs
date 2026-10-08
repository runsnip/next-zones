/* A zone's root URL: the shell's <Link href="/post/7"> reaches the blog zone's /blog/7, softly, and the address bar
   keeps /post/7. */
import { createRequire } from "node:module";

const require = createRequire(import.meta.url);
const { chromium } = require("playwright");
const BASE = "http://127.0.0.1:3900";
await fetch(`${BASE}/_next-zones/images/blog/1/install`, { method: "POST" });
const browser = await chromium.launch();
const page = await browser.newPage();
const errors = [];
page.on("pageerror", (e) => errors.push(e.message));
page.on("response", (r) => { if (r.status() >= 400 && !r.url().includes("/shop")) errors.push(`${r.status()} ${new URL(r.url()).pathname}`); });
await page.goto(`${BASE}/`);
await page.evaluate(() => { window.__marker = "kept"; });
await page.click("#count");
await page.click("#to-alias");
await page.waitForSelector("#title >> text=/zone blog item 7/");
const soft = { url: new URL(page.url()).pathname, soft: await page.evaluate(() => window.__marker === "kept"), counter: await page.textContent("#count") };
await page.goto(`${BASE}/post/8`);
const direct = { url: new URL(page.url()).pathname, title: await page.textContent("#title") };
console.log(JSON.stringify({ soft, direct, errors }, null, 2));
await browser.close();
