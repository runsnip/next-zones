/*
 * Runs in a worker thread: a zone build's client code against what a browser may already hold, once per (zone build,
 * shell build, what was installed before).
 *
 * The browser has one Turbopack runtime, which keeps one factory per module id, the first it loads. Module ids come
 * from the module's path, so a module shared by builds (a shared package, the shell's layout) has the same id in
 * every build even when its code differs (another version of the package). So:
 * 1. Every module of the zone's client chunks is hashed and compared with what the browser may hold for its id (the
 *    shell's modules and every zone installed before, `known`). The hash is of what the module is, not of its text
 *    (identities() below): builds name locals and even modules differently. A different hash is a conflict.
 * 2. A module that requires a conflicting one is rewritten too, so it conflicts as well when the browser may hold its
 *    id: conflicts spread to their importers.
 * 3. Conflicting modules get new ids (derived from the zone build and the old id); every chunk of the zone is written
 *    again with them, under a new URL (the old one may be cached).
 * 4. The modules the zone's root main chunks hold and the shell's lack (with what they require) go into one chunk of
 *    their own: a zone reached softly runs in the shell's document, which never loads the zone's main chunks.
 * 5. The Turbopack runtime methods the zone's code calls must exist in the shell's runtime.
 * Results: the id map, the chunk URL map, the main chunk, the zone's module hashes (for later installs).
 */
const { parentPort, workerData, threadId } = require("node:worker_threads");
const fs = require("node:fs");
const path = require("node:path");
const vm = require("node:vm");
const crypto = require("node:crypto");

const { dist, shellDist, known: knownIn, outDir, buildKey, urlPrefix, readCache } = workerData;
const isRuntime = (f) => /(^|[\\/])turbopack-[^/]*\.js$/.test(f);
const { createRequire } = require("node:module");
const { useParser, readModule, remapRequires } = require("./module-code.cjs");
/* Every module factory is read with a parser (module-code.cjs): Next's own acorn, from the shell. */
useParser(createRequire(path.join(shellDist, "..", "package.json"))("next/dist/compiled/acorn"));
const sha = (text) => crypto.createHash("sha1").update(text).digest("base64");
/* The analysis format, part of the cache key: hashes of another format are not comparable. */
const FORMAT = "m3";
/* What a group's factory is (module-code.cjs): its canonical code's hash, the ids it requires (where), the runtime
   methods it calls. Kept on disk by the factory's text (readCache), so a module two builds share, byte for byte (most
   of a zone's next version), is parsed once: parsing is most of the analysis's time. */
const reads = new Map();
let cached = {};
try { if (readCache) cached = JSON.parse(fs.readFileSync(readCache, "utf8")); } catch {}
const read = (g) => {
  if (g.read) return g.read;
  const key = sha(g.source);
  let r = reads.get(key);
  if (!r && cached[key]) r = { code: cached[key].c, requires: cached[key].r, runtimeMethods: new Set(cached[key].m) };
  if (!r) {
    let m;
    try { m = readModule(g.source); }
    catch (error) { throw new Error(`next-zones: a client module (${g.ids.join(", ")}) could not be parsed: ${error.message}`); }
    r = { code: sha(m.canonical), requires: m.requires, runtimeMethods: m.runtimeMethods };
  }
  reads.set(key, r);
  return (g.read = r);
};
/* The reads of this run, with the earlier ones, up to a bound: written whole, by rename (two installs may race). */
function saveReads() {
  if (!readCache) return;
  const all = { ...cached };
  for (const [key, r] of reads) all[key] = { c: r.code, r: r.requires, m: [...r.runtimeMethods] };
  const keys = Object.keys(all);
  const keep = keys.length > 100_000 ? Object.fromEntries([...reads.keys()].map((k) => [k, all[k]])) : all;
  fs.mkdirSync(path.dirname(readCache), { recursive: true });
  const temp = `${readCache}.${threadId}.${crypto.randomUUID()}.tmp`;
  fs.writeFileSync(temp, JSON.stringify(keep));
  fs.renameSync(temp, readCache);
}
const requiredBy = (g) => read(g).requires.map((r) => r.id);

