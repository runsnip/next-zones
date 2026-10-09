/*
 * Mode "single" with zones on the Pages Router: the shell, blog (App Router), docs and wiki (Pages Router, each with
 * its own _app and _document) built as one Next app (link-app.mjs) and served by `next start`. Each Pages Router page
 * renders from its own zone's build: its document, its build id, its build manifest; getStaticProps (prerendered and a
 * blocking fallback), getServerSideProps and their /_next/data routes answer under the zone's build id; in a browser,
 * soft navigations inside docs keep its _app's state, and docs → wiki or blog loads a new document.
 * With NEXT_OUTPUT=standalone (singlepagesstandalone.mjs), the shell's Next config says output: "standalone": the same
 * checks, served by the standalone server.js.
 */
import fs from "node:fs";
import path from "node:path";
import { spawn, execFileSync } from "node:child_process";
import { createRequire } from "node:module";

const require = createRequire(import.meta.url);
const { chromium } = require("playwright");
const cli = path.resolve("../../src/cli.mjs");
const OUTPUT = process.env.NEXT_OUTPUT ?? null;
const dir = path.resolve(OUTPUT ? `.single-pages-${OUTPUT}` : ".single-pages");
const PORT = 3913, BASE = `http://127.0.0.1:${PORT}`;
const wrong = {}, seen = {}, errors = [];
const run = (args) => {
  try { return { code: 0, out: execFileSync(process.execPath, [cli, ...args], { cwd: dir, encoding: "utf8", stdio: ["ignore", "pipe", "pipe"] }) }; }
  catch (e) { return { code: e.status ?? 1, out: `${e.stdout ?? ""}${e.stderr ?? ""}` }; }
};

fs.rmSync(dir, { recursive: true, force: true });
for (const [zone, from] of [["shell", "shell"], ["blog", "fixtures/blog"], ["docs", "fixtures/docs"], ["wiki", "fixtures/wiki"]]) {
  fs.cpSync(from, path.join(dir, zone), { recursive: true, filter: (src) => !/[\\/](\.next|node_modules|next-env\.d\.ts|tsconfig\.tsbuildinfo)$/.test(src) });
  const file = path.join(dir, zone, "package.json");
  fs.writeFileSync(file, JSON.stringify({ ...JSON.parse(fs.readFileSync(file, "utf8")), name: `singlepages-${zone}`, version: "1.0.0" }, null, 2));
}
fs.writeFileSync(path.join(dir, "shell", "next.config.mjs"), `import { zoneConfig } from "@runsnip/next-zones/config";\nexport default zoneConfig({ mount: "/", mode: "single"${OUTPUT ? `, output: ${JSON.stringify(OUTPUT)}` : ""} });\n`);

let server = null;
try {
  const built = run(["build"]);
  if (built.code !== 0) throw Object.assign(new Error("build failed"), { out: built.out.slice(-3000) });
  const idOf = (zone) => fs.readFileSync(path.join(dir, ".zones-store", zone, "1.0.0", "BUILD_ID"), "utf8").trim();
  const ids = { docs: idOf("docs"), wiki: idOf("wiki") };

  server = spawn(process.execPath, [cli, "start", "--port", String(PORT), "--host", "127.0.0.1"], { cwd: dir, stdio: ["ignore", "pipe", "pipe"] });
  let log = "";
  server.stdout.on("data", (d) => { log += d; });
  server.stderr.on("data", (d) => { log += d; });
  for (let i = 0; i < 120 && !/Ready/.test(log); i++) await new Promise((r) => setTimeout(r, 250));
  const html = async (p) => {
    const r = await fetch(BASE + p, { signal: AbortSignal.timeout(30_000) });
    const body = await r.text();
    return { status: r.status, title: /<h1 id="title">(.*?)<\/h1>/.exec(body)?.[1]?.replace(/<!-- -->/g, "") ?? null, buildId: /"buildId":"([^"]+)"/.exec(body)?.[1] ?? null, zone: /data-zone="([^"]+)"/.exec(body)?.[1] ?? null };
  };
  const expect = {
    "/docs": ["index 1.0.0", "docs"], "/docs/a": ["doc a 1.0.0", "docs"], "/docs/zz": ["doc zz 1.0.0", "docs"], "/docs/ssr?q=s": ["ssr 1.0.0 s", "docs"],
    "/docs/plain": ["plain 1.0.0", "docs"], "/wiki": ["wiki home", "wiki"],
  };
  for (const [p, [title, zone]] of Object.entries(expect)) {
    const got = await html(p);
    seen[p] = got;
    if (got.status !== 200 || got.title !== title || got.zone !== zone || got.buildId !== ids[zone]) wrong[p] = got;
  }
  const blog = await html("/blog");
  if (blog.status !== 200 || !/zone blog/.test(blog.title ?? "")) wrong["/blog"] = blog;
  for (const p of ["docs.json", "docs/a.json", "docs/zz.json", "docs/ssr.json?q=d"]) {
    const r = await fetch(`${BASE}/_next/data/${ids.docs}/${p}`, { signal: AbortSignal.timeout(30_000) });
    const body = await r.text();
    seen[`data ${p}`] = r.status;
    if (r.status !== 200 || !body.includes('"pageProps"')) wrong[`data ${p}`] = { status: r.status, body: body.slice(0, 200) };
  }

  const browser = await chromium.launch();
  const page = await browser.newPage();
  page.on("pageerror", (e) => errors.push(e.message));
  /* <ZoneUpdates /> finds no event stream in one app (Zones' endpoints do not exist there) and stops. */
  page.on("response", (r) => { const p = new URL(r.url()).pathname; if (r.status() >= 400 && p !== "/_next-zones/events") errors.push(`${r.status()} ${p}`); });
  const marker = () => page.evaluate(() => window.__marker === "kept");
  await page.goto(`${BASE}/docs`);
  await page.evaluate(() => { window.__marker = "kept"; });
  await page.click("#inc");
  for (const [link, text] of [["#to-a", "doc a 1"], ["#to-b", "doc b 1"], ["#to-ssr", "ssr 1"], ["#to-plain", "plain 1"]]) {
    await page.click(link);
    await page.waitForSelector(`#title >> text=${text}`);
  }
  seen.browser = { soft: await marker(), count: (await page.textContent("#inc")).trim() };
  if (!seen.browser.soft || seen.browser.count !== "count 1") wrong.browser = seen.browser;
  await page.goto(`${BASE}/wiki`);
  await page.click("#wiki-to-docs");
  await page.waitForSelector("#title >> text=index 1");
  seen.wikiToDocs = { zone: await page.getAttribute("html", "data-zone") };
  if (seen.wikiToDocs.zone !== "docs") wrong.wikiToDocs = seen.wikiToDocs;
  await browser.close();
  if (errors.length) wrong.errors = errors;
} catch (error) {
  wrong.failed = error.out ?? String(error.stack ?? error);
} finally {
  if (server) { const exited = new Promise((r) => server.once("exit", r)); server.kill(); await exited; }
}
console.log(JSON.stringify({ seen, wrong }, null, 2));
process.exit(0);
