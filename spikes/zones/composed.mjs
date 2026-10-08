/*
 * next-zones dev: the shell and the test zones composed into one app on `next dev`. Checks soft navigation between
 * them (the shell's client state survives), the alias, HMR in a zone and in a shared package (the page updates with no
 * reload), and how long an edit takes to show.
 */
import { createRequire } from "node:module";
import { spawn } from "node:child_process";
import fs from "node:fs";
import path from "node:path";

const require = createRequire(import.meta.url);
const { chromium } = require("playwright");
const BASE = "http://127.0.0.1:3903";

/* A zones dir of links: the shell and the fixtures live in different folders here. */
const zones = ".zones-compose";
fs.rmSync(zones, { recursive: true, force: true });
fs.mkdirSync(zones);
for (const [name, target] of [["shell", "../shell"], ["blog", "../fixtures/blog"], ["shop", "../fixtures/shop"]]) fs.symlinkSync(target, path.join(zones, name));

const dev = spawn(process.execPath, [path.resolve("../../src/cli.mjs"), "dev", zones, "--port", "3903"], { stdio: ["ignore", "pipe", "pipe"] });
let log = "";
dev.stdout.on("data", (d) => { log += d; });
dev.stderr.on("data", (d) => { log += d; });
const edits = [];
const edit = (file, from, to) => { const original = fs.readFileSync(file, "utf8"); edits.push([file, original]); fs.writeFileSync(file, original.replace(from, to)); };
const result = {};
const wrong = {}, errors = [];
try {
  for (let i = 0; i < 120 && !/Ready/.test(log); i++) await new Promise((r) => setTimeout(r, 250));
  const browser = await chromium.launch();
  const page = await browser.newPage();
  page.on("pageerror", (e) => errors.push(e.message));
  await page.goto(`${BASE}/`);
  await page.click("#count");
  const counted = await page.textContent("#count");
  await page.click("#to-blog");
  await page.waitForSelector("text=zone blog v");
  result.blog = await page.textContent("#title");
  await page.click("#blog-to-shop");
  await page.waitForSelector("text=zone shop");
  await page.click("#to-alias");
  await page.waitForURL("**/post/7");
  result.alias = await page.textContent("#title");
  result.counterKept = (await page.textContent("#count")) === counted;

  await page.click("#to-blog");
  await page.waitForSelector("text=zone blog v");
  await page.evaluate(() => { window.__marker = "kept"; });
  let t0 = Date.now();
  edit("fixtures/blog/app/blog/page.tsx", "to the shop zone", "to the shop zone (hmr)");
  await page.waitForSelector("text=to the shop zone (hmr)", { timeout: 30000 });
  result.zoneHmrMs = Date.now() - t0;
  t0 = Date.now();
  edit("shared/badge.js", "`badge ${", "`badge* ${");
  await page.waitForSelector("text=badge* blog", { timeout: 30000 });
  result.sharedHmrMs = Date.now() - t0;
  result.noReload = (await page.evaluate(() => window.__marker)) === "kept";
  await browser.close();
} finally {
  for (const [file, original] of edits.reverse()) fs.writeFileSync(file, original);
  const exited = new Promise((r) => dev.once("exit", r));
  dev.kill();
  await exited;
  fs.rmSync(zones, { recursive: true, force: true, maxRetries: 5 });
}
if (!/zone blog v/.test(result.blog ?? "")) wrong.blog = result.blog;
if (!/zone blog item/.test(result.alias ?? "")) wrong.alias = result.alias;
if (!result.counterKept) wrong.counterKept = false;
if (!result.noReload) wrong.noReload = false;
console.log(JSON.stringify({ ...result, wrong, errors }, null, 2));
