/*
 * A context from a shared package across builds: the shell's root layout provides it, a zone's client component reads
 * it. The shell's build uses only the Provider, the zone's also the hook; with unused exports dropped per build the
 * two copies of the module differed and the zone read the default ("none"). On a soft navigation and a direct load,
 * the zone must read "root".
 */
import { createRequire } from "node:module";

const require = createRequire(import.meta.url);
const { chromium } = require("playwright");
const BASE = "http://127.0.0.1:3900";
await fetch(`${BASE}/_next-zones/images/blog/1/install`, { method: "POST" });

const browser = await chromium.launch();
const page = await browser.newPage();
const errors = [];
page.on("pageerror", (e) => errors.push(e.message));
await page.goto(`${BASE}/`);
await page.click("#to-ctx");
await page.waitForSelector("#context-label");
const soft = await page.textContent("#context-label");
await page.goto(`${BASE}/blog/ctx`);
const direct = await page.textContent("#context-label");
await browser.close();
const wrong = {};
if (soft !== "context root") wrong.soft = soft;
if (direct !== "context root") wrong.direct = direct;
console.log(JSON.stringify({ soft, direct, wrong, errors }, null, 2));
