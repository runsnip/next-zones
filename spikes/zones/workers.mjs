/*
 * A Web Worker of a zone whose chunks Zones writes again. The zone "wide" has longer module ids than the shell, so its
 * modules shared with the shell (React among them) are aliased to the shell's ids, and every chunk holding them is
 * written again under a new name (zone-client.cjs) — the worker's chunks too. The worker's runtime chunk waits for its
 * chunks by name and then runs its entry: it must wait for the new names, and the module that starts the worker must
 * name the runtime chunk written again. Else the entry never runs and the worker never answers. Checked after a soft
 * navigation from the shell and on a direct load: the worker answers, no page error, and no chunk is fetched under
 * its old name once it has a new one (the worker's own requests included).
 */
import { createRequire } from "node:module";

const require = createRequire(import.meta.url);
const { chromium } = require("playwright");
const BASE = "http://127.0.0.1:3900";

const installed = await fetch(`${BASE}/_next-zones/images/wide/1/install`, { method: "POST" });
const browser = await chromium.launch();
const context = await browser.newContext();
const page = await context.newPage();
const errors = [], chunks = [];
page.on("pageerror", (e) => errors.push(e.message));
page.on("console", (m) => { if (m.type() === "error" && !/^Failed to load resource/.test(m.text())) errors.push(m.text()); });
/* A chunk that failed to load, by its URL (the console says only its status; the nav's prefetches of zones not
   installed here fail as they should). */
context.on("response", (r) => { if (r.status() >= 400 && new URL(r.url()).pathname.startsWith("/_next/")) errors.push(`${r.status()} ${new URL(r.url()).pathname}`); });
/* Every request of the context, a worker's included. */
context.on("request", (r) => { const m = /\/_next\/static\/chunks\/([^/?]+\.js)/.exec(r.url()); if (m) chunks.push(m[1]); });

/* Clicked until the worker answers (a click before hydration has no handler yet), for 20 s at most. */
async function askWorker() {
  for (const end = Date.now() + 20000; Date.now() < end;) {
    await page.click("#start-worker");
    if (await page.waitForFunction(() => document.querySelector("#worker-reply")?.textContent, null, { timeout: 2000 }).catch(() => null)) return page.textContent("#worker-reply");
  }
  return null;
}
await page.goto(`${BASE}/`);
await page.click("#to-wide");
await page.waitForSelector("#start-worker", { timeout: 15000 });
const soft = await askWorker();
await page.goto(`${BASE}/wide`);
await page.waitForSelector("#start-worker", { timeout: 15000 });
const direct = await askWorker();
await browser.close();

const RENAMED = /-z([0-9a-f]{8})\.js$/;
const rewritten = new Set(chunks.filter((c) => RENAMED.test(c)));
const keys = new Set([...rewritten].map((c) => RENAMED.exec(c)[1]));
const oldNames = [];
for (const c of new Set(chunks.filter((c) => !RENAMED.test(c)))) {
  for (const key of keys) {
    const r = await fetch(`${BASE}/_next/static/chunks/${c.replace(/\.js$/, `-z${key}.js`)}`);
    if (r.ok) oldNames.push(c);
  }
}
const workerRuntime = [...rewritten].filter((c) => c.startsWith("turbopack-"));
const wrong = {};
if (!installed.ok) wrong.install = installed.status;
if (!workerRuntime.length) wrong.workerRuntime = "no runtime chunk was written again: the check does not test what it says";
if (soft !== "echo ping, react string") wrong.soft = soft;
if (direct !== "echo ping, react string") wrong.direct = direct;
if (oldNames.length) wrong.oldNames = oldNames;
if (errors.length) wrong.errors = errors;
console.log(JSON.stringify({ soft, direct, rewritten: [...rewritten], wrong }, null, 2));
if (Object.keys(wrong).length) process.exit(1);
