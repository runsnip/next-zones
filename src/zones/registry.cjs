"use strict";
/*
 * One module registry for every Turbopack runtime.
 *
 * Each build's server runtime ([turbopack]_runtime.js) keeps its own moduleCache, so a module shared by the shell and
 * the zones (a layout, a UI package, a DB pool) would run once per build. As each runtime is compiled, its cache is
 * given a process-wide registry behind it, keyed by module id AND the sha1 of the factory's source: a module is shared
 * only when it is byte-identical, so two versions of a zone, whose modules share ids, never mix.
 *
 * A module whose exports another module's factory defines (Turbopack's esmExport with an id) is never shared: the
 * defining factory may differ between builds, and it writes into exports the first build has already sealed.
 */
const Module = require("node:module");
const crypto = require("node:crypto");

const RUNTIME_CACHE = "const moduleFactories = new Map();\nconst moduleCache = Object.create(null);";
const OVERWRITTEN = "function getOverwrittenModule(moduleCache, id) {\n    let module = moduleCache[id];";

function installModuleRegistry(ctx) {
  const registry = new Map();                          // `${id}:${sha1}` → module
  const factoryKeys = new WeakMap();                   // factory → `${id}:${sha1}`
  const hoistedKeys = new Set();
  const owners = new Map();                            // `${id}:${sha1}` → the runtime file that instantiated it
  const stats = { shared: 0, instantiated: 0 };
  ctx.registry = {
    size: () => registry.size,
    stats,
    /** Whether a module the registry shares was instantiated by a runtime under this build (collect.cjs, D9). */
    holds: (dir) => { for (const file of owners.values()) if (file.startsWith(dir)) return true; return false; },
  };
  const OWN = Symbol("next-zones own cache");
  const BORROWED = Symbol("next-zones borrowed ids");
  const FACTORIES = Symbol("next-zones factories");

  function keyOf(factories, id) {
    const factory = factories.get(id) ?? factories.get(Number(id));
    if (!factory) return null;
    let key = factoryKeys.get(factory);
    if (!key) {
      key = `${id}:${crypto.createHash("sha1").update(factory.toString()).digest("base64")}`;
      factoryKeys.set(factory, key);
    }
    return key;
  }

  globalThis.__NEXT_ZONES_OWN_MODULE__ = (cache, id) => {
    const key = keyOf(cache[FACTORIES], id);
    if (key) { hoistedKeys.add(key); registry.delete(key); owners.delete(key); }
    const own = cache[OWN];
    if (cache[BORROWED].has(String(id))) { cache[BORROWED].delete(String(id)); delete own[id]; }
    return own[id];
  };
  globalThis.__NEXT_ZONES_MODULE_CACHE__ = (factories, runtimeFile = "") => {
    const own = Object.create(null);
    const borrowed = new Set();
    return new Proxy(own, {
      get(target, id) {
        if (id === OWN) return target;
        if (id === BORROWED) return borrowed;
        if (id === FACTORIES) return factories;
        if (typeof id !== "string") return target[id];
        const mine = target[id];
        if (mine !== undefined) return mine;
        const key = keyOf(factories, id);
        if (!key || hoistedKeys.has(key)) return undefined;
        const shared = registry.get(key);
        if (shared) { target[id] = shared; borrowed.add(id); stats.shared++; }
        return shared;
      },
      set(target, id, module) {
        target[id] = module;
        const key = typeof id === "string" && keyOf(factories, id);
        if (key && !hoistedKeys.has(key) && !registry.has(key)) { registry.set(key, module); owners.set(key, runtimeFile); stats.instantiated++; }
        return true;
      },
    });
  };

  if (ctx.options.moduleRegistry === false) return;
  const compile = Module.prototype._compile;
  Module.prototype._compile = function (content, filename) {
    if (filename.endsWith("[turbopack]_runtime.js")) {
      if (!content.includes(RUNTIME_CACHE) || !content.includes(OVERWRITTEN)) {
        throw new Error(`next-zones: unknown Turbopack runtime layout in ${filename} (is this Next version supported?)`);
      }
      content = content
        .replace(RUNTIME_CACHE, "const moduleFactories = new Map();\nconst moduleCache = globalThis.__NEXT_ZONES_MODULE_CACHE__(moduleFactories, __filename);")
        .replace(OVERWRITTEN, "function getOverwrittenModule(moduleCache, id) {\n    let module = globalThis.__NEXT_ZONES_OWN_MODULE__(moduleCache, id);");
    }
    return compile.call(this, content, filename);
  };
}

module.exports = { installModuleRegistry };
