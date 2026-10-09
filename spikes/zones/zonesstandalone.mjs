/*
 * Mode "zones" with Next's output: "standalone". The shell and blog say output: "standalone" in their Next configs;
 * blog uses a server external package (@spike/ext) the shell does not. next-zones build makes the shell's standalone
 * folder the whole deploy: zones.js, next-zones, the shell's declaration, the images and the pins. Copied out of the
 * workspace (no sources, no node_modules around it), `node zones.js` serves every zone: pages, the external package
 * from blog's image, an alias, public files, soft navigation between zones, and Zones' endpoints; and docs, a zone on
 * the Pages Router: its static, getStaticProps and getServerSideProps pages, rendered from its own build.
 */
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { spawn, execFileSync } from "node:child_process";
import { createRequire } from "node:module";

const require = createRequire(import.meta.url);
const { chromium } = require("playwright");
const cli = path.resolve("../../src/cli.mjs");
const dir = path.resolve(".zones-standalone");
const PORT = 3911, BASE = `http://127.0.0.1:${PORT}`;
const wrong = {}, seen = {};

fs.rmSync(dir, { recursive: true, force: true });
for (const [zone, from] of [["shell", "shell"], ["blog", "fixtures/blog"], ["shop", "fixtures/shop"], ["docs", "fixtures/docs"]]) {
  fs.cpSync(from, path.join(dir, zone), { recursive: true, filter: (src) => !/[\\/](\.next|node_modules|next-env\.d\.ts|tsconfig\.tsbuildinfo)$/.test(src) });
  const file = path.join(dir, zone, "package.json");
  fs.writeFileSync(file, JSON.stringify({ ...JSON.parse(fs.readFileSync(file, "utf8")), name: `standalone-${zone}`, version: "1.0.0" }, null, 2));
}
fs.writeFileSync(path.join(dir, "shell", "next.config.mjs"), `import { zoneConfig } from "@runsnip/next-zones/config";
export default zoneConfig({ mount: "/", endpoints: { events: true, health: true, admin: true } }, { output: "standalone" });
`);
const blogConfig = path.join(dir, "blog", "next.config.mjs");
fs.writeFileSync(blogConfig, fs.readFileSync(blogConfig, "utf8").replace("serverExternalPackages:", `output: "standalone",\n    serverExternalPackages:`));
if (!/output: "standalone"/.test(fs.readFileSync(blogConfig, "utf8"))) throw new Error("blog's next.config was not given output: standalone");

let server = null, away = null;
try {
  let out = "";
  try { out = execFileSync(process.execPath, [cli, "build"], { cwd: dir, encoding: "utf8", stdio: ["ignore", "pipe", "pipe"] }); }
  catch (e) { wrong.build = `${e.stdout ?? ""}${e.stderr ?? ""}`.slice(-3000); throw new Error("build failed"); }
  seen.report = out.split("\n").filter((l) => l.startsWith("✓"));
  if (!seen.report.some((l) => /Zones, standalone/.test(l))) wrong.report = seen.report;
  const blogImage = path.join(dir, ".zones-store", "blog", "1.0.0");
  seen.blogCarries = fs.existsSync(path.join(blogImage, "node_modules", "@spike", "ext")) ? "@spike/ext" : null;
  if (!seen.blogCarries) wrong.blogCarries = "blog's image does not carry @spike/ext";

  /* The deploy, alone: the standalone folder copied out of the workspace. */
  away = fs.mkdtempSync(path.join(os.tmpdir(), "nz-zones-standalone-"));
  fs.cpSync(path.join(dir, "shell", ".next", "standalone"), away, { recursive: true, verbatimSymlinks: true });
  const entry = [...fs.readdirSync(away, { recursive: true })].map(String).find((f) => f.endsWith(`${path.sep}zones.js`) && !f.includes("node_modules"));
  seen.entry = entry;
  server = spawn(process.execPath, [path.join(away, entry)], { stdio: ["ignore", "pipe", "pipe"], env: { ...process.env, PORT: String(PORT), HOSTNAME: "127.0.0.1" } });
  let log = "";
  server.stdout.on("data", (d) => { log += d; });
  server.stderr.on("data", (d) => { log += d; });
  for (let i = 0; i < 120 && !/Zones on/.test(log) && server.exitCode === null; i++) await new Promise((r) => setTimeout(r, 250));
  if (!/Zones on/.test(log)) { wrong.start = log.slice(-3000); throw new Error("Zones did not start"); }

  const get = async (p) => { const r = await fetch(BASE + p, { redirect: "manual" }); return { status: r.status, body: await r.text() }; };
  const statuses = {};
  for (const p of ["/", "/about", "/blog", "/blog/42", "/shop", "/post/3", "/blog/logo.png", "/_next-zones/health"]) statuses[p] = (await get(p)).status;
  seen.statuses = statuses;
  if (Object.values(statuses).some((s) => s !== 200)) wrong.statuses = statuses;
  const ext = await get("/blog/ext");
  seen.ext = /zone blog ext (<!-- -->)?from an external package/.test(ext.body) ? "from an external package" : ext.status;
  if (seen.ext !== "from an external package") wrong.ext = { status: ext.status, body: ext.body.slice(0, 300), log: log.slice(-1500) };
  const docsId = fs.readFileSync(path.join(dir, ".zones-store", "docs", "1.0.0", "BUILD_ID"), "utf8").trim();
  seen.docs = {};
  for (const [p, title] of [["/docs", "index 1.0.0"], ["/docs/a", "doc a 1.0.0"], ["/docs/zz", "doc zz 1.0.0"], ["/docs/ssr?q=s", "ssr 1.0.0 s"], ["/docs/plain", "plain 1.0.0"]]) {
    const r = await get(p);
    const got = { status: r.status, title: /<h1 id="title">(.*?)<\/h1>/.exec(r.body)?.[1]?.replace(/<!-- -->/g, "") ?? null, ownBuild: r.body.includes(`"buildId":"${docsId}"`) };
    seen.docs[p] = got;
    if (got.status !== 200 || got.title !== title || !got.ownBuild) wrong[p] = { ...got, log: log.slice(-800) };
  }

  const browser = await chromium.launch();
  const page = await browser.newPage();
  const errors = [];
  page.on("pageerror", (e) => errors.push(e.message));
  await page.goto(`${BASE}/`);
  await page.click("#count");
  const counted = await page.textContent("#count");
  await page.click("#to-blog");
  await page.waitForSelector("text=zone blog v");
  await page.click("#to-shop");
  await page.waitForSelector("text=zone shop");
  seen.soft = (await page.textContent("#count")) === counted;
  if (!seen.soft) wrong.soft = "the shell's state was lost";
  if (errors.length) wrong.errors = errors;
  await browser.close();
} catch (error) {
  wrong.error ??= String(error.message ?? error);
} finally {
  if (server && server.exitCode === null) { const exited = new Promise((r) => server.once("exit", r)); server.kill(); await exited; }
  if (away) fs.rmSync(away, { recursive: true, force: true });
  fs.rmSync(dir, { recursive: true, force: true });
}
console.log(JSON.stringify({ ...seen, wrong }, null, 2));
process.exit(Object.keys(wrong).length ? 1 : 0);
