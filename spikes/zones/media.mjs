/*
 * A zone's assets under Zones: its next/font (font file and applied family), an imported image and a public/ image
 * through next/image, and the public/ image as a plain <img>, on a direct load and on a soft navigation.
 */
import { createRequire } from "node:module";

const require = createRequire(import.meta.url);
const { chromium } = require("playwright");
const BASE = "http://127.0.0.1:3900";
await fetch(`${BASE}/_next-zones/images/blog/1/install`, { method: "POST" });

const browser = await chromium.launch();
const page = await browser.newPage();
const failed = [];
page.on("response", (r) => { if (r.status() >= 400) failed.push(`${r.status()} ${new URL(r.url()).pathname}${new URL(r.url()).search.slice(0, 60)}`); });
page.on("pageerror", (e) => failed.push(e.message));
const fontFiles = [];
page.on("response", (r) => { if (/\.woff2$/.test(new URL(r.url()).pathname)) fontFiles.push(`${r.status()} ${new URL(r.url()).pathname}`); });

const inspect = () => page.evaluate(async () => {
  const img = (id) => { const el = document.getElementById(id); return el ? el.complete && el.naturalWidth : null; };
  await document.fonts.ready;
  const family = getComputedStyle(document.getElementById("title")).fontFamily;
  return { family, fontLoaded: [...document.fonts].some((f) => f.status === "loaded"), staticImg: img("static-img"), publicImg: img("public-img"), rawPublic: img("raw-public") };
});
const settle = () => page.waitForFunction(() => [...document.images].every((i) => i.complete), null, { timeout: 10000 }).catch(() => {});

await page.goto(`${BASE}/blog/media`); await settle();
const direct = await inspect();
await page.goto(`${BASE}/`);
await page.evaluate(() => { window.__marker = "kept"; });
await page.click("#to-media"); await page.waitForSelector("#static-img"); await settle();
const soft = { ...(await inspect()), soft: await page.evaluate(() => window.__marker === "kept") };
console.log(JSON.stringify({ direct, soft, fontFiles, failed }, null, 2));
await browser.close();
