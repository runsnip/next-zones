"use strict";
/*
 * Zones' HTTP layer, in front of the shell's Next request handler:
 * - the URLs Zones serves of its own, only those declared (endpoints.cjs);
 * - a zone's static files and public/ files, before Next sees the request;
 * - everything else to Next.
 */
const fs = require("node:fs");
const path = require("node:path");
const { expect } = require("./next-contract.cjs");
const { pathToFileURL } = require("node:url");
const { createEndpoints } = require("./endpoints.cjs");
const { missingBuildOptions } = require("../build-options.cjs");

/* A full garbage collection, for memory measurements: Node's gc() when started with --expose-gc, else one obtained
   by turning the flag on at run time (a fresh context then sees gc). */
/* A full collection: rounds until the heap stops shrinking, the event loop turning between them (a
   FinalizationRegistry's callbacks run there). What it reports is live, V8's compilation cache included: only a
   last-resort collection (reclaim.cjs, ?gc=last) clears that. */
async function fullGc() {
  let gc = globalThis.gc;
  if (typeof gc !== "function") { require("node:v8").setFlagsFromString("--expose-gc"); gc = require("node:vm").runInNewContext("gc"); }
  let before = Infinity;
  for (let round = 0; round < 10; round++) {
    gc();
    await new Promise((resolve) => setImmediate(resolve));
    const used = process.memoryUsage().heapUsed;
    if (used > before * 0.99) break;
    before = used;
  }
}

const ZONES_HANDLER = path.join(__dirname, "zones-cache-handler.cjs");

