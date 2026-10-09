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

/* The digits of a module id the registry keys by (keyOf): fewer than the narrowest build's ids, so ids of any width
   that end alike key alike; with the code's hash in the key, sharing takes the same module. */
const ID_DIGITS = 4;
/* The two runtime layouts: up to Next 16.3 the cache is a plain object, from 16.4 a Map. */
const LAYOUTS = [
  { kind: "object", cache: "const moduleFactories = new Map();\nconst moduleCache = Object.create(null);", overwritten: "function getOverwrittenModule(moduleCache, id) {\n    let module = moduleCache[id];" },
  { kind: "map", cache: "const moduleFactories = new Map();\nconst moduleCache = new Map();", overwritten: "function getOverwrittenModule(moduleCache, id) {\n    let module = moduleCache.get(id);" },
];

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

  /* A module's key is what it is, its dependencies included (a Merkle hash), not only its own code: a module's code names
     what it requires by id, and two builds can give one id to different modules (a zone's own module in two versions
     built from one path, a shared module over another version of what it imports). Sharing on the code alone handed
     a build another build's dependencies. As on the client (zone-client.cjs): its own code's hash, then the keys of
     what it requires, in order; a cycle is one component, keyed by its members. Turbopack cuts a build's ids to as
     many digits as its module count needs, so one module has a longer id in a bigger build (912598, 12598; leading
     zeros dropped): ids and long numbers are taken modulo 10^ID_DIGITS. */
  const low = (n) => String(Number(n) % 10 ** ID_DIGITS);
  const sha = (text) => crypto.createHash("sha1").update(text).digest("base64");
  const own = new WeakMap();                           // factory → { hash, deps: the ids it requires that this runtime has }
  function ownOf(factories, factory) {
    let o = own.get(factory);
    if (!o) {
      const text = factory.toString();
      const deps = [];
      for (const m of text.matchAll(/\b\d{3,}\b/g)) if (factories.has(m[0]) || factories.has(Number(m[0]))) deps.push(m[0]);
      /* A factory written in a strict scope (Next 16.4's nested strict array) has no directive of its own: the same
         module either way. */
      const body = text.replace(/^((?:\([^)]*\)|[\w$]+)\s*=>\s*\{)\s*"use strict";?/, "$1");
      o = { hash: sha(body.replace(/\b\d{5,}\b/g, low)), deps };
      own.set(factory, o);
    }
    return o;
  }
  const factoryOf = (factories, id) => factories.get(id) ?? factories.get(Number(id));
  function keyOf(factories, id) {
    const factory = factoryOf(factories, id);
    if (!factory) return null;
    const known = factoryKeys.get(factory);
    if (known) return known;
    /* Tarjan's components over what is not keyed yet, iteratively; each finished after what it requires. */
    let counter = 0;
    const index = new Map(), lowLink = new Map(), stack = [], onStack = new Set();
    const work = [[String(id), 0]];
    while (work.length) {
      const frame = work[work.length - 1];
      const [v, i] = frame;
      const f = factoryOf(factories, v);
      if (i === 0) { index.set(v, counter); lowLink.set(v, counter); counter++; stack.push(v); onStack.add(v); }
      const deps = ownOf(factories, f).deps;
      if (i < deps.length) {
        frame[1]++;
        const d = String(deps[i]), df = factoryOf(factories, d);
        if (!df || factoryKeys.has(df)) continue;
        if (!index.has(d)) work.push([d, 0]);
        else if (onStack.has(d)) lowLink.set(v, Math.min(lowLink.get(v), index.get(d)));
        continue;
      }
      work.pop();
      if (work.length) { const parent = work[work.length - 1][0]; lowLink.set(parent, Math.min(lowLink.get(parent), lowLink.get(v))); }
      if (lowLink.get(v) !== index.get(v)) continue;
      const members = [];
      let m;
      do { m = stack.pop(); onStack.delete(m); members.push(m); } while (m !== v);
      const inside = new Set(members);
      /* What each member requires outside the component, by key (or by its low id when this runtime lacks it). */
      const outside = (x) => ownOf(factories, factoryOf(factories, x)).deps.map((d) => {
        if (inside.has(String(d))) return "";
        const df = factoryOf(factories, d);
        return df ? factoryKeys.get(df) : `missing:${low(d)}`;
      }).join(",");
      const component = sha(members.map((x) => `${ownOf(factories, factoryOf(factories, x)).hash}(${outside(x)})`).sort().join("|"));
      for (const x of members) {
        const xf = factoryOf(factories, x);
        const key = `${/^\d+$/.test(x) ? low(x) : x}:${sha(`${component}:${ownOf(factories, xf).hash}(${outside(x)})`)}`;
        factoryKeys.set(xf, key);
      }
    }
    return factoryKeys.get(factory) ?? null;
  }

  globalThis.__NEXT_ZONES_OWN_MODULE__ = (cache, id) => {
    const key = keyOf(cache[FACTORIES], id);
    if (key) { hoistedKeys.add(key); registry.delete(key); owners.delete(key); }
    const own = cache[OWN];
    if (own instanceof Map) {
      if (cache[BORROWED].has(String(id))) { cache[BORROWED].delete(String(id)); own.delete(id); }
      return own.get(id);
    }
    if (cache[BORROWED].has(String(id))) { cache[BORROWED].delete(String(id)); delete own[id]; }
    return own[id];
  };
  /* The Map layout (Next 16.4 on): the same lookups as the object layout's Proxy, through get and set. */
  class SharedMap extends Map {
    constructor(factories, runtimeFile) {
      super();
      this[OWN] = this;
      this[BORROWED] = new Set();
      this[FACTORIES] = factories;
      this.runtimeFile = runtimeFile;
    }
    get(id) {
      const mine = super.get(id);
      if (mine !== undefined) return mine;
      const key = keyOf(this[FACTORIES], id);
      if (!key || hoistedKeys.has(key)) return undefined;
      const shared = registry.get(key);
      if (shared) { super.set(id, shared); this[BORROWED].add(String(id)); stats.shared++; }
      return shared;
    }
    has(id) { return this.get(id) !== undefined; }
    set(id, module) {
      super.set(id, module);
      const key = keyOf(this[FACTORIES], id);
      if (key && !hoistedKeys.has(key) && !registry.has(key)) { registry.set(key, module); owners.set(key, this.runtimeFile); stats.instantiated++; }
      return this;
    }
  }
  globalThis.__NEXT_ZONES_MODULE_MAP__ = (factories, runtimeFile = "") => new SharedMap(factories, runtimeFile);
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
      const layout = LAYOUTS.find((l) => content.includes(l.cache) && content.includes(l.overwritten));
      if (!layout) throw new Error(`next-zones: unknown Turbopack runtime layout in ${filename} (is this Next version supported?)`);
      const create = layout.kind === "map" ? "__NEXT_ZONES_MODULE_MAP__" : "__NEXT_ZONES_MODULE_CACHE__";
      content = content
        .replace(layout.cache, `const moduleFactories = new Map();\nconst moduleCache = globalThis.${create}(moduleFactories, __filename);`)
        .replace(layout.overwritten, "function getOverwrittenModule(moduleCache, id) {\n    let module = globalThis.__NEXT_ZONES_OWN_MODULE__(moduleCache, id);");
    }
    return compile.call(this, content, filename);
  };
}

module.exports = { installModuleRegistry };
