/*
 * Mode "single" with Next's output: "export": a workspace of static zones (the shell, blog and shop, each with pages
 * linking to the others, a dynamic segment with generateStaticParams, an alias and a public file) built by
 * next-zones build into one static site, served by a plain static file server: every page is there, and links
 * between zones navigate softly in the browser (no document load, client state kept).
 * With NEXT_ZONES_MODE=zones (zonesexport.mjs), mode "zones": every zone's own Next config says output: "export",
 * next-zones build exports each zone as an image and links them into one static site (.zones-export): the same checks.
 */
import fs from "node:fs";
import path from "node:path";
import http from "node:http";
import { createRequire } from "node:module";
import { execFileSync } from "node:child_process";

const require = createRequire(import.meta.url);
const { chromium } = require("playwright");
const cli = path.resolve("../../src/cli.mjs");
const MODE = process.env.NEXT_ZONES_MODE ?? "single";
const dir = path.resolve(MODE === "zones" ? ".zones-export-check" : ".single-export");
const wrong = {}, seen = {};
const write = (file, text) => { fs.mkdirSync(path.dirname(path.join(dir, file)), { recursive: true }); fs.writeFileSync(path.join(dir, file), text); };
const nav = `import Link from "next/link";\nexport function Nav() { return <nav><Link href="/" id="to-home">home</Link> <Link href="/blog" id="to-blog">blog</Link> <Link href="/blog/2" id="to-post">post 2</Link> <Link href="/shop" id="to-shop">shop</Link></nav>; }\n`;
const layout = `import { Nav } from "./nav";\nimport { Counter } from "./counter";\nexport default function Root({ children }: { children: React.ReactNode }) { return <html lang="en"><body><Nav /><Counter /><main>{children}</main></body></html>; }\n`;
const counter = `"use client";\nimport { useState } from "react";\nexport function Counter() { const [n, setN] = useState(0); return <button id="count" onClick={() => setN(n + 1)}>clicked {n}</button>; }\n`;

fs.rmSync(dir, { recursive: true, force: true });
for (const zone of ["shell", "blog", "shop"]) {
  write(`${zone}/package.json`, JSON.stringify({ name: `export-${zone}`, version: "1.0.0", private: true }));
  write(`${zone}/tsconfig.json`, fs.readFileSync("shell/tsconfig.json", "utf8"));
  write(`${zone}/app/nav.tsx`, nav);
  write(`${zone}/app/counter.tsx`, counter);
  write(`${zone}/app/layout.tsx`, layout);
}
write("shell/next.config.mjs", `import { zoneConfig } from "@runsnip/next-zones/config";\nexport default zoneConfig({ mount: "/", mode: ${JSON.stringify(MODE)} }, { output: "export" });\n`);
/* Each zone is exported on its own: its own Next config says so (next-zones never sets it). */
const zoneOutput = `, { output: "export" }`;
write("shell/app/page.tsx", `export default function Home() { return <h1 id="title">shell home</h1>; }\n`);
/* Blog's build id is a git SHA (a generateBuildId), not the shell's 21-character nanoid (payload.cjs). */
const BLOG_BUILD_ID = "4f1c2a9e8b7d6c5f4e3d2c1b0a9f8e7d6c5b4a39";
write("blog/next.config.mjs", `import { zoneConfig } from "@runsnip/next-zones/config";\nexport default zoneConfig({ mount: "/blog", aliases: [{ source: "/post/:id", destination: "/blog/:id" }] }, { output: "export", generateBuildId: async () => "${BLOG_BUILD_ID}" });\n`);
write("blog/app/blog/page.tsx", `export default function Blog() { return <h1 id="title">zone blog</h1>; }\n`);
write("blog/app/blog/[id]/page.tsx", `export function generateStaticParams() { return [{ id: "1" }, { id: "2" }]; }\nexport default async function Post({ params }: { params: Promise<{ id: string }> }) { const { id } = await params; return <h1 id="title">blog post {id}</h1>; }\n`);
write("blog/public/blog/logo.txt", "blog logo\n");
write("shop/next.config.mjs", `import { zoneConfig } from "@runsnip/next-zones/config";\nexport default zoneConfig({ mount: "/shop" }${zoneOutput});\n`);
write("shop/app/shop/page.tsx", `export default function Shop() { return <h1 id="title">zone shop</h1>; }\n`);
for (const zone of ["shell", "blog", "shop"]) fs.symlinkSync(path.resolve("node_modules"), path.join(dir, zone, "node_modules"), "dir");

/* A plain static file server: a path, then path.html, then path/index.html, as static hosts do. */
function serve(root, port) {
  const types = { ".html": "text/html", ".js": "application/javascript", ".css": "text/css", ".txt": "text/plain", ".json": "application/json" };
  const server = http.createServer((req, res) => {
    const p = decodeURIComponent(new URL(req.url, "http://x").pathname);
    const candidates = [p, `${p}.html`, path.join(p, "index.html")].map((c) => path.join(root, c));
    const file = candidates.find((c) => c.startsWith(root) && fs.existsSync(c) && fs.statSync(c).isFile());
    if (!file) { res.writeHead(404).end("not found"); return; }
    res.writeHead(200, { "content-type": types[path.extname(file)] ?? "application/octet-stream" });
    fs.createReadStream(file).pipe(res);
  });
  return new Promise((r) => server.listen(port, "127.0.0.1", () => r(server)));
}

