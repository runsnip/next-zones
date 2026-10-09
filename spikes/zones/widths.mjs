/*
 * Module ids of two widths: Turbopack cuts a build's ids to as many digits as its module count needs, so the zone
 * "wide" (4000 generated client modules) has longer ids than the shell for the same shared modules (the context
 * library, React's client). Zones must still share them: a soft navigation from the shell reads the shell's context
 * ("root"), and so does a direct load; on the server, the shared module is evaluated once. The check first confirms the widths differ, so it tests what it says.
 */
import fs from "node:fs";
import path from "node:path";
import vm from "node:vm";
import { createRequire } from "node:module";

const require = createRequire(import.meta.url);
const { chromium } = require("playwright");
const BASE = "http://127.0.0.1:3900";

/* The widest module id in a build's client chunks. */
function widest(dir) {
  let max = 0;
  for (const f of fs.readdirSync(path.join(dir, "static", "chunks")).filter((f) => f.endsWith(".js"))) {
    const pushed = [], sandbox = { TURBOPACK: { push: (items) => pushed.push(items) } };
    sandbox.globalThis = sandbox.self = sandbox;
    try { vm.runInNewContext(fs.readFileSync(path.join(dir, "static", "chunks", f), "utf8"), sandbox, { timeout: 5000 }); } catch {}
    const visit = (items) => { for (const it of items) { if (Array.isArray(it)) visit(it); else if (typeof it === "number") max = Math.max(max, String(it).length); } };
    for (const items of pushed) if (Array.isArray(items)) visit(items.slice(1));
  }
  return max;
}
const store = process.env.NEXT_ZONES_STORE ?? ".zones-store";
const widths = { shell: widest(path.join("shell", ".next")), zone: widest(path.join(store, "wide", "1")) };

await fetch(`${BASE}/_next-zones/images/wide/1/install`, { method: "POST" });
const browser = await chromium.launch();
const page = await browser.newPage();
const errors = [];
page.on("pageerror", (e) => errors.push(e.message));
await page.goto(`${BASE}/`);
await page.click("#to-wide");
await page.waitForSelector("#context-label", { timeout: 15000 });
const soft = await page.textContent("#context-label");
await page.goto(`${BASE}/wide`);
const direct = await page.textContent("#context-label");
const many = await page.textContent("#many");
const stamp = await page.textContent("#stamp");
await browser.close();
const wrong = {};
if (!(widths.zone > widths.shell)) wrong.widths = `the zone's ids are not longer than the shell's (${JSON.stringify(widths)}): the check does not test what it says`;
if (soft !== "context root") wrong.soft = soft;
if (direct !== "context root") wrong.direct = direct;
if (!/^4000 modules/.test(many ?? "")) wrong.many = many;
/* On the server too: the shared server module, required under the zone's longer id, is the shell's instance. */
if (stamp !== "shared server module evaluation 1") wrong.stamp = stamp;
if (errors.length) wrong.errors = errors;
console.log(JSON.stringify({ widths, soft, direct, stamp, wrong }, null, 2));
if (Object.keys(wrong).length) process.exit(1);