/* A module's identity, comparable across builds. Two builds may give one module different ids, and minify it with
   different local names, so:
   - its own code is taken up to the names of its bindings (module-code.cjs, from a parse), with the ids it
     requires blanked;
   - each module it requires stands for its own identity, in order (a Merkle hash), so a dependency counts by what it
     is, not by its id.
   Modules that require each other (a cycle: Next's router has them) are hashed together, independently of the order
   they are reached in: the cycle's modules are refined from their own code and what they require outside it, round
   after round, as many rounds as the cycle has modules (color refinement), so equal identities mean equal code all
   the way down. A required module the build does not hold stands for its raw id. */
function identities(groups) {
  const own = new Map(), deps = new Map();
  for (const g of groups) {
    const code = read(g).code;
    const required = requiredBy(g);
    for (const id of g.ids) { own.set(String(id), code); deps.set(String(id), required); }
  }
  /* Tarjan's strongly connected components, iteratively; each is finished after every component it requires. */
  const index = new Map(), low = new Map(), onStack = new Set(), stack = [], out = new Map();
  let counter = 0;
  const finish = (members) => {
    const inside = new Set(members);
    const outside = (dep) => (own.has(dep) ? out.get(dep) : `#${dep}`);
    let color = new Map(members.map((id) => [id, sha(`${FORMAT}:${members.length}:${own.get(id)}:${deps.get(id).map((d) => (inside.has(d) ? "" : outside(d))).join(",")}`)]));
    for (let round = 1; round < members.length; round++) {
      color = new Map(members.map((id) => [id, sha(`${color.get(id)}:${deps.get(id).map((d) => (inside.has(d) ? color.get(d) : "")).join(",")}`)]));
    }
    for (const id of members) out.set(id, color.get(id));
  };
  for (const root of own.keys()) {
    if (index.has(root)) continue;
    const work = [[root, 0]];
    while (work.length) {
      const frame = work[work.length - 1];
      const [id, i] = frame;
      if (i === 0) { index.set(id, counter); low.set(id, counter); counter++; stack.push(id); onStack.add(id); }
      const list = deps.get(id);
      if (i < list.length) {
        frame[1]++;
        const dep = list[i];
        if (!own.has(dep)) continue;
        if (!index.has(dep)) work.push([dep, 0]);
        else if (onStack.has(dep)) low.set(id, Math.min(low.get(id), index.get(dep)));
        continue;
      }
      work.pop();
      if (work.length) { const parent = work[work.length - 1][0]; low.set(parent, Math.min(low.get(parent), low.get(id))); }
      if (low.get(id) === index.get(id)) {
        const members = [];
        let m;
        do { m = stack.pop(); onStack.delete(m); members.push(m); } while (m !== id);
        finish(members);
      }
    }
  }
  return out;
}

/* A chunk's module groups ([{ ids, source }]), from running it in a sandbox where TURBOPACK.push collects them. A
   chunk that is not in that format (a polyfill bundle) registers no module, and has none. */
function chunkGroups(file) {
  const pushed = [];
  const sandbox = { TURBOPACK: { push: (items) => pushed.push(items) }, document: undefined };
  sandbox.globalThis = sandbox.self = sandbox;
  try { vm.runInNewContext(fs.readFileSync(file, "utf8"), sandbox, { filename: file, timeout: 5000 }); }
  catch { if (!pushed.length) return []; }
  const groups = [];
  for (const items of pushed) {
    let ids = [];
    for (const item of items.slice(1)) {
      if (typeof item === "function") { groups.push({ ids, source: item.toString() }); ids = []; } else ids.push(item);
    }
  }
  return groups;
}
const chunksOf = (root) => fs.readdirSync(path.join(root, "static", "chunks")).filter((f) => f.endsWith(".js") && !isRuntime(f));

