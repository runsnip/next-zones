/*
 * A zone image with a Pages Router route is refused at install, and nothing changes; Next's own pages (/404, /500),
 * in every build, are not. The image is blog 1 with one pages/ route added to its manifest and its integrity recorded
 * again, as a build with that route would have it.
 */
import fs from "node:fs";
import path from "node:path";
import { createRequire } from "node:module";

const { digestBuild } = createRequire(import.meta.url)("../../src/zones/describe.cjs");
const BASE = "http://127.0.0.1:3900";
const store = path.join(".zones-store", "blog");
const install = async (v) => { const r = await fetch(`${BASE}/_next-zones/images/blog/${v}/install`, { method: "POST" }); return { status: r.status, body: await r.json() }; };
const served = async () => (await (await fetch(`${BASE}/blog/api/x`)).json()).version;

for (const v of ["94"]) fs.rmSync(path.join(store, v), { recursive: true, force: true });
const dir = path.join(store, "94");
fs.cpSync(path.join(store, "1"), dir, { recursive: true, verbatimSymlinks: true });
const manifestFile = path.join(dir, "server", "pages-manifest.json");
const manifest = fs.existsSync(manifestFile) ? JSON.parse(fs.readFileSync(manifestFile, "utf8")) : {};
fs.writeFileSync(manifestFile, JSON.stringify({ ...manifest, "/legacy": "pages/legacy.js" }));
fs.mkdirSync(path.join(dir, "server", "pages"), { recursive: true });
fs.writeFileSync(path.join(dir, "server", "pages", "legacy.js"), "module.exports = {};\n");
const zoneJson = JSON.parse(fs.readFileSync(path.join(dir, "zone.json"), "utf8"));
fs.writeFileSync(path.join(dir, "zone.json"), JSON.stringify({ ...zoneJson, version: "94", integrity: digestBuild(dir) }));
try {
  await install("2");
  const pages = await install("94");
  const afterRefusal = await served();
  const intact = await install("1");
  const wrong = {};
  if (pages.status !== 409 || !/Pages Router routes \(\/legacy\)/.test(pages.body.refused ?? "")) wrong.pages = pages;
  if (afterRefusal !== "2") wrong.afterRefusal = afterRefusal;
  if (intact.status !== 200) wrong.intact = intact;
  console.log(JSON.stringify({ pages: pages.body.refused ?? pages.body, afterRefusal, intact: intact.status, wrong }, null, 2));
} finally {
  fs.rmSync(dir, { recursive: true, force: true });
}
