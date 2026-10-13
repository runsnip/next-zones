/*
 * zone-client.cjs on a small build made here: a zone whose Web Worker runs a module the shell has too (aliased to the
 * shell's id, so its chunk is written again). The worker's runtime chunk waits for its chunks by name and runs its
 * entry: it must be written again with the new names, and the module that starts the worker must name it so.
 */
import { test } from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { Worker } from "node:worker_threads";

const SPIKE_MODULES = new URL("../spikes/zones/node_modules", import.meta.url).pathname;
const skip = fs.existsSync(path.join(SPIKE_MODULES, "next", "dist", "compiled", "acorn")) ? false : "needs spikes/zones installed (npm install there): the parser is Next's";
const PUSH = (items) => `(globalThis.TURBOPACK||(globalThis.TURBOPACK=[])).push(["object"==typeof document?document.currentScript:void 0,${items}]);\n`;

function build(root, name, chunks, rootMainFiles) {
  const dist = path.join(root, name, ".next");
  fs.mkdirSync(path.join(dist, "static", "chunks"), { recursive: true });
  fs.writeFileSync(path.join(root, name, "package.json"), "{}");
  fs.writeFileSync(path.join(dist, "build-manifest.json"), JSON.stringify({ pages: {}, rootMainFiles }));
  for (const [file, text] of Object.entries(chunks)) fs.writeFileSync(path.join(dist, "static", "chunks", file), text);
  return dist;
}
const analyse = (workerData) => new Promise((resolve, reject) => {
  const w = new Worker(new URL("../src/zones/zone-client.cjs", import.meta.url), { workerData });
  w.once("message", resolve);
  w.once("error", reject);
});

test("a worker's runtime chunk is written again with its chunks' new names, and named so where the worker starts", { skip }, async () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "nz-worker-"));
  fs.symlinkSync(SPIKE_MODULES, path.join(root, "node_modules"));
  try {
    /* The shell: five-digit ids. The zone: six, so its copy of the shell's module is aliased to the shell's id. */
    const shellDist = build(root, "shell", { "main.js": PUSH(`12598,(e)=>{e.v("shared")},23456,(e)=>{e.v(1)}`) }, ["static/chunks/main.js"]);
    const dist = build(root, "zone", {
      "w.js": PUSH(`912598,(e)=>{e.v("shared")},900001,(e)=>{let n=e.i(912598);self.postMessage(n)}`),
      "turbopack-w1.js": PUSH(`{otherChunks:["static/chunks/w.js"],runtimeModuleIds:[900001]}`),
      "turbopack-worker-x.js": "!function(){importScripts()}();\n",
      "page.js": PUSH(`900002,(e)=>{e.v(e.b("static/chunks/turbopack-worker-x.js",["static/chunks/w.js","static/chunks/turbopack-w1.js"]))}`),
    }, ["static/chunks/page.js"]);
    const outDir = path.join(root, "out");
    const result = await analyse({ dist, shellDist, known: null, outDir, buildKey: "0123456789abcdef", urlPrefix: "/_next/" });

    assert.equal(result.idMap["912598"], 12598);
    const renamed = (f) => `static/chunks/${f.replace(/\.js$/, "-z01234567.js")}`;
    for (const f of ["w.js", "turbopack-w1.js", "page.js"]) assert.equal(result.chunkMap[`static/chunks/${f}`], renamed(f), f);
    assert.equal(result.chunkMap["static/chunks/turbopack-worker-x.js"], undefined, "the bootstrap names no chunk");
    const runtime = fs.readFileSync(path.join(outDir, "turbopack-w1-z01234567.js"), "utf8");
    assert.match(runtime, /otherChunks:\["static\/chunks\/w-z01234567\.js"\],runtimeModuleIds:\[900001\]/);
    const page = fs.readFileSync(path.join(outDir, "page-z01234567.js"), "utf8");
    assert.ok(page.includes(`["static/chunks/w-z01234567.js","static/chunks/turbopack-w1-z01234567.js"]`), page);
    /* No file the browser may load names a chunk by the name it no longer has. */
    for (const f of fs.readdirSync(outDir)) {
      const text = fs.readFileSync(path.join(outDir, f), "utf8");
      for (const old of ["w.js", "turbopack-w1.js", "page.js"]) assert.ok(!text.includes(`"static/chunks/${old}"`), `${f} names ${old}`);
    }
  } finally {
    fs.rmSync(root, { recursive: true, force: true });
  }
});
