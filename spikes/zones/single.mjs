/*
 * The owner's case 1: a workspace written as zones, built as one Next app. This spike's shell, blog and shop are copied
 * into .single (inside this workspace, so inside Turbopack's root), the shell declaring mode "single":
 * - `next-zones build` builds the shell and each zone's image, as for Zones, and links them into one Next app
 *   (link-app.mjs): one zone format for both modes; no zones.json;
 * - `next-zones start` runs `next start` on it: every zone's pages, route handlers, aliases, headers, redirects,
 *   rewrites and public files answer from one process, and Zones' endpoints do not exist; instrumentation runs as on
 *   Zones (the shell's for every route unless the policy skips a zone, each zone's own for its routes);
 * - building one zone again at the same version is refused: images are immutable.
 * With NEXT_OUTPUT=standalone (singlestandalone.mjs), the shell's Next config says output: "standalone": the same
 * checks, served by the standalone server.js next-zones start runs, from a folder holding nothing else.
 */
import fs from "node:fs";
import path from "node:path";
import { spawn, execFileSync } from "node:child_process";

const cli = path.resolve("../../src/cli.mjs");
const next = path.resolve("node_modules/next/dist/bin/next");
/* Next's own output for the one app, in the shell's Next config: none, or "standalone". */
const OUTPUT = process.env.NEXT_OUTPUT ?? null;
const dir = path.resolve(OUTPUT ? `.single-${OUTPUT}` : ".single");
const PORT = 3908, BASE = `http://127.0.0.1:${PORT}`;
const wrong = {}, seen = {};
const run = (args) => {
  try { return { code: 0, out: execFileSync(process.execPath, [cli, ...args], { cwd: dir, encoding: "utf8", stdio: ["ignore", "pipe", "pipe"] }) }; }
  catch (e) { return { code: e.status ?? 1, out: `${e.stdout ?? ""}${e.stderr ?? ""}` }; }
};
const size = (d) => { let n = 0; for (const e of fs.readdirSync(d, { withFileTypes: true, recursive: true })) if (e.isFile()) n += fs.statSync(path.join(e.parentPath, e.name)).size; return n; };
/* A build's output without Next's build cache: what is deployed. */
const outputMB = (dotNext) => +((size(dotNext) - (fs.existsSync(path.join(dotNext, "cache")) ? size(path.join(dotNext, "cache")) : 0)) / 1048576).toFixed(1);

fs.rmSync(dir, { recursive: true, force: true });
for (const [zone, from] of [["shell", "shell"], ["blog", "fixtures/blog"], ["shop", "fixtures/shop"]]) {
  fs.cpSync(from, path.join(dir, zone), { recursive: true, filter: (src) => !/[\\/](\.next|node_modules|next-env\.d\.ts|tsconfig\.tsbuildinfo)$/.test(src) });
  if (fs.existsSync(path.join(from, "node_modules"))) fs.symlinkSync(path.resolve(from, "node_modules"), path.join(dir, zone, "node_modules"), "dir");
  const file = path.join(dir, zone, "package.json");
  fs.writeFileSync(file, JSON.stringify({ ...JSON.parse(fs.readFileSync(file, "utf8")), name: `single-${zone}`, version: "1.0.0" }, null, 2));
}
/* Blog's build id is a git SHA (a generateBuildId), not the shell's 21-character nanoid: its payloads carry the shell's
   id once linked, with the rows' lengths written again (payload.cjs). */
const BLOG_BUILD_ID = "4f1c2a9e8b7d6c5f4e3d2c1b0a9f8e7d6c5b4a39";
const blogConfig = path.join(dir, "blog", "next.config.mjs");
fs.writeFileSync(blogConfig, fs.readFileSync(blogConfig, "utf8").replace("env: { ZONE_VERSION: version },", `env: { ZONE_VERSION: version },\n    generateBuildId: async () => "${BLOG_BUILD_ID}",`));
fs.writeFileSync(path.join(dir, "shell", "next.config.mjs"), `import { zoneConfig } from "@runsnip/next-zones/config";\nexport default zoneConfig({ mount: "/", mode: "single" }${OUTPUT ? `, { output: ${JSON.stringify(OUTPUT)} }` : ""});\n`);
/* What the shell's and blog's instrumentation recorded, read back; and a policy: the shell's skipped for shop. */
fs.mkdirSync(path.join(dir, "shell", "app", "trace"), { recursive: true });
fs.writeFileSync(path.join(dir, "shell", "app", "trace", "route.ts"), `export const dynamic = "force-dynamic";\nexport function GET() { return Response.json((globalThis as { __instrumentationLog?: unknown[] }).__instrumentationLog ?? []); }\n`);
fs.writeFileSync(path.join(dir, "zones.config.json"), JSON.stringify({ instrumentation: { shell: { skip: ["shop"] } } }));

