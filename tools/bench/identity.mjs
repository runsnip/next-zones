#!/usr/bin/env node
/*
 * The client analysis of one zone build against its shell (src/zones/zone-client.cjs, the worker an install runs):
 * wall time, how many client modules it read, and how many it found conflicting (given new ids, their chunks written
 * again). Run on this tree and, with --against <git ref>, on that ref's zone-client.cjs, each in a fresh worker.
 *
 *   node tools/bench/identity.mjs --dist <zone image dir> --shell <shell dir> [--runs 3] [--against <git ref>] [--cached]
 *
 * --cached: the module reads of an earlier run are on disk (as after installing another version of the zone).
 *
 * A conflict the shell's own modules do not explain is a false difference: the same code, seen as another.
 */
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { Worker } from "node:worker_threads";
import { execFileSync } from "node:child_process";
import { fileURLToPath } from "node:url";

const opt = (name, fallback) => { const i = process.argv.indexOf(`--${name}`); return i >= 0 ? process.argv[i + 1] : fallback; };
const dist = path.resolve(opt("dist")), shellDist = path.join(path.resolve(opt("shell")), ".next");
const runs = Number(opt("runs", "3")), against = opt("against");
const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..", "..");
const buildId = fs.readFileSync(path.join(dist, "BUILD_ID"), "utf8").trim();

const variants = [["this tree", path.join(root, "src", "zones", "zone-client.cjs")]];
let aside = null;
if (against) {
  /* That ref's src/zones, beside this tree's, so its relative requires resolve to its own files. */
  aside = path.join(root, "src", `.bench-zones-${process.pid}`);
  fs.mkdirSync(aside);
  const files = execFileSync("git", ["ls-tree", "--name-only", `${against}:src/zones`], { cwd: root, encoding: "utf8" }).split("\n").filter((f) => f.endsWith(".cjs"));
  for (const f of files) fs.writeFileSync(path.join(aside, f), execFileSync("git", ["show", `${against}:src/zones/${f}`], { cwd: root }));
  variants.push([against, path.join(aside, "zone-client.cjs")]);
}
/* --cached: each run after the first reads the module reads the first wrote (an install after another version). */
const cachedRuns = process.argv.includes("--cached");
const once = (file, readCache) => new Promise((resolve, reject) => {
  const outDir = fs.mkdtempSync(path.join(os.tmpdir(), "nz-bench-id-"));
  const t = performance.now();
  const w = new Worker(file, { workerData: { dist, shellDist, known: null, outDir, buildKey: buildId, readCache } });
  w.once("message", (m) => { const ms = performance.now() - t; fs.rmSync(outDir, { recursive: true, force: true }); resolve({ ms, m }); });
  w.once("error", reject);
});
const results = [];
try {
  for (const [label, file] of variants) {
    const samples = [];
    const readCache = cachedRuns ? path.join(fs.mkdtempSync(path.join(os.tmpdir(), "nz-bench-reads-")), "reads.json") : undefined;
    if (readCache) await once(file, readCache);                      // fills it
    for (let i = 0; i < runs; i++) samples.push(await once(file, readCache));
    if (readCache) fs.rmSync(path.dirname(readCache), { recursive: true, force: true });
    const ms = samples.map((s) => s.ms).sort((a, b) => a - b)[Math.floor(runs / 2)];
    const { m } = samples[0];
    results.push({ label, ms, modules: Object.keys(m.zoneModules).length, shell: Object.keys(m.shellModules ?? {}).length, conflicting: Object.keys(m.idMap).length, chunks: Object.keys(m.chunkMap).length });
  }
} finally { if (aside) fs.rmSync(aside, { recursive: true, force: true }); }
console.log(`Client analysis of ${path.basename(path.dirname(dist))} ${path.basename(dist)} against its shell, Node ${process.version}, ${os.cpus()[0]?.model ?? ""}; median of ${runs} runs, each in a fresh worker.\n`);
console.log("| zone-client.cjs | time | zone modules | shell modules | conflicting (new ids) | chunks rewritten |\n|---|---|---|---|---|---|");
for (const r of results) console.log(`| ${r.label} | ${(r.ms / 1000).toFixed(2)} s | ${r.modules} | ${r.shell} | ${r.conflicting} | ${r.chunks} |`);
