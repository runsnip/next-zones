"use strict";
/*
 * Collecting old zone images. A switch leaves the replaced version in place, so it can be rolled back to at once.
 * collect() keeps, per zone, the active version and the `keep` versions installed just before it; for every other
 * version it has staged, it:
 * - removes its disk cache (seeded pages, ISR writes, main chunk, analysis), unless a kept version shares it, even
 *   when its code stays;
 * - unloads its server code from Node's require cache, and drops what Next's LRUs hold under its build;
 * - stops resolving its externals.
 * A build whose modules the registry still shares with others is kept and reported as pinned (debt D9): those shared
 * instances belong to it. The store's builds are never removed: the store is the deploy's.
 */
const Module = require("node:module");
const fs = require("node:fs");
const path = require("node:path");

function createCollector(ctx) {
  ctx.history = new Map();                             // zone → versions in install order, most recent last
  ctx.staged = new Map();                              // `${zone}@${version}` → its staged build

  /** Records an installed version (install.cjs). */
  function record(staged) {
    const list = (ctx.history.get(staged.name) ?? []).filter((v) => v !== staged.version);
    list.push(staged.version);
    ctx.history.set(staged.name, list);
    ctx.staged.set(`${staged.name}@${staged.version}`, staged);
  }

  /* `only` (a "zone@version"): that version alone, rollback window or not, unless it is active (deleting it). */
  async function collect({ keep = 2, only = null } = {}) {
    const removed = [], pinned = [];
    const kept = new Set();
    for (const [name, versions] of ctx.history) {
      const active = ctx.zones.get(name)?.version;
      /* slice(-0) is the whole list: keep 0 keeps none. */
      const previous = keep > 0 && !only ? versions.filter((v) => v !== active).slice(-keep) : [];
      for (const v of [active, ...previous]) if (v !== undefined) kept.add(`${name}@${v}`);
    }
    const keptBuilds = [...kept].map((k) => ctx.staged.get(k)).filter(Boolean);
    for (const [key, staged] of [...ctx.staged]) {
      if (kept.has(key) || (only && key !== only)) continue;
      const dirs = [path.resolve(staged.dist) + path.sep, fs.realpathSync(staged.dist) + path.sep];
      /* Its disk cache, unless a kept version shares it (same build ids): pinned or not, nothing reads it once the
         version is neither active nor kept. */
      if (!staged.cacheCollected) {
        for (const file of [staged.cacheDir, ...(staged.analysisFiles ?? [])]) {
          if (!file || keptBuilds.some((k) => k.cacheDir === file || (k.analysisFiles ?? []).includes(file))) continue;
          await fs.promises.rm(file, { recursive: true, force: true });
        }
        staged.cacheCollected = true;
      }
      /* Its code stays while the registry shares modules it instantiated (D9): they live in its runtime. */
      if (dirs.some((d) => ctx.registry?.holds(d))) { pinned.push(key); continue; }
      /* Its server code: out of Node's require cache, and out of every remaining module's children (Node keeps each
         module a parent required there, which would hold the whole runtime). Then what Next's caches keep under it. */
      const unloaded = new Set();
      for (const file of Object.keys(Module._cache)) {
        if (dirs.some((d) => file.startsWith(d))) { unloaded.add(Module._cache[file]); delete Module._cache[file]; }
      }
      if (unloaded.size) for (const mod of Object.values(Module._cache)) if (mod?.children?.some((c) => unloaded.has(c))) mod.children = mod.children.filter((c) => !unloaded.has(c));
      for (const file of [...ctx.loadedManifests]) {
        if (dirs.some((d) => file.startsWith(d))) { ctx.clearManifest?.(file); ctx.loadedManifests.delete(file); }
      }
      for (const lru of ctx.lrus) {
        for (const cacheKey of [...(lru.cache?.keys?.() ?? [])]) if (typeof cacheKey === "string" && dirs.some((d) => cacheKey.startsWith(d))) lru.remove(cacheKey);
      }
      /* Node's resolution cache: request\0paths → a file of the build. */
      for (const [k, file] of Object.entries(Module._pathCache ?? {})) if (dirs.some((d) => file.startsWith(d) || k.includes(d))) delete Module._pathCache[k];
      for (const d of dirs) ctx.zoneDists.delete(d);
      ctx.staged.delete(key);
      const [name, version] = key.split("@");
      ctx.history.set(name, (ctx.history.get(name) ?? []).filter((v) => v !== version));
      removed.push(key);
    }
    /* What V8 keeps of the unloaded code (its compilation cache, the heap's grown pages) goes back once idle. */
    if (removed.length) ctx.reclaim?.soon();
    return { removed, pinned, kept: [...kept] };
  }

  /** Whether collect() would keep "zone@version" pinned: the registry shares modules it instantiated (D9). */
  function holds(key) {
    const staged = ctx.staged.get(key);
    if (!staged) return false;
    const dirs = [path.resolve(staged.dist) + path.sep, fs.realpathSync(staged.dist) + path.sep];
    return dirs.some((d) => ctx.registry?.holds(d));
  }

  return { record, collect, holds };
}

module.exports = { createCollector };
