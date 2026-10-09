/*
 * A zone on the Pages Router (fixtures/docs) under Zones: its own document, _app and build id; static, getStaticProps
 * (prerendered, and a blocking fallback), getServerSideProps; soft navigations inside the zone with its _app's state
 * kept, each page's data fetched under the zone's build id; a route handler of the same zone (app/docs/api); a link to
 * an App Router zone, which Next makes a hard
 * navigation; then docs 2 installed live: the open tab's next navigation reaches version 2, and a rollback, 1 again.
 */
import fs from "node:fs";
import path from "node:path";
import { createRequire } from "node:module";

const require = createRequire(import.meta.url);
const { chromium } = require("playwright");
const BASE = "http://127.0.0.1:3900";
const install = (zone, v) => fetch(`${BASE}/_next-zones/images/${zone}/${v}/install`, { method: "POST" }).then((r) => r.status);
const buildId = (v) => fs.readFileSync(path.join(".zones-store", "docs", v, "BUILD_ID"), "utf8").trim();
/* shop too: blog's page links (and prefetches) it. */
const installed = [await install("blog", "1"), await install("shop", "1"), await install("docs", "1")];
const api = await fetch(`${BASE}/docs/api`).then(async (r) => ({ status: r.status, body: await r.json().catch(() => null) }));
/* notFound from getStaticProps: a 404, with the shell's not-found page. */
const missing = (await fetch(`${BASE}/docs/missing`)).status;

const browser = await chromium.launch();
const page = await browser.newPage();
const errors = [], data = [];
page.on("pageerror", (e) => errors.push(e.message));
page.on("response", (r) => {
  const p = new URL(r.url()).pathname;
  if (p.startsWith("/_next/data/")) data.push(`${r.status()} ${p}`);
  else if (r.status() >= 400) errors.push(`${r.status()} ${p}`);
});
const title = () => page.textContent("#title").then((t) => t.trim());
const soft = () => page.evaluate(() => window.__marker === "kept");
const go = async (link, text) => { await page.click(link); await page.waitForSelector(`#title >> text=${text}`); return { title: await title(), soft: await soft(), count: (await page.textContent("#inc")).trim() }; };

await page.goto(`${BASE}/docs`);
const first = {
  title: await title(),
  zone: await page.getAttribute("html", "data-zone"),
  buildId: await page.evaluate(() => window.__NEXT_DATA__.buildId),
};
await page.evaluate(() => { window.__marker = "kept"; });
await page.click("#inc");
const steps = {
  prerendered: await go("#to-a", "doc a 1"),
  fallback: await go("#to-b", "doc b 1"),
  ssr: await go("#to-ssr", "ssr 1"),
  plain: await go("#to-plain", "plain 1"),
};
await page.goBack();
await page.waitForSelector("#title >> text=ssr 1");
steps.back = { title: await title(), soft: await soft() };
const docsData = [...data];
/* To an App Router zone: Next navigates from the Pages Router to the App Router with a new document. */
await page.click("#to-blog");
await page.waitForSelector("#title >> text=/zone blog/");
const toBlog = { title: await title(), newDocument: !(await soft()) };

/* docs 2, installed while a docs page is open: its next navigation reaches version 2; a rollback, version 1. */
await page.goto(`${BASE}/docs/a`);
await page.evaluate(() => { window.__marker = "kept"; });
const v2 = await install("docs", "2");
await page.waitForFunction(() => window.next?.router?.__nextZonesStale === true);
await page.click("#to-index");
await page.waitForSelector("#title >> text=index 2");
const afterV2 = { title: await title(), buildId: await page.evaluate(() => window.__NEXT_DATA__.buildId) };
const v1 = await install("docs", "1");
await page.goto(`${BASE}/docs/ssr`);
const afterV1 = { title: await title(), buildId: await page.evaluate(() => window.__NEXT_DATA__.buildId) };

const wrong = {};
if (installed.some((s) => s !== 200) || v2 !== 200 || v1 !== 200) wrong.installs = { installed, v2, v1 };
if (first.title !== "index 1" || first.zone !== "docs" || first.buildId !== buildId("1")) wrong.first = first;
for (const [name, s] of Object.entries(steps)) if (!s.soft || (s.count && s.count !== "count 1")) wrong[name] = s;
const expected = ["docs/a", "docs/b", "docs/ssr"].map((p) => `200 /_next/data/${buildId("1")}/${p}.json`);
for (const e of expected) if (!docsData.includes(e)) wrong.data = docsData;
if (docsData.some((d) => !d.startsWith("200 "))) wrong.data = docsData;
if (!toBlog.newDocument) wrong.toBlog = toBlog;
if (missing !== 404) wrong.missing = missing;
if (api.status !== 200 || api.body?.zone !== "docs" || api.body?.version !== "1") wrong.api = api;
if (afterV2.title !== "index 2" || afterV2.buildId !== buildId("2")) wrong.afterV2 = afterV2;
if (afterV1.title !== "ssr 1" || afterV1.buildId !== buildId("1")) wrong.afterV1 = afterV1;
console.log(JSON.stringify({ api, first, steps, docsData, toBlog, afterV2, afterV1, errors, wrong }, null, 2));
await browser.close();
process.exit(0);
