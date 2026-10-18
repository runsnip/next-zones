/*
 * A dynamic import inside a chunk Zones writes again. The zone "wide" has longer module ids than the shell, so its
 * modules shared with the shell (React's runtime, the context library) are aliased to the shell's ids, and every chunk
 * holding them is written again under a new name (zone-client.cjs). Its page has a button whose import() loads a
 * card: the loader of that import lives in a chunk written again, and the card's chunk is written again too. The
 * loader must name the card's chunk by its new name: the old file still requires React under the zone's own id, which
 * nothing registers ("module factory is not available"). Checked after a soft navigation from the shell and on a
 * direct load: the card renders and reads the shell's context, no page error, and no chunk is fetched under its old
 * name once it has a new one.
 */
import { createRequire } from "node:module";

const require = createRequire(import.meta.url);
const { chromium } = require("playwright");
const BASE = "http://127.0.0.1:3900";

const installed = await fetch(`${BASE}/_next-zones/images/wide/1/install`, { method: "POST" });
const browser = await chromium.launch();
const page = await browser.newPage();
const errors = [], chunks = [];
page.on("pageerror", (e) => errors.push(e.message));
page.on("console", (m) => { if (m.type() === "error" && /module|chunk/i.test(m.text())) errors.push(m.text()); });
page.on("request", (r) => { const m = /\/_next\/static\/chunks\/([^/?]+\.js)/.exec(r.url()); if (m) chunks.push(m[1]); });

/* Clicked until the card shows (a click before hydration has no handler yet), for 20 s at most. */
async function loadCard() {
  for (const end = Date.now() + 20000; Date.now() < end;) {
    await page.click("#load-lazy");
    if (await page.waitForSelector("#lazy", { timeout: 1000 }).catch(() => null)) return page.textContent("#lazy");
  }
  return null;
}
await page.goto(`${BASE}/`);
await page.click("#to-wide");
await page.waitForSelector("#load-lazy", { timeout: 15000 });
const soft = await loadCard();
await page.goto(`${BASE}/wide`);
await page.waitForSelector("#load-lazy", { timeout: 15000 });
const direct = await loadCard();
await browser.close();

/* A chunk written again is <name>-z<content key>.js: its old name must never be fetched. */
const RENAMED = /-z([0-9a-f]{8})\.js$/;
const rewritten = new Set(chunks.filter((c) => RENAMED.test(c)));
/* Every chunk written again, by its old name (Zones' debug info): none may be fetched under that name. */
const renamedFrom = new Set(Object.keys((await (await fetch(`${BASE}/_next-zones/debug`)).json()).chunkUrls?.wide ?? {}).map((u) => u.split("/").pop()));
const oldNames = [...new Set(chunks.filter((c) => renamedFrom.has(c)))];
const wrong = {};
if (!renamedFrom.size) wrong.chunkMap = "Zones' debug info lists no chunk of wide written again: the check does not test what it says";
if (!installed.ok) wrong.install = installed.status;
if (!rewritten.size) wrong.rewritten = "no chunk of the zone was written again: the check does not test what it says";
if (soft !== "lazy card, context root") wrong.soft = soft;
if (direct !== "lazy card, context root") wrong.direct = direct;
if (oldNames.length) wrong.oldNames = oldNames;
if (errors.length) wrong.errors = errors;
console.log(JSON.stringify({ soft, direct, rewrittenFetched: rewritten.size, oldNames, wrong }, null, 2));
if (Object.keys(wrong).length) process.exit(1);