/* What the browser may hold: the shell's modules, and what earlier installs reported. */
const known = new Map(Object.entries(knownIn ?? {}).map(([id, hashes]) => [id, new Set(hashes)]));
let shellModules = null;
if (!knownIn) {
  shellModules = {};
  const shellGroups = chunksOf(shellDist).flatMap((f) => chunkGroups(path.join(shellDist, "static", "chunks", f)));
  for (const [id, h] of identities(shellGroups)) { known.set(id, new Set([h])); shellModules[id] = [h]; }
}

/* The zone's modules, by chunk. */
const chunks = chunksOf(dist).map((file) => ({ file, groups: chunkGroups(path.join(dist, "static", "chunks", file)) }));
const groupOf = new Map();
for (const c of chunks) for (const g of c.groups) for (const id of g.ids) groupOf.set(String(id), g);
const zoneIds = identities(chunks.flatMap((c) => c.groups));

/* 1–2. Conflicts, spread to the importers the browser may hold. */
const conflicting = new Set();
for (const [id, h] of zoneIds) if (known.has(id) && !known.get(id).has(h)) conflicting.add(id);
const importers = new Map();
for (const [id, g] of groupOf) for (const dep of requiredBy(g)) (importers.get(dep) ?? importers.set(dep, new Set()).get(dep)).add(id);
const queue = [...conflicting];
while (queue.length) {
  for (const importer of importers.get(queue.pop()) ?? []) {
    if (!conflicting.has(importer) && known.has(importer)) { conflicting.add(importer); queue.push(importer); }
  }
}

/* 3. New ids, and every chunk written again. */
const idMap = {};
const taken = new Set([...known.keys(), ...groupOf.keys()]);
for (const id of conflicting) {
  let n = 1e14 + (parseInt(crypto.createHash("sha1").update(`${buildKey}:${id}`).digest("hex").slice(0, 12), 16) % 8e14);
  while (taken.has(String(n))) n++;
  taken.add(String(n));
  idMap[id] = n;
}
const chunkMap = {};
/* Two installs of one build may analyse it at once, and Zones may be serving the file: never a half-written one. */
const writeAtomic = (file, text) => {
  const temp = `${file}.${threadId}.${crypto.randomUUID()}.tmp`;
  fs.writeFileSync(temp, text);
  fs.renameSync(temp, file);
};
/* Each required id rewritten where the parse found it: the original ids stay what the analysis below follows. */
const remapSource = (g) => remapRequires(g.source, read(g).requires, idMap);
if (conflicting.size) {
  fs.mkdirSync(outDir, { recursive: true });
  for (const c of chunks) {
    const touched = c.groups.some((g) => g.ids.some((id) => idMap[id] !== undefined) || requiredBy(g).some((d) => idMap[d] !== undefined));
    if (!touched) continue;
    const renamed = c.file.replace(/\.js$/, `-z${buildKey.slice(0, 8)}.js`);
    const items = c.groups.flatMap((g) => [...g.ids.map((id) => JSON.stringify(idMap[id] ?? id)), remapSource(g)]);
    writeAtomic(path.join(outDir, renamed), `(globalThis.TURBOPACK||(globalThis.TURBOPACK=[])).push(["object"==typeof document?document.currentScript:void 0,${items.join(",")}]);\n`);
    chunkMap[`static/chunks/${c.file}`] = `static/chunks/${renamed}`;
    for (const g of c.groups) g.output = remapSource(g);
  }
}

