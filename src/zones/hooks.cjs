"use strict";
/*
 * The hooks into Next, installed before Next loads. Each wraps one module of Next's as it is loaded (Module._load), or
 * one method of its server or cache. A hook matches the module loaded from the exact file next-contract.cjs located,
 * whatever path Next requires it by, so a moved import cannot leave it unhooked.
 * - load-manifest.external: the zones' app paths, prerendered routes and actions merged into the shell's manifests,
 *   and a zone route's own manifests read from the zone's build;
 * - image-optimizer: its internal image fetch reads a zone's static media and public files;
 * - instrumentation-globals.external and NextNodeServer: onRequestError dispatched to the shell and the zone;
 * - router-utils/filesystem: the router's appFiles also answer for the zones' routes, and the rule dispatchers go in;
 * - lru-cache: cached entries are dropped lazily by first path segment when a zone switches;
 * - NextNodeServer.getRouteMatchers: the server instance is kept, to swap its matchers;
 * - FileSystemCache.getFilePath: a zone's pages are read from, and revalidated into, its version's cache.
 */
const { keptLRU, segmentOf } = require("./kept-lru.cjs");
const Module = require("node:module");
const { AsyncLocalStorage } = require("node:async_hooks");
const fs = require("node:fs");
const path = require("node:path");
const crypto = require("node:crypto");
const { expect } = require("./next-contract.cjs");