let server = null;
try {
  let t = performance.now();
  const built = run(["build"]);
  seen.build = { s: +((performance.now() - t) / 1000).toFixed(1), lines: built.out.split("\n").filter((l) => l.startsWith("✓ one app") || l.startsWith("✗")) };
  if (built.code !== 0) wrong.build = built.out.slice(-2000);
  if (OUTPUT === "standalone" && !/standalone \(output "standalone"\)/.test(built.out)) wrong.standaloneReport = built.out.slice(-800);
  /* One zone format: the one app is linked from the zone images (link-app.mjs), no zone rebuilt from its sources. */
  if (!fs.existsSync(path.join(dir, ".zones-store", "blog", "1.0.0", "zone.json"))) wrong.images = "mode single did not build zone images";
  if (fs.existsSync(path.join(dir, "zones.json"))) wrong.pins = "mode single wrote pins";
  const blogId = fs.readFileSync(path.join(dir, ".zones-store", "blog", "1.0.0", "BUILD_ID"), "utf8").trim();
  if (blogId !== BLOG_BUILD_ID) wrong.blogBuildId = blogId;
  const alone = run(["build", "blog"]);
  if (alone.code === 0 || !/already built/.test(alone.out)) wrong.buildOneZone = alone.out.slice(-500);

  server = spawn(process.execPath, [cli, "start", "--port", String(PORT), "--host", "127.0.0.1"], { cwd: dir, stdio: ["ignore", "pipe", "pipe"] });
  let log = "";
  server.stdout.on("data", (d) => { log += d; });
  server.stderr.on("data", (d) => { log += d; });
  for (let i = 0; i < 120 && !/Ready/.test(log); i++) await new Promise((r) => setTimeout(r, 250));
  const get = async (p) => {
    const r = await fetch(BASE + p, { redirect: "manual", signal: AbortSignal.timeout(30_000) });
    return { status: r.status, body: await r.text(), headers: r.headers };
  };
  /* Blog's prerendered page and its payload: the shell's build id, never blog's own. */
  for (const [p, headers] of [["/blog", {}], ["/blog", { RSC: "1" }]]) {
    const body = await (await fetch(BASE + p, { headers, signal: AbortSignal.timeout(30_000) })).text();
    if (body.includes(BLOG_BUILD_ID)) wrong[`blogBuildId ${headers.RSC ? "rsc" : "html"}`] = "blog's own build id was served";
  }
  const expect = {
    "/": 200, "/about": 200, "/blog": 200, "/blog/42": 200, "/shop": 200,
    "/post/3": 200,                  // blog's alias
    "/blog/b4/7": 200,               // blog's beforeFiles rewrite
    "/blog/old/5": 308,              // blog's redirect
    "/blog/logo.png": 200,           // blog's public file
    "/_next-zones/health": 404,      // no Zones
  };
  const statuses = {};
  for (const [p, want] of Object.entries(expect)) {
    const r = await get(p);
    statuses[p] = r.status;
    if (r.status !== want) wrong[p] = { got: r.status, want };
  }
  seen.statuses = statuses;
  /* A 404 under a zone's mount is the zone's own, as on Zones: shop's app/not-found; blog has none, so the shell's. */
  const said = (body) => (/shop not found (<!-- -->)?v1/.test(body) ? "shop" : /could not be found/.test(body) ? "shell" : "other");
  seen.notFound = {};
  for (const [p, want] of [["/shop/nothing", "404 shop"], ["/shop/a/b", "404 shop"], ["/blog/a/b/c", "404 shell"], ["/nothing", "404 shell"]]) {
    const r = await get(p);
    seen.notFound[p] = `${r.status} ${said(r.body)}`;
    if (seen.notFound[p] !== want) wrong[`notFound ${p}`] = seen.notFound[p];
  }
  const api = await get("/blog/api/x");
  seen.api = { status: api.status, header: api.headers.get("x-zone-header"), version: JSON.parse(api.body).version };
  if (api.status !== 200 || api.headers.get("x-zone-header") !== "blog-x" || seen.api.version !== "1.0.0") wrong.api = seen.api;
  /* Instrumentation as on Zones: the shell's for every route (skipped for shop by the policy), each zone's own for its routes. */
  const errorsOf = async (p) => {
    const before = JSON.parse((await get("/trace")).body).length;
    await get(p);
    return JSON.parse((await get("/trace")).body).slice(before).filter((e) => e.event === "error").map((e) => e.who).sort();
  };
  const trace = JSON.parse((await get("/trace")).body);
  seen.instrumentation = {
    registered: trace.filter((e) => e.event === "register").map((e) => e.who).sort(),
    "/boom": await errorsOf("/boom"), "/blog/boom": await errorsOf("/blog/boom"), "/shop/boom": await errorsOf("/shop/boom"),
  };
  const want = { registered: ["blog", "shell", "shop"], "/boom": ["shell"], "/blog/boom": ["blog", "shell"], "/shop/boom": ["shop"] };
  if (JSON.stringify(seen.instrumentation) !== JSON.stringify(want)) wrong.instrumentation = { got: seen.instrumentation, want };
  /* In the browser: soft navigation between zones in one document, the shell's state kept, and a server action and a
     client component of a zone working (the client side the link wrote: remapped ids, main chunks, manifests). */
  {
    const { createRequire } = await import("node:module");
    const { chromium } = createRequire(import.meta.url)("playwright");
    const browser = await chromium.launch();
    const page = await browser.newPage();
    const errors = [];
    page.on("pageerror", (e) => errors.push(e.message));
    page.on("console", (m) => m.type() === "error" && !/Failed to load resource/.test(m.text()) && errors.push(m.text().slice(0, 200)));
    await page.goto(`${BASE}/`);
    await page.evaluate(() => { window.__marker = "kept"; });
    await page.click("#count");
    const counted = await page.textContent("#count");
    await page.click("#to-blog");
    await page.waitForSelector("text=zone blog v");
    await page.fill("#editor", "typed in the zone");
    const typed = await page.inputValue("#editor");
    await page.click("#blog-to-shop");
    await page.waitForSelector("text=zone shop");
    seen.browser = { soft: await page.evaluate(() => window.__marker === "kept"), counter: (await page.textContent("#count")) === counted, typed, errors };
    if (!seen.browser.soft || !seen.browser.counter || typed !== "typed in the zone" || errors.length) wrong.browser = seen.browser;
    /* shop's not-found, in the shell's document: its link navigates softly. */
    await page.goto(`${BASE}/shop/nothing`);
    await page.waitForSelector("#title >> text=/shop not found/");
    await page.evaluate(() => { window.__marker = "kept"; });
    await page.click("#nf-to-live");
    await page.waitForSelector("#title >> text=/zone shop live/");
    seen.notFoundBrowser = { soft: await page.evaluate(() => window.__marker === "kept"), errors: errors.slice() };
    if (!seen.notFoundBrowser.soft || errors.length) wrong.notFoundBrowser = seen.notFoundBrowser;
    await browser.close();
  }
  seen.oneApp = { outputMB: outputMB(path.join(dir, OUTPUT === "standalone" ? path.join("shell", ".next") : path.join(".zones-app", ".next"))) };
  /* A standalone deploy is its folder alone: copied out of the workspace (no sources, no node_modules around it), its
     server.js must serve every zone. */
  if (OUTPUT === "standalone") {
    const { default: os } = await import("node:os");
    const standalone = path.join(dir, "shell", ".next", "standalone");
    const away = fs.mkdtempSync(path.join(os.tmpdir(), "nz-standalone-"));
    fs.cpSync(standalone, away, { recursive: true, verbatimSymlinks: true });
    const serverJs = [...fs.readdirSync(away, { recursive: true })].map(String).find((f) => f.endsWith(`${path.sep}server.js`) && !f.includes("node_modules"));
    const alone = spawn(process.execPath, [path.join(away, serverJs)], { cwd: path.dirname(path.join(away, serverJs)), stdio: ["ignore", "pipe", "pipe"], env: { ...process.env, PORT: "3909", HOSTNAME: "127.0.0.1" } });
    let aloneLog = "";
    alone.stdout.on("data", (d) => { aloneLog += d; });
    alone.stderr.on("data", (d) => { aloneLog += d; });
    try {
      for (let i = 0; i < 120 && !/Ready|ready|Listening/i.test(aloneLog); i++) await new Promise((r) => setTimeout(r, 250));
      const statuses = {};
      for (const p of ["/", "/blog/42", "/shop", "/post/3", "/blog/logo.png"]) statuses[p] = (await fetch(`http://127.0.0.1:3909${p}`, { redirect: "manual" })).status;
      const chunk = /src="(\/_next\/static\/chunks\/[^"]+\.js)"/.exec(await (await fetch("http://127.0.0.1:3909/blog")).text())?.[1];
      statuses.chunk = chunk ? (await fetch(`http://127.0.0.1:3909${chunk}`)).status : "none";
      seen.standaloneAlone = { server: serverJs, statuses };
      if (Object.values(statuses).some((s) => s !== 200)) wrong.standaloneAlone = { statuses, log: aloneLog.slice(-1000) };
    } finally {
      const exited = new Promise((r) => alone.once("exit", r));
      alone.kill();
      await exited;
      fs.rmSync(away, { recursive: true, force: true });
    }
  }
} catch (error) {
  wrong.error = String(error.stack ?? error);
} finally {
  if (server && server.exitCode === null) { const exited = new Promise((r) => server.once("exit", r)); server.kill(); await exited; }
}

if (!process.env.KEEP) fs.rmSync(dir, { recursive: true, force: true });
console.log(JSON.stringify({ ...seen, wrong }, null, 2));
process.exit(Object.keys(wrong).length ? 1 : 0);
