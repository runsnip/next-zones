/*
 * In a real browser: from the shell's home, click the <Link> to /blog (a zone installed at run time).
 * Measured: did the page reload (a hard navigation), did the shell's client state survive, how many Reacts.
 */
import { createRequire } from "node:module";

const require = createRequire(import.meta.url);
const { chromium } = require("playwright");
/* The shell's nav links every zone: install them all, so prefetches answer 200. */
for (const [name, version] of [["blog", 1], ["shop", 1]]) await fetch(`http://127.0.0.1:3900/_next-zones/images/${name}/${version}/install`, { method: "POST" });

const browser = await chromium.launch();
const page = await browser.newPage();
const errors = [];
page.on("pageerror", (e) => errors.push(e.message));
page.on("console", (m) => { if (m.type() === "error") errors.push(m.text()); });

await page.goto("http://127.0.0.1:3900/");
await page.evaluate(() => { window.__marker = "kept"; });          // gone if the document reloads
await page.click("#count");
await page.click("#count");
const before = await page.textContent("#count");

await page.click("#to-blog");
await page.waitForSelector("text=zone blog", { timeout: 15000 });
await page.fill("#editor", "typed in the zone");

const result = await page.evaluate(() => ({
  soft: window.__marker === "kept",
  counter: document.querySelector("#count")?.textContent ?? null,
  title: document.querySelector("#title")?.textContent,
  react: document.querySelector("#react")?.textContent,
  editor: document.querySelector("#editor")?.value,
}));
console.log(JSON.stringify({ counterBefore: before, ...result, errors }, null, 2));
await browser.close();
