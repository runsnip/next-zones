/*
 * A 404 under a zone's mount is the zone's own, the page Next renders it with when the zone runs alone: shop's
 * app/not-found (App Router) and wiki's pages/404 (a zone with only pages/) answer a URL under their mounts that nothing
 * serves, rendered from the zone's build. docs has an app/ folder (Next would render an App Router not-found for it
 * alone, never a pages/404) and no app/not-found: the shell's answers, as for blog (no root not-found) and for a URL
 * outside every zone, and for docs' page answering notFound. In a browser: shop's not-found loads with no error and its
 * link navigates softly; a navigation to a missing URL under /shop shows it too (Next loads a new document for a URL
 * that answers 404, as for the shell's); wiki's 404 runs in wiki's own document (its _document, its build id). Then
 * shop 2 is installed: its not-found is the new version's.
 */
import fs from "node:fs";
import path from "node:path";
import { createRequire } from "node:module";

const require = createRequire(import.meta.url);
const { chromium } = require("playwright");
const BASE = "http://127.0.0.1:3900";
const install = (zone, v) => fetch(`${BASE}/_next-zones/images/${zone}/${v}/install`, { method: "POST" }).then((r) => r.status);
const installed = [await install("blog", "1"), await install("shop", "1"), await install("docs", "1"), await install("wiki", "1")];
const which = async (p, init) => {
  const r = await fetch(BASE + p, init);
  const t = await r.text();
  const says = t.includes("shop not found") ? "shop" : t.includes("wiki not found") ? "wiki" : t.includes("docs not found") ? "docs" : /could not be found|404/.test(t) ? "shell" : "other";
  return `${r.status} ${says}`;
};
const http = {
  "/shop/nothing": await which("/shop/nothing"),
  "/shop/a/b/c": await which("/shop/a/b/c"),
  "/shop/nothing (RSC)": await which("/shop/nothing", { headers: { rsc: "1" } }),
  "/docs/a/b/c": await which("/docs/a/b/c"),
  "/docs/missing": await which("/docs/missing"),
  "/wiki/nothing": await which("/wiki/nothing"),
  "/blog/nothing/at/all": await which("/blog/nothing/at/all"),
  "/nothing": await which("/nothing"),
};
const expected = {
  "/shop/nothing": "404 shop", "/shop/a/b/c": "404 shop", "/shop/nothing (RSC)": "404 shop",
  "/docs/a/b/c": "404 shell", "/docs/missing": "404 shell", "/wiki/nothing": "404 wiki",
  "/blog/nothing/at/all": "404 shell", "/nothing": "404 shell",
};

const browser = await chromium.launch();
const page = await browser.newPage();
const errors = [];
page.on("pageerror", (e) => errors.push(e.message));
page.on("response", (r) => { const p = new URL(r.url()).pathname; if (r.status() >= 400 && !/nothing|missing|gone/.test(p)) errors.push(`${r.status()} ${p}`); });
const title = () => page.textContent("#title").then((t) => t.trim());

await page.goto(`${BASE}/shop/nothing`);
const shopNotFound = { title: await title() };
await page.evaluate(() => { window.__marker = "kept"; });
await page.click("#nf-to-live");
await page.waitForSelector("#title >> text=/zone shop live/");
shopNotFound.thenLink = { title: await title(), soft: await page.evaluate(() => window.__marker === "kept") };
await page.evaluate(() => window.next.router.push("/shop/gone"));
await page.waitForSelector("#title >> text=/shop not found/");
shopNotFound.softToMissing = { title: await title() };

const wikiBuildId = fs.readFileSync(path.join(".zones-store", "wiki", "1", "BUILD_ID"), "utf8").trim();
await page.goto(`${BASE}/wiki/nothing`);
const wikiNotFound = { title: await title(), zone: await page.getAttribute("html", "data-zone"), buildId: await page.evaluate(() => window.__NEXT_DATA__?.buildId) };
await page.click("#to-wiki");
await page.waitForSelector("#title >> text=wiki home");
wikiNotFound.thenLink = await title();

/* shop 2: the not-found answering under /shop is the new version's. */
const v2 = await install("shop", "2");
const afterSwap = await fetch(`${BASE}/shop/nothing`).then(async (r) => `${r.status} ${/shop not found (<!-- -->)?v2/.test(await r.text()) ? "v2" : "v1"}`);

const wrong = {};
if (installed.some((s) => s !== 200)) wrong.installs = installed;
for (const [p, want] of Object.entries(expected)) if (http[p] !== want) wrong[p] = http[p];
if (!shopNotFound.title.startsWith("shop not found") || !shopNotFound.thenLink.soft || !shopNotFound.softToMissing.title.startsWith("shop not found")) wrong.shopNotFound = shopNotFound;
if (wikiNotFound.title !== "wiki not found" || wikiNotFound.zone !== "wiki" || wikiNotFound.buildId !== wikiBuildId || wikiNotFound.thenLink !== "wiki home") wrong.wikiNotFound = wikiNotFound;
if (v2 !== 200 || afterSwap !== "404 v2") wrong.afterSwap = { v2, afterSwap };
console.log(JSON.stringify({ http, shopNotFound, wikiNotFound, afterSwap, errors, wrong }, null, 2));
await browser.close();
process.exit(0);