/* 4. The main chunk: the modules of the zone's root main chunks the shell's main chunks lack, and what they require. */
const zoneBuild = JSON.parse(fs.readFileSync(path.join(dist, "build-manifest.json"), "utf8"));
const shellBuild = JSON.parse(fs.readFileSync(path.join(shellDist, "build-manifest.json"), "utf8"));
const shellMain = new Set();
for (const f of shellBuild.rootMainFiles ?? []) if (!isRuntime(f)) for (const g of chunkGroups(path.join(shellDist, f))) g.ids.forEach((id) => shellMain.add(String(id)));
const zoneMainFiles = new Set((zoneBuild.rootMainFiles ?? []).filter((f) => !isRuntime(f)).map((f) => path.basename(f)));
const mainGroups = chunks.filter((c) => zoneMainFiles.has(c.file) && !fs.existsSync(path.join(shellDist, "static", "chunks", c.file))).flatMap((c) => c.groups);
const lacking = new Set();
const pending = mainGroups.filter((g) => g.ids.some((id) => !shellMain.has(String(id)) || idMap[id] !== undefined));
while (pending.length) {
  const g = pending.pop();
  if (lacking.has(g)) continue;
  lacking.add(g);
  for (const dep of requiredBy(g)) {
    const d = groupOf.get(dep);
    if (d && !lacking.has(d) && mainGroups.includes(d) && d.ids.some((id) => !shellMain.has(String(id)) || idMap[id] !== undefined)) pending.push(d);
  }
}
const mainItems = lacking.size ? [...lacking].flatMap((g) => [...g.ids.map((id) => JSON.stringify(idMap[id] ?? id)), g.output ?? g.source]) : null;

/* 5. What the zone's code uses on its module context that the shell's runtime does not give it. Each build's runtime is
   trimmed to what that build uses, and a document has one runtime, the shell's. The shell's context is read from the
   runtime itself: run in a sandbox, with one module registered that records the context the runtime hands it (every
   name on it and its prototypes). The zone's uses come from each module's parse (module-code.cjs). */
function contextNames(source) {
  const element = () => ({ setAttribute() {}, getAttribute() { return null; }, remove() {}, addEventListener() {} });
  const document = {
    currentScript: { getAttribute: (name) => (name === "src" ? "/_next/static/chunks/turbopack-runtime.js" : null) },
    head: { appendChild() {} }, body: { appendChild() {} }, createElement: element, querySelectorAll: () => [], querySelector: () => null,
  };
  const quiet = { log() {}, warn() {}, error() {}, info() {}, debug() {} };
  const sandbox = { document, TURBOPACK: [], setTimeout, clearTimeout, queueMicrotask, URL, console: quiet, location: { origin: "http://localhost", href: "http://localhost/" } };
  sandbox.globalThis = sandbox.self = sandbox.window = sandbox;
  vm.runInNewContext(source, sandbox, { filename: "turbopack-runtime.js", timeout: 5000 });
  const PROBE = "__next_zones_context_probe__";
  return new Promise((resolve, reject) => {
    const timer = setTimeout(() => reject(new Error("next-zones: the shell's Turbopack runtime never ran a module in the sandbox (its format changed?)")), 5000);
    sandbox.TURBOPACK.push(["static/chunks/__next-zones-probe.js", PROBE, (context) => {
      clearTimeout(timer);
      const names = new Set();
      for (let o = context; o; o = Object.getPrototypeOf(o)) for (const name of Object.getOwnPropertyNames(o)) names.add(name);
      resolve(names);
    }]);
    sandbox.TURBOPACK.push(["static/chunks/__next-zones-probe-entry.js", { otherChunks: [], runtimeModuleIds: [PROBE] }]);
  });
}
const shellRuntimeFile = shellBuild.rootMainFiles?.find(isRuntime);

(async () => {
  let missingUsed = [];
  if (shellRuntimeFile) {
    const shellContext = await contextNames(fs.readFileSync(path.join(shellDist, shellRuntimeFile), "utf8"));
    const used = new Set(chunks.flatMap((c) => c.groups.flatMap((g) => [...read(g).runtimeMethods])));
    missingUsed = [...used].filter((m) => !shellContext.has(m)).sort();
  }

  /* The zone's modules as the browser will hold them after this install. */
  const zoneModules = {};
  for (const [id, h] of zoneIds) (zoneModules[idMap[id] ?? id] ??= []).push(h);
  saveReads();
  parentPort.postMessage({ idMap, chunkMap, mainItems, missingUsed, zoneModules, shellModules });
})().catch((error) => setImmediate(() => { throw error; }));
