/* A zone's inline server action that closes over a value: its bound argument is encrypted at render and decrypted
   when the action runs, so both must use the same key although the shell and the zone were built separately. */
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
await page.click("#to-item");
await page.waitForSelector("#remember");
await page.click("#remember");
await page.waitForSelector("#last >> text=/remembered/", { timeout: 10000 }).catch(() => {});
console.log(JSON.stringify({ last: await page.textContent("#last"), errors }, null, 2));
await browser.close();
