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

test("modules the shell has under other ids are counted and a sample of them named (an installed-twice package)", { skip }, async () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "nz-differ-"));
  fs.symlinkSync(SPIKE_MODULES, path.join(root, "node_modules"));
  try {
    /* The same module code at two paths (one package at two versions, an unchanged file of it): two ids. */
    const shellDist = build(root, "shell", { "main.js": PUSH(`12598,(e)=>{e.v("arrow-icon")},23456,(e)=>{e.v(1)}`) }, ["static/chunks/main.js"]);
    const dist = build(root, "zone", { "page.js": PUSH(`45678,(e)=>{e.v("arrow-icon")},23456,(e)=>{e.v(1)},34567,(e)=>{e.v(2)}`) }, ["static/chunks/page.js"]);
    const result = await analyse({ dist, shellDist, known: null, outDir: path.join(root, "out"), buildKey: "0123456789abcdef", urlPrefix: "/_next/" });
    assert.equal(result.shared.sameCode, 2);
    assert.equal(result.shared.sameId, 1);
    assert.deepEqual(result.shared.differ.map(({ id, knownAs }) => ({ id, knownAs })), [{ id: "45678", knownAs: ["12598"] }]);
    assert.match(result.shared.differ[0].code, /arrow-icon/);
  } finally {
    fs.rmSync(root, { recursive: true, force: true });
  }
});

test("a module an earlier zone holds under a wider id is the same module (Admin then Docx): aliased, not another root", { skip }, async () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "nz-earlier-"));
  fs.symlinkSync(SPIKE_MODULES, path.join(root, "node_modules"));
  try {
    const shellDist = build(root, "shell", { "main.js": PUSH(`12598,(e)=>{e.v("react-ish")}`) }, ["static/chunks/main.js"]);
    /* A large zone, installed first: six-digit ids for a package the shell does not have. */
    const big = build(root, "big", { "page.js": PUSH(`691096,(e)=>{e.v("pdf-lexer")},992719,(e)=>{e.v("numfmt")},900003,(e)=>{e.v(3)}`) }, ["static/chunks/page.js"]);
    const first = await analyse({ dist: big, shellDist, known: null, outDir: path.join(root, "out-big"), buildKey: "0123456789abcdef", urlPrefix: "/_next/" });
    const known = {};
    for (const [id, hs] of Object.entries({ ...first.shellModules })) known[id] = hs;
    for (const [id, hs] of Object.entries(first.zoneModules)) known[id] = [...new Set([...(known[id] ?? []), ...hs])];
    /* A smaller zone after it, with the same package: five-digit ids, the wider ones' last digits. */
    const small = build(root, "small", { "page.js": PUSH(`91096,(e)=>{e.v("pdf-lexer")},92719,(e)=>{e.v("numfmt")},55555,(e)=>{e.v(5)}`) }, ["static/chunks/page.js"]);
    const second = await analyse({ dist: small, shellDist, known, outDir: path.join(root, "out-small"), buildKey: "fedcba9876543210", urlPrefix: "/_next/" });
    assert.equal(second.idMap["91096"], 691096);
    assert.equal(second.idMap["92719"], 992719);
    assert.deepEqual({ sameCode: second.shared.sameCode, sameId: second.shared.sameId, differ: second.shared.differ }, { sameCode: 2, sameId: 2, differ: [] });
  } finally {
    fs.rmSync(root, { recursive: true, force: true });
  }
});
