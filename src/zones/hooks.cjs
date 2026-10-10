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
 * - NextNodeServer.getRouteMatchers (up to Next 16.3) or getAppPathRoutes (16.4 on, which has no route matchers and
 *   matches from the server's appPathsManifest and appPathRoutes): the server instance is kept, for the switch;
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
  /* A Pages Router page renders whole in its zone's build (its own document, runtime and chunks): the manifests its
     route module loads that describe the build (its id, its build manifest…) are the zone's. */
  const pagesBuild = new AsyncLocalStorage();
  const PAGES_OWN = /^(BUILD_ID|build-manifest\.json|fallback-build-manifest\.json|dynamic-css-manifest(\.json)?|server\/next-font-manifest\.json|server\/subresource-integrity-manifest\.json|server\/pages\/.*)$/;
  const shellPagesManifest = path.join(ctx.shell, ".next", "server", "pages-manifest.json");
  const routeBuilds = new WeakMap();                      // a zone page bundle's route module → its build's folder
  const bound = new WeakSet();                            // the bundles (or their promises) already looked at
  const patchedRuntimes = new WeakSet();
  ctx.renderBuild = () => renderBuild.getStore();
  function bindRenders(request, parent, mod) {
    if (!mod || typeof mod !== "object") return;
    /* Next's compiled app-page / app-route runtime: its RouteModule.loadManifests, wrapped once. */
    if (typeof request === "string" && /next-server[\\/](app-(page|route)|pages(-api)?)[^\\/]*\.runtime\.(prod|dev)\.js$/.test(request)) {
      for (const exported of Object.values(mod)) {
        if (typeof exported !== "function") continue;
        let proto = exported.prototype;
        while (proto && !Object.prototype.hasOwnProperty.call(proto, "loadManifests")) proto = Object.getPrototypeOf(proto);
        if (!proto || patchedRuntimes.has(proto)) continue;
        patchedRuntimes.add(proto);
        const loadManifests = proto.loadManifests;
        proto.loadManifests = function (...args) {
          const build = routeBuilds.get(this);
          if (!build) return loadManifests.apply(this, args);
          const pages = this.definition?.kind === "PAGES" || this.definition?.kind === "PAGES_API";
          return renderBuild.run(build, () => (pages ? pagesBuild.run(build, () => loadManifests.apply(this, args)) : loadManifests.apply(this, args)));
        };
      }
      return;
    }
    /* A zone's page or route bundle: its route module belongs to that build. A bundle that imports an ES module from
       outside (an async module) is a promise of its exports. */
    if (!ctx.zoneDists.size) return;
    const thenable = typeof mod.then === "function";
    if (!thenable && !(mod.routeModule && typeof mod.routeModule === "object")) return;
    /* Next requires a page's bundle on every render: one already bound is not resolved again. */
    if (bound.has(mod)) return;
    bound.add(mod);
    let file;
    try { file = Module._resolveFilename(request, parent); } catch { return; }
    let build = null;
    for (const dist of ctx.zoneDists) if (file.startsWith(dist)) { build = dist; break; }
    if (!build) return;
    if (!thenable) routeBuilds.set(mod.routeModule, build);
    else mod.then((exports) => { if (exports?.routeModule && typeof exports.routeModule === "object") routeBuilds.set(exports.routeModule, build); }, () => {});
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
      /* A route's own manifest (its client reference manifest, its react-loadable manifest) read from the zone's build:
         the build of the render asking (bindRenders), else the zones' active versions. */
      const fromZone = (load, args) => {
        const pages = pagesBuild.getStore();
        if (pages && typeof args?.manifest === "string" && PAGES_OWN.test(args.manifest)) {
          remember(path.join(pages, args.manifest));
          return load({ ...args, projectDir: pages, distDir: "." });
        }
        if (typeof args?.manifest === "string" && args.manifest.startsWith("server/app/")) {
          const build = renderBuild.getStore();
          /* `build` is one of the two names stage.cjs gives a build's folder (as given, and its real path). */
          const real = (dir) => { try { return fs.realpathSync(dir) + path.sep; } catch { return null; } };
          const staged = build ? [...(ctx.staged?.values() ?? [])].find((z) => build === path.resolve(z.dist) + path.sep || build === real(z.dist)) : null;
          for (const z of staged ? [staged] : ctx.zones.values()) {
            for (const page of z.notFound === "/_not-found/page" ? [...Object.keys(z.appPaths), z.notFound] : Object.keys(z.appPaths)) {
              if (!args.manifest.startsWith(`server/app${page}`)) continue;
              remember(path.join(z.dist, args.manifest));
              const value = load({ ...args, projectDir: z.dist, distDir: "." });
              return args.manifest.endsWith("_client-reference-manifest.js") ? manifests.withZoneMainChunks(value, z) : value;
            }
          }
        }
        return load(args);
      };
      replacement = { ...mod,
        /* A route's own manifests (its client reference manifest, its react-loadable manifest) are read from the
           zone's build; the shared ones (routes, build, fonts) stay the shell's, with the zones merged in. */
        loadManifestFromRelativePath(args) {
          if (args?.manifest === "prerender-manifest.json") return manifests.withZonePrerenders(mod.loadManifestFromRelativePath(args));
          if (args?.manifest === "server/server-reference-manifest.json") return manifests.withZoneActions(mod.loadManifestFromRelativePath(args));
          return fromZone(mod.loadManifestFromRelativePath, args);
        },
        /* Next 16.4 on reads a route's client reference manifest with a function of its own. */
        ...(typeof mod.evalManifestFromRelativePath === "function" ? { evalManifestFromRelativePath: (args) => fromZone(mod.evalManifestFromRelativePath, args) } : {}),
        loadManifest(p, ...rest) {
          const value = mod.loadManifest(p, ...rest);
          if (p.endsWith(`${path.sep}prerender-manifest.json`)) return manifests.withZonePrerenders(value);
          if (p.endsWith(`${path.sep}server${path.sep}app-paths-manifest.json`)) return manifests.withZoneAppPaths(value);
          /* Every page's file (requirePage): the zones' pages, merged by the switch. */
          if (ctx.mergedPagesManifest && p === shellPagesManifest) return ctx.mergedPagesManifest;
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
        /* The router only asks appFiles.has(), pageFiles.has() and nextDataRoutes.has(): each also answers for the
           zones' routes, sets the switch replaces whole. */
        expect(checker.pageFiles instanceof Set && checker.nextDataRoutes instanceof Set, "the router's fs checker has pageFiles and nextDataRoutes (Sets)");
        const ownHas = Set.prototype.has;
        checker.appFiles.has = (route) => ownHas.call(checker.appFiles, route) || ctx.zoneAppFiles.has(route);
        checker.pageFiles.has = (route) => ownHas.call(checker.pageFiles, route) || ctx.zonePageFiles.has(route);
        checker.nextDataRoutes.has = (route) => ownHas.call(checker.nextDataRoutes, route) || ctx.zoneDataRoutes.has(route);
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
  /* A 404 under a zone's mount is the zone's: its own not-found page renders it, from its build, as when the zone runs
     alone; the shell's answers for a zone without one (and for every URL outside the zones). Next renders a 404 two
     ways: a URL no route matches is invoked as the route /_not-found (or /404) by the router server, and rendered by
     renderPageComponent; a page's notFound goes through renderErrorToResponseImpl. Both ask findPageComponents for
     /_not-found/page or /404: during a zone's 404, by the URL asked for, that is the zone's own page. */
  const { loadComponents } = ctx.requireNext(next.files.loadComponents);
  const notFoundZone = new AsyncLocalStorage();
  const zoneOfRequest = (req) => {
    if (!ctx.zones.size || typeof req?.url !== "string") return null;
    const zone = ctx.zoneOfRoute(req.url.split("?")[0]);
    return zone?.notFound ? zone : null;
  };
  const renderPageComponent = NextNodeServer.prototype.renderPageComponent;
  NextNodeServer.prototype.renderPageComponent = function (renderCtx, bubbleNoFallback) {
    const zone = renderCtx?.pathname === "/_not-found" || renderCtx?.pathname === "/404" ? zoneOfRequest(renderCtx.req) : null;
    if (!zone) return renderPageComponent.call(this, renderCtx, bubbleNoFallback);
    return notFoundZone.run(zone, () => renderPageComponent.call(this, renderCtx, bubbleNoFallback));
  };
  const renderErrorToResponseImpl = NextNodeServer.prototype.renderErrorToResponseImpl;
  NextNodeServer.prototype.renderErrorToResponseImpl = function (renderCtx, err) {
    const zone = renderCtx?.res?.statusCode === 404 ? zoneOfRequest(renderCtx.req) : null;
    if (!zone) return renderErrorToResponseImpl.call(this, renderCtx, err);
    return notFoundZone.run(zone, () => renderErrorToResponseImpl.call(this, renderCtx, err));
  };
  /* Its render is cached like the page it is (prerendered, it is read from the cache): its key is the shell's
     /_not-found or /404, so during a zone's 404 it is moved under the zone's mount ("/shop/__zone-not-found"), where
     the zone's cache, per version, holds it, and a swap drops it (zones-cache-handler.cjs). */
  const NOT_FOUND_KEY = /^(.*\/\$)?\/(_not-found|404)$/;
  globalThis.__NEXT_ZONES_OWN_KEY__ = (key) => {
    const zone = notFoundZone.getStore();
    if (!zone || typeof key !== "string") return key;
    const m = NOT_FOUND_KEY.exec(key);
    return m ? `${m[1] ?? ""}${zone.mount}/__zone-not-found` : key;
  };
  const findPageComponents = NextNodeServer.prototype.findPageComponents;
  NextNodeServer.prototype.findPageComponents = async function (args) {
    const zone = notFoundZone.getStore();
    if (!zone || !((args?.page === "/_not-found/page" && args.isAppPath) || (args?.page === "/404" && !args.isAppPath))) return findPageComponents.call(this, args);
    const isAppPath = zone.notFound === "/_not-found/page";
    const components = await loadComponents({ distDir: path.resolve(zone.dist), page: zone.notFound, isAppPath, isDev: false, sriEnabled: this.sriEnabled, needsManifestsForLegacyReasons: false });
    /* As findPageComponentsImpl: a page with getStaticProps gets no query. */
    return { components, query: components.getStaticProps ? {} : args.query };
  };
  const getRouteMatchers = NextNodeServer.prototype.getRouteMatchers;
  if (typeof getRouteMatchers === "function") {
    NextNodeServer.prototype.getRouteMatchers = function () {
      ctx.servers.add(this);
      const matchers = getRouteMatchers.call(this);
      expect(Array.isArray(matchers?.providers) && Array.isArray(matchers?.matchers?.static) && Array.isArray(matchers?.matchers?.dynamic),
        "the server's route matchers have providers and matchers { static, dynamic } as arrays");
      return matchers;
    };
  } else {
    /* Next 16.4 on: routes are matched from appPathsManifest and appPathRoutes, which the switch assigns. */
    expect(typeof NextNodeServer.prototype.getRouteMatch === "function" && typeof NextNodeServer.prototype.getRouteDefinitions === "function",
      "NextNodeServer matches routes with getRouteMatchers, or with getRouteMatch over getRouteDefinitions");
    const getAppPathRoutes = NextNodeServer.prototype.getAppPathRoutes;
    NextNodeServer.prototype.getAppPathRoutes = function () {
      ctx.servers.add(this);
      return getAppPathRoutes.call(this);
    };
    /* 16.4 rebuilds every route definition, and sorts the dynamic ones, on each match: at a real app's size (2000
       routes, 700 dynamic) a dynamic route's request took 10.5 ms at p50, against 2.8–4.6 ms on 16.3. The definitions
       only change when the manifests they come from do, and Zones assigns new ones at every switch: they are kept
       per manifest objects, split and sorted once, and matched in Next's own order (exact routes in definition order,
       then the dynamic ones by specificity). */
    const { isDynamicRoute } = ctx.requireNext("next/dist/shared/lib/router/utils");
    const getRouteDefinitions = NextNodeServer.prototype.getRouteDefinitions;
    const routeTables = new WeakMap();                    // server → { pages, routes, paths, defs, exact, dynamic }
    const tableOf = (server) => {
      let t = routeTables.get(server);
      if (!t || t.pages !== server.pagesManifest || t.routes !== server.appPathRoutes || t.paths !== server.appPathsManifest) {
        const defs = getRouteDefinitions.call(server);
        const dynamic = defs.filter((d) => isDynamicRoute(d.pathname));
        t = { pages: server.pagesManifest, routes: server.appPathRoutes, paths: server.appPathsManifest, defs,
          exact: defs.filter((d) => !isDynamicRoute(d.pathname)), dynamic: server.getSortedRouteDefinitions(dynamic) };
        routeTables.set(server, t);
      }
      return t;
    };
    NextNodeServer.prototype.getRouteDefinitions = function () { return tableOf(this).defs; };
    NextNodeServer.prototype.getRouteMatch = function (pathname, localeAnalysisResult) {
      const t = tableOf(this);
      if (!isDynamicRoute(pathname)) {
        for (const definition of t.exact) { const match = this.testRouteDefinition(pathname, definition, localeAnalysisResult); if (match) return match; }
      }
      for (const definition of t.dynamic) { const match = this.testRouteDefinition(pathname, definition, localeAnalysisResult); if (match) return match; }
      return null;
    };
  }

  /* The incremental cache's files. The page runtime is bundled with its own FileSystemCache, out of reach, so Zones
     installs Next's own (from dist) through the public cacheHandler option (zones-cache-handler.cjs). */
  const FileSystemCache = ctx.requireNext(next.files.fileSystemCache).default;
  const getFilePath = FileSystemCache.prototype.getFilePath;
  globalThis.__NEXT_ZONES_CACHE_HANDLER__ = FileSystemCache;
  /* A key of a zone's page or route handler: under its mount (zones-cache-handler.cjs routes by it). */
  globalThis.__NEXT_ZONES_IS_ZONE_KEY__ = (key) => typeof key === "string" && ctx.segmentZone.has(segmentOf(key));
  FileSystemCache.prototype.getFilePath = function (key, kind) {
    if (kind === "APP_PAGE" || kind === "APP_ROUTE" || kind === "PAGES") {
      const zone = ctx.segmentZone.get(segmentOf(key));
      if (zone) return path.join(zone.cacheDir, kind === "PAGES" ? "pages" : "app", key);
    }
    return getFilePath.call(this, key, kind);
  };
}

module.exports = { installHooks };
