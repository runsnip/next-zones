/*
 * next-zones dev with zones on the Pages Router: the shell, blog (App Router), docs and wiki (Pages Router, each with
 * its own _app and _document) composed into one `next dev`. Each page renders with its own zone's _app and _document;
 * soft navigations inside docs keep its _app's state; getStaticProps, a blocking fallback and getServerSideProps
 * answer; an edit to a docs page shows with no reload (HMR through the composed page).
 */
import { createRequire } from "node:module";
import { spawn } from "node:child_process";
import fs from "node:fs";
import path from "node:path";

const require = createRequire(import.meta.url);
const { chromium } = require("playwright");
const BASE = "http://127.0.0.1:3905";

const zones = ".zones-compose-pages";
fs.rmSync(zones, { recursive: true, force: true });
fs.mkdirSync(zones);
for (const [name, target] of [["shell", "../shell"], ["blog", "../fixtures/blog"], ["docs", "../fixtures/docs"], ["wiki", "../fixtures/wiki"]]) fs.symlinkSync(target, path.join(zones, name));

const dev = spawn(process.execPath, [path.resolve("../../src/cli.mjs"), "dev", zones, "--port", "3905"], { stdio: ["ignore", "pipe", "pipe"] });
let log = "";
dev.stdout.on("data", (d) => { log += d; });
dev.stderr.on("data", (d) => { log += d; });
const edits = [];
const edit = (file, from, to) => { const original = fs.readFileSync(file, "utf8"); edits.push([file, original]); fs.writeFileSync(file, original.replace(from, to)); };
const result = {};
const wrong = {}, errors = [];
try {
  for (let i = 0; i < 160 && !/Ready/.test(log); i++) await new Promise((r) => setTimeout(r, 250));
  const browser = await chromium.launch();
  const page = await browser.newPage();
  page.on("pageerror", (e) => errors.push(e.message));
  const title = () => page.textContent("#title").then((t) => t.trim());
  const marker = () => page.evaluate(() => window.__marker === "kept");

  await page.goto(`${BASE}/docs`);
  result.docs = { title: await title(), zone: await page.getAttribute("html", "data-zone"), ownApp: Boolean(await page.waitForSelector("#inc", { timeout: 10000 }).catch(() => null)) };
  await page.evaluate(() => { window.__marker = "kept"; });
  await page.click("#inc");
  await page.click("#to-a");
  await page.waitForSelector("#title >> text=doc a");
  await page.click("#to-b");
  await page.waitForSelector("#title >> text=doc b");
  await page.click("#to-ssr");
  await page.waitForSelector("#title >> text=ssr");
  result.inDocs = { title: await title(), soft: await marker(), count: (await page.textContent("#inc")).trim() };

  await page.click("#to-plain");
  await page.waitForSelector("#title >> text=plain");
  let t0 = Date.now();
  edit("fixtures/docs/pages/docs/plain.tsx", "plain {process.env", "plain (hmr) {process.env");
  await page.waitForSelector("text=plain (hmr)", { timeout: 30000 });
  result.hmr = { ms: Date.now() - t0, noReload: await marker() };

  await page.goto(`${BASE}/wiki`);
  result.wiki = { title: await title(), zone: await page.getAttribute("html", "data-zone"), ownApp: await page.textContent("#app"), docsApp: await page.isVisible("#inc") };
  /* A 404 under wiki's mount is wiki's own pages/404, with its own _app; docs has an app/ folder and no app/not-found,
     so the shell's. */
  const wikiMissing = await page.goto(`${BASE}/wiki/nothing`);
  result.wikiNotFound = { status: wikiMissing?.status(), title: await title(), zone: await page.getAttribute("html", "data-zone"), ownApp: await page.textContent("#app") };
  const docsMissing = await fetch(`${BASE}/docs/a/b/c`);
  result.docsNotFound = `${docsMissing.status} ${/could not be found/.test(await docsMissing.text()) ? "shell" : "other"}`;
  await page.goto(`${BASE}/blog`);
  result.blog = await title();
  await browser.close();
} finally {
  for (const [file, original] of edits.reverse()) fs.writeFileSync(file, original);
  const exited = new Promise((r) => dev.once("exit", r));
  dev.kill();
  await exited;
  fs.rmSync(zones, { recursive: true, force: true, maxRetries: 5 });
}
if (result.docs?.title !== "index 1" || result.docs?.zone !== "docs" || !result.docs?.ownApp) wrong.docs = result.docs;
if (!/^ssr 1/.test(result.inDocs?.title ?? "") || !result.inDocs?.soft || result.inDocs?.count !== "count 1") wrong.inDocs = result.inDocs;
if (!result.hmr?.noReload) wrong.hmr = result.hmr;
if (result.wiki?.title !== "wiki home" || result.wiki?.zone !== "wiki" || result.wiki?.ownApp !== "wiki app" || result.wiki?.docsApp) wrong.wiki = result.wiki;
if (!/zone blog v/.test(result.blog ?? "")) wrong.blog = result.blog;
if (result.wikiNotFound?.status !== 404 || result.wikiNotFound?.title !== "wiki not found" || result.wikiNotFound?.zone !== "wiki" || result.wikiNotFound?.ownApp !== "wiki app") wrong.wikiNotFound = result.wikiNotFound;
if (result.docsNotFound !== "404 shell") wrong.docsNotFound = result.docsNotFound;
console.log(JSON.stringify({ ...result, wrong, errors }, null, 2));
process.exit(0);