function createServer(ctx, { assets, installer, bench, collector }) {
  const next = ctx.requireNext("next");
  let app = null, handle = null;

  /* What is loaded: the registry, the Turbopack runtimes, memory (and what the checks' fixtures count). */
  async function debugInfo(url) {
    /* ?gc=1: a full collection (what is live); ?gc=last: a reclaim now (reclaim.cjs). */
    if (url.searchParams.get("gc") === "last") ctx.reclaim.now();
    else if (url.searchParams.get("gc")) await fullGc();
    /* A heap snapshot, for tools/heap-retainers.mjs. */
    if (url.searchParams.get("heap")) return { snapshot: require("node:v8").writeHeapSnapshot(path.join(require("node:os").tmpdir(), `next-zones-${process.pid}-${Date.now()}.heapsnapshot`)) };
    const loaded = Object.keys(require.cache);
    return {
      sharedServerEvals: globalThis.__sharedServerEvals ?? 0,
      reclaimed: ctx.reclaimed,
      /* Next's LRUs as Zones keeps them (kept-lru.cjs): entries, and the generations they remember (D3). */
      lrus: [...ctx.lrus].map((l) => ({ entries: l.size, born: l.born?.size ?? 0, totalSize: l.currentSize ?? null, maxSize: l.maxSize })),
      instrumentation: globalThis.__instrumentationLog ?? [],
      registry: { modules: ctx.registry?.size() ?? 0, ...(ctx.registry?.stats ?? {}) },
      heapSpacesMB: Object.fromEntries(require("node:v8").getHeapSpaceStatistics().map((s) => [s.space_name, +(s.space_used_size / 1048576).toFixed(1)])),
      runtimes: loaded.filter((f) => f.endsWith("[turbopack]_runtime.js")).map((f) => path.relative(process.cwd(), f)),
      serverChunksLoaded: loaded.filter((f) => f.includes(`${path.sep}chunks${path.sep}`)).length,
      rssMB: +(process.memoryUsage().rss / 1048576).toFixed(1),
      heapUsedMB: +(process.memoryUsage().heapUsed / 1048576).toFixed(1),
      /* Where memory outside the JS heap goes (D14): V8's own (code, malloc, contexts) and Node's (buffers). */
      memoryMB: (() => {
        const v8 = require("node:v8"), mb = (n) => +(n / 1048576).toFixed(1);
        const u = process.memoryUsage(), h = v8.getHeapStatistics(), c = v8.getHeapCodeStatistics();
        return {
          heapTotal: mb(u.heapTotal), heapPhysical: mb(h.total_physical_size), external: mb(u.external), arrayBuffers: mb(u.arrayBuffers),
          malloced: mb(h.malloced_memory), mallocedPeak: mb(h.peak_malloced_memory), code: mb(c.code_and_metadata_size),
          bytecode: mb(c.bytecode_and_metadata_size), nativeContexts: h.number_of_native_contexts, detachedContexts: h.number_of_detached_contexts,
        };
      })(),
    };
  }
  const endpoints = createEndpoints(ctx, { installer, collector, bench, debugInfo });

  /* Each request in a scope of its own (loaders.cjs: the manifests Next registers per route). */
  async function handleRequest(req, res) {
    return ctx.requestScope ? ctx.requestScope(() => handleScoped(req, res)) : handleScoped(req, res);
  }
  let shellBuildId = null;
  async function handleScoped(req, res) {
    ctx.reclaim?.track(req, res);
    const url = new URL(req.url, "http://x");
    ctx.metrics?.track(req, res, url.pathname);
    if (await endpoints.handle(req, res, url)) return;
    const asset = assets.zoneAsset(url.pathname);
    if (asset && (req.method === "GET" || req.method === "HEAD")) {
      res.writeHead(200, { "content-type": asset.contentType, "cache-control": asset.cacheControl });
      if (req.method === "HEAD") return res.end();
      fs.createReadStream(asset.file).pipe(res);
      return;
    }
    /* A Pages Router page of a zone renders with its zone's build id, so its client asks for /_next/data/<that id>/…:
       Next's router knows the shell's only, so the request is read as the shell's (the page then renders with its
       zone's id again: hooks.cjs). */
    if (ctx.zoneBuildIds.size && url.pathname.startsWith("/_next/data/")) {
      const at = url.pathname.indexOf("/", "/_next/data/".length);
      const id = at === -1 ? "" : url.pathname.slice("/_next/data/".length, at);
      if (ctx.zoneBuildIds.has(id)) {
        shellBuildId ??= fs.readFileSync(path.join(ctx.shell, ".next", "BUILD_ID"), "utf8").trim();
        req.url = `/_next/data/${shellBuildId}${url.pathname.slice(at)}${url.search}`;
      }
    }
    return handle(req, res);
  }

  /* Prepares the shell's Next server: the shell must be the zone mounted at "/", and the zones' cache handler takes
     the cacheHandler slot, keeping the shell's own (if any) for every key but the zones'. */
  async function prepare(port, hostname) {
    const { readZone, normalizeEndpoints } = await import(pathToFileURL(path.join(__dirname, "..", "config.mjs")).href);
    /* The shell's declaration: from its next.config, or, in a standalone folder (no next.config there), from what
       next-zones build recorded (standalone.mjs). */
    const recorded = path.join(ctx.shell, ".next", "zones-shell.json");
    const shell = fs.existsSync(recorded) ? JSON.parse(fs.readFileSync(recorded, "utf8")) : await readZone(ctx.shell);
    if (shell?.mount !== "/") throw new Error(`next-zones: the shell (${ctx.shell}) must use zoneConfig({ mount: "/" }), got ${JSON.stringify(shell)}`);
    /* The metrics store: the shell's declaration, or createZones({ metrics }) over it. */
    if (ctx.options.metrics ?? shell.metrics) ctx.metrics = require("./zone-metrics.cjs").installZoneMetrics(ctx);
    /* The URLs Zones serves of its own: createZones({ endpoints }) over the shell's declaration; none unless declared. */
    ctx.endpoints = ctx.options.endpoints !== undefined ? normalizeEndpoints(ctx.options.endpoints, "createZones") : (shell.endpoints ?? null);
    const shellRoutes = () => Object.values(JSON.parse(fs.readFileSync(path.join(ctx.shell, ".next", "app-path-routes-manifest.json"), "utf8")));
    if (ctx.endpoints) {
      const base = ctx.endpoints.base;
      const taken = shellRoutes().filter((r) => r === base || r.startsWith(`${base}/`));
      if (taken.length) throw new Error(`next-zones: the endpoints' base ${base} is the shell's: ${taken.join(", ")} (choose another endpoints.base)`);
    }
    /* Zones' MCP server: createZones({ mcp }) over the shell's declaration (false: none). A standalone folder records
       that the declaration holds code, which only the shell's next.config (copied in) can give back. */
    let mcp = ctx.options.mcp !== undefined ? ctx.options.mcp : shell.mcp;
    if (mcp?.fromConfig) mcp = (await readZone(ctx.shell))?.mcp;
    if (mcp) {
      const { createMcp } = require("./mcp.cjs");
      ctx.mcp = createMcp(ctx, mcp, { status: endpoints.status, images: endpoints.list, pull: (zone, version) => installer.pullVersion(zone, version, { via: "ping" }),
        install: (zone, version) => installer.installVersion(zone, version, { via: "ping" }), prune: (options) => installer.prune(options) });
      const taken = shellRoutes().filter((r) => r === ctx.mcp.path || ctx.mcp.path.startsWith(`${r === "/" ? "" : r}/`) && r !== "/" && !/\[/.test(r));
      if (taken.includes(ctx.mcp.path)) throw new Error(`next-zones: the MCP server's path ${ctx.mcp.path} is the shell's (choose another Mcp({ path }))`);
    }
    /* The shell must be built for Zones like the zones (build-options.cjs), or the modules they share load twice. What
       counts is the config its build recorded: at run time next.config is loaded again, outside a build for Zones. */
    const built = JSON.parse(fs.readFileSync(path.join(ctx.shell, ".next", "required-server-files.json"), "utf8")).config;
    const missing = missingBuildOptions(built.experimental);
    if (missing.length) throw new Error(`next-zones: the shell (${ctx.shell}) was not built for Zones (it lacks ${missing.join(", ")}): build it with next-zones build`);
    app = next({ dev: false, dir: ctx.shell, port, hostname });
    handle = app.getRequestHandler();
    await app.prepare();
    /* The hooks the switch needs took hold as Next started: its server, its router's fs checker, its manifests. */
    expect(ctx.servers.size > 0, "NextNodeServer.getRouteMatchers (or, from Next 16.4, getAppPathRoutes) was not called as the server started");
    expect(ctx.fsCheckers.size > 0, "the router's setupFsCheck was not called as the server started");
    for (const name of ["loadManifest", "filesystem", "lruCache"]) expect(ctx.hookedModules?.has(name), `${name} was not loaded through Zones' hooks`);
    for (const server of ctx.servers) {
      /* The shell's own cacheHandler keeps every key but the zones' (zones-cache-handler.cjs). */
      const own = server.nextConfig.cacheHandler;
      if (own && own !== ZONES_HANDLER) {
        const file = path.isAbsolute(own) ? own : path.resolve(ctx.shell, own);
        const loaded = require(file);
        globalThis.__NEXT_ZONES_SHELL_CACHE_HANDLER__ = loaded?.default ?? loaded;
        if (typeof globalThis.__NEXT_ZONES_SHELL_CACHE_HANDLER__ !== "function") throw new Error(`next-zones: the shell's cacheHandler (${own}) does not export a class`);
      }
      server.nextConfig.cacheHandler = ZONES_HANDLER;
    }
  }

  return { handleRequest, prepare, close: () => app?.close?.() };
}

module.exports = { createServer };