function installHooks(ctx, { manifests, rules, assets, instrumentation, next }) {
  const wrapped = new Map();
  ctx.hookedModules = new Set();                       // checked by server.cjs once Next has started
  /*
   * A route's own manifests follow the build that renders it. Next loads a route's manifests (its client reference
   * manifest among them) in RouteModule.loadManifests, on the route module of the page bundle being rendered, and
   * Zones answers those loads from a zone's build. Answered from the zone's active version, a render that began under
   * v1 and reached loadManifests after a switch to v2 got v2's manifest for v1's code: "Could not find the module
   * …blog@1… in the React Client Manifest" (swaps under load). So each zone page bundle's route module is mapped to its
   * build when it is required, loadManifests runs with that build in its async context, and the loads follow it.
   */
  const renderBuild = new AsyncLocalStorage();
  const routeBuilds = new WeakMap();                      // a zone page bundle's route module → its build's folder
  const patchedRuntimes = new WeakSet();
  ctx.renderBuild = () => renderBuild.getStore();
  function bindRenders(request, parent, mod) {
    if (!mod || typeof mod !== "object") return;
    /* Next's compiled app-page / app-route runtime: its RouteModule.loadManifests, wrapped once. */
    if (typeof request === "string" && /next-server[\\/]app-(page|route)[^\\/]*\.runtime\.(prod|dev)\.js$/.test(request)) {
      for (const exported of Object.values(mod)) {
        if (typeof exported !== "function") continue;
        let proto = exported.prototype;
        while (proto && !Object.prototype.hasOwnProperty.call(proto, "loadManifests")) proto = Object.getPrototypeOf(proto);
        if (!proto || patchedRuntimes.has(proto)) continue;
        patchedRuntimes.add(proto);
        const loadManifests = proto.loadManifests;
        proto.loadManifests = function (...args) {
          const build = routeBuilds.get(this);
          return build ? renderBuild.run(build, () => loadManifests.apply(this, args)) : loadManifests.apply(this, args);
        };
      }
      return;
    }
    /* A zone's page or route bundle: its route module belongs to that build. */
    if (mod.routeModule && typeof mod.routeModule === "object" && ctx.zoneDists.size) {
      let file;
      try { file = Module._resolveFilename(request, parent); } catch { return; }
      for (const dist of ctx.zoneDists) if (file.startsWith(dist)) { routeBuilds.set(mod.routeModule, dist); break; }
    }
  }

  /* The module objects of the located files, once Next has loaded them: name → exports. */
  const loaded = {};
  const pending = new Map(Object.entries(next.files).map(([name, file]) => [file, name]));
  const original = Module._load;
  Module._load = function (request, parent, isMain) {
    const mod = original.apply(this, arguments);
    if (wrapped.has(mod)) return wrapped.get(mod);
    bindRenders(request, parent, mod);
    if (pending.size) for (const [file, name] of pending) if (Module._cache[file]?.exports === mod) { loaded[name] = mod; pending.delete(file); ctx.hookedModules.add(name); }
    let replacement = null;

    if (mod === loaded.loadManifest) {
      /* Its cache is a plain Map by path: a zone's manifests are recorded so collect.cjs can clear them. */
      ctx.clearManifest = (file) => mod.clearManifestCache(file);
      const remember = (file) => { if (ctx.zoneDists.size) ctx.loadedManifests.add(file); };
      replacement = { ...mod,
        /* A route's own manifests (its client reference manifest, its react-loadable manifest) are read from the
           zone's build; the shared ones (routes, build, fonts) stay the shell's, with the zones merged in. */
        loadManifestFromRelativePath(args) {
          if (args?.manifest === "prerender-manifest.json") return manifests.withZonePrerenders(mod.loadManifestFromRelativePath(args));
          if (args?.manifest === "server/server-reference-manifest.json") return manifests.withZoneActions(mod.loadManifestFromRelativePath(args));
          if (typeof args?.manifest === "string" && args.manifest.startsWith("server/app/")) {
            /* The build of the render asking (above), else the zones' active versions. */
            const build = renderBuild.getStore();
            /* `build` is one of the two names stage.cjs gives a build's folder (as given, and its real path). */
            const real = (dir) => { try { return fs.realpathSync(dir) + path.sep; } catch { return null; } };
            const staged = build ? [...(ctx.staged?.values() ?? [])].find((z) => build === path.resolve(z.dist) + path.sep || build === real(z.dist)) : null;
            for (const z of staged ? [staged] : ctx.zones.values()) {
              for (const page of Object.keys(z.appPaths)) {
                if (!args.manifest.startsWith(`server/app${page}`)) continue;
                remember(path.join(z.dist, args.manifest));
                const value = mod.loadManifestFromRelativePath({ ...args, projectDir: z.dist, distDir: "." });
                return args.manifest.endsWith("_client-reference-manifest.js") ? manifests.withZoneMainChunks(value, z) : value;
              }
            }
          }
          return mod.loadManifestFromRelativePath(args);
        },
        loadManifest(p, ...rest) {
          const value = mod.loadManifest(p, ...rest);
          if (p.endsWith(`${path.sep}prerender-manifest.json`)) return manifests.withZonePrerenders(value);
          if (p.endsWith(`${path.sep}server${path.sep}app-paths-manifest.json`)) return manifests.withZoneAppPaths(value);
          return value;
        },
      };
    } else if (mod === loaded.imageOptimizer) {
      replacement = { ...mod, async fetchInternalImage(href, ...rest) {
        const asset = assets.zoneAsset(new URL(href, "http://x").pathname);
        if (!asset) return mod.fetchInternalImage(href, ...rest);
        const buffer = await fs.promises.readFile(asset.file);
        return { buffer, contentType: asset.contentType, cacheControl: asset.cacheControl,
          etag: crypto.createHash("sha256").update(buffer).digest("base64url") };
      } };
    } else if (mod === loaded.instrumentationGlobals) {
      replacement = { ...mod, instrumentationOnRequestError(projectDir, distDir, err, req, context) {
        return instrumentation.dispatchRequestError(() => mod.instrumentationOnRequestError(projectDir, distDir, err, req, context), err, req, context);
      } };
    } else if (mod === loaded.filesystem) {
      replacement = { ...mod, async setupFsCheck(opts) {
        const checker = await mod.setupFsCheck(opts);
        expect(checker?.appFiles instanceof Set && Array.isArray(checker.dynamicRoutes), "the router's fs checker has appFiles (a Set) and dynamicRoutes (an array)");
        expect(Array.isArray(checker.headers) && Array.isArray(checker.redirects) && ["beforeFiles", "afterFiles", "fallback"].every((k) => Array.isArray(checker.rewrites?.[k])),
          "the router's fs checker has headers, redirects and rewrites { beforeFiles, afterFiles, fallback } as arrays");
        /* The router only asks appFiles.has(): it also answers for the zones' routes, a set the switch replaces whole. */
        const ownHas = Set.prototype.has;
        checker.appFiles.has = (route) => ownHas.call(checker.appFiles, route) || ctx.zoneAppFiles.has(route);
        rules.attach(checker);
        ctx.fsCheckers.add(checker);
        return checker;
      } };
    } else if (mod === loaded.lruCache) {
      /* Cached entries under a swapped zone's segments read as absent (kept-lru.cjs). */
      const KeptLRU = keptLRU(mod.LRUCache, ctx.segmentGeneration, (lru) => ctx.lrus.add(lru));
      replacement = { ...mod, LRUCache: KeptLRU };
    }

    if (replacement) wrapped.set(mod, replacement);
    return replacement ?? mod;
  };

  const NextNodeServer = ctx.requireNext(next.files.nextServer).default;
  const onRequestError = NextNodeServer.prototype.instrumentationOnRequestError;
  NextNodeServer.prototype.instrumentationOnRequestError = function (err, req, context) {
    return instrumentation.dispatchRequestError(() => onRequestError.call(this, err, req, context), err, { path: req?.url }, context);
  };
  const getRouteMatchers = NextNodeServer.prototype.getRouteMatchers;
  NextNodeServer.prototype.getRouteMatchers = function () {
    ctx.servers.add(this);
    const matchers = getRouteMatchers.call(this);
    expect(Array.isArray(matchers?.providers) && Array.isArray(matchers?.matchers?.static) && Array.isArray(matchers?.matchers?.dynamic),
      "the server's route matchers have providers and matchers { static, dynamic } as arrays");
    return matchers;
  };

  /* The incremental cache's files. The page runtime is bundled with its own FileSystemCache, out of reach, so Zones
     installs Next's own (from dist) through the public cacheHandler option (zones-cache-handler.cjs). */
  const FileSystemCache = ctx.requireNext(next.files.fileSystemCache).default;
  const getFilePath = FileSystemCache.prototype.getFilePath;
  globalThis.__NEXT_ZONES_CACHE_HANDLER__ = FileSystemCache;
  /* A key of a zone's page or route handler: under its mount (zones-cache-handler.cjs routes by it). */
  globalThis.__NEXT_ZONES_IS_ZONE_KEY__ = (key) => typeof key === "string" && ctx.segmentZone.has(segmentOf(key));
  FileSystemCache.prototype.getFilePath = function (key, kind) {
    if (kind === "APP_PAGE" || kind === "APP_ROUTE") {
      const zone = ctx.segmentZone.get(segmentOf(key));
      if (zone) return path.join(zone.cacheDir, "app", key);
    }
    return getFilePath.call(this, key, kind);
  };
}

module.exports = { installHooks };
