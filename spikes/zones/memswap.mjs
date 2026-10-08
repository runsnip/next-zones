/*
 * Memory across many versions: N versions of a zone (copies of one build at N paths, so N distinct sets of modules for
 * Node, as N releases would be) are installed one after another, each requested so its code is loaded. Heap after a
 * full GC, and RSS, are read after every few installs. With --collect, Zones collects old versions as it goes.
 *
 *   node memswap.mjs [versions=20] [--collect]    (Zones must run with debug on; /_next-zones/debug?gc=1 runs a full GC)
 */
import fs from "node:fs";
import path from "node:path";

const BASE = "http://127.0.0.1:3900";
const versions = Number(process.argv[2] ?? 20);
const collect = process.argv.includes("--collect");
const store = ".zones-store/blog";
for (let v = 100; v < 100 + versions; v++) {
  const dir = path.join(store, String(v));
  if (fs.existsSync(dir)) continue;
  fs.cpSync(path.join(store, "1"), dir, { recursive: true, verbatimSymlinks: true });
  const zoneJson = JSON.parse(fs.readFileSync(path.join(dir, "zone.json"), "utf8"));
  fs.writeFileSync(path.join(dir, "zone.json"), JSON.stringify({ ...zoneJson, version: String(v) }));
}
const memory = async () => (await (await fetch(`${BASE}/_next-zones/debug?gc=1`)).json());
const samples = [];
for (let i = 0; i < versions; i++) {
  const v = 100 + i;
  const r = await (await fetch(`${BASE}/_next-zones/images/blog/${v}/install`, { method: "POST" })).json();
  if (!r.name) { console.log(JSON.stringify(r)); process.exit(1); }
  for (const p of ["/blog/42", "/blog/api/x", "/blog/stamp"]) await (await fetch(BASE + p)).arrayBuffer();
  if (collect) await fetch(`${BASE}/_next-zones/collect?keep=2`, { method: "POST" });
  if (i % 5 === 4 || i === 0) { const m = await memory(); samples.push({ installed: i + 1, heapMB: m.heapUsedMB, rssMB: m.rssMB, runtimes: m.runtimes.length }); }
}
console.log(JSON.stringify({ versions, collect, samples }, null, 2));