let server = null;
try {
  let out = "";
  try { out = execFileSync(process.execPath, [cli, "build"], { cwd: dir, encoding: "utf8", stdio: ["ignore", "pipe", "pipe"] }); }
  catch (e) { wrong.build = `${e.stdout ?? ""}${e.stderr ?? ""}`.slice(-3000); throw new Error("build failed"); }
  seen.report = out.split("\n").filter((l) => /^✓ (one app|zones linked)/.test(l));
  const site = path.join(dir, ".zones-export");
  if (!fs.existsSync(site)) throw new Error(`no static site at ${site}`);
  const blogIds = fs.readdirSync(path.join(dir, ".zones-store", "blog")).map((v) => fs.readFileSync(path.join(dir, ".zones-store", "blog", v, "BUILD_ID"), "utf8").trim());
  if (blogIds.length !== 1 || blogIds[0] !== BLOG_BUILD_ID) wrong.blogBuildIdBuilt = blogIds;
  /* Blog's pages and payloads carry the shell's build id once linked, never blog's own. */
  const carrying = fs.readdirSync(site, { recursive: true }).filter((f) => /\.(html|txt)$/.test(f) && fs.readFileSync(path.join(site, f), "utf8").includes(BLOG_BUILD_ID));
  if (carrying.length) wrong.blogBuildId = carrying;
  const start = (() => { try { execFileSync(process.execPath, [cli, "start", "--port", "3910"], { cwd: dir, encoding: "utf8", stdio: ["ignore", "pipe", "pipe"], timeout: 30_000 }); return "started"; } catch (e) { return `${e.stdout ?? ""}${e.stderr ?? ""}`; } })();
  if (!/static site \(output: "export"\)/.test(start)) wrong.start = start.slice(-500);
  if (fs.existsSync(path.join(dir, ".zones-build"))) wrong.composed = "a build composed the sources instead of linking images";
  server = await serve(site, 3910);
  const BASE = "http://127.0.0.1:3910";
  const statuses = {};
  for (const p of ["/", "/blog", "/blog/1", "/blog/2", "/shop", "/blog/logo.txt"]) statuses[p] = (await fetch(BASE + p)).status;
  seen.statuses = statuses;
  if (Object.values(statuses).some((s) => s !== 200)) wrong.statuses = statuses;

  const browser = await chromium.launch();
  const page = await browser.newPage();
  const errors = [];
  page.on("pageerror", (e) => errors.push(e.message));
  page.on("console", (m) => m.type() === "error" && errors.push(m.text().slice(0, 200)));
  await page.goto(`${BASE}/`);
  await page.click("#count");
  await page.evaluate(() => { window.__marker = "kept"; });
  const steps = {};
  for (const [id, title] of [["to-blog", "zone blog"], ["to-post", "blog post 2"], ["to-shop", "zone shop"], ["to-home", "shell home"]]) {
    await page.click(`#${id}`);
    await page.waitForFunction((t) => document.querySelector("#title")?.textContent === t, title, { timeout: 15_000 }).catch(() => {});
    steps[id] = { title: await page.textContent("#title"), soft: await page.evaluate(() => window.__marker === "kept"), counter: await page.textContent("#count") };
    if (steps[id].title !== title || !steps[id].soft || steps[id].counter !== "clicked 1") wrong[id] = steps[id];
  }
  seen.navigation = steps;
  /* Loaded directly on a zone's page (its document, from its own build), then on to another zone and home. */
  await page.goto(`${BASE}/blog/1`);
  await page.click("#count");
  await page.evaluate(() => { window.__marker = "kept"; });
  const fromZone = {};
  for (const [id, title] of [["to-shop", "zone shop"], ["to-home", "shell home"], ["to-post", "blog post 2"]]) {
    await page.click(`#${id}`);
    await page.waitForFunction((t) => document.querySelector("#title")?.textContent === t, title, { timeout: 15_000 }).catch(() => {});
    fromZone[id] = { title: await page.textContent("#title"), soft: await page.evaluate(() => window.__marker === "kept"), counter: await page.textContent("#count") };
    if (fromZone[id].title !== title || !fromZone[id].soft || fromZone[id].counter !== "clicked 1") wrong[`fromZone ${id}`] = fromZone[id];
  }
  seen.fromZone = fromZone;
  if (errors.length) wrong.errors = errors;
  await browser.close();
} catch (error) {
  wrong.error ??= String(error.message ?? error);
} finally {
  server?.close();
  if (!process.env.KEEP) fs.rmSync(dir, { recursive: true, force: true });
}
console.log(JSON.stringify({ ...seen, wrong }, null, 2));
process.exit(Object.keys(wrong).length ? 1 : 0);
