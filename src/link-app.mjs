/*
 * The server link: mode "single" from zone images. The shell's build and every zone's image are linked into one Next
 * app, served by a plain `next start`: one zone format for both modes, and no zone rebuilt to deploy them together.
 * It writes to disk, once, what Zones does in memory at install:
 * - each image whole under .next/zones/<zone>/ (its Turbopack runtime finds its chunks from its own .next), its pages in
 *   the app-paths manifest pointing there;
 * - Next's manifests merged: app paths, app path routes, routes (dynamic routes in Next's order, each zone's own
 *   headers, redirects and rewrites, its aliases as rewrites), prerendered routes, server actions, fonts, intercepting
 *   routes;
 * - each zone page's own manifests where Next reads them (server/app/<page>…), its client reference manifest made to
 *   run in the shell's document (zones/client-manifest.cjs), and its prerendered pages with the shell's build id
 *   (zones/payload.cjs);
 * - the client side: the same analysis as an install (zones/zone-client.cjs), its chunks and main chunk in
 *   .next/static;
 * - the images' public files; the shell's config as the app's next.config, from what its build recorded;
 * - a zone's Pages Router pages, as Zones serves them: each renders whole in its own build (its document, _app, build
 *   id and chunks). The pages manifest points into the image, its prerendered pages and data are where Next reads
 *   them, its data routes are the app's, a request under its build id is rewritten to the app's, and the app's
 *   instrumentation.js (which Next loads before any route renders) makes its route modules read their own build's
 *   manifests from the image.
 * - a 404 under a zone's mount, as Zones renders it: with the zone's own not-found page, from its image (the app's
 *   instrumentation.js makes the server load it, its manifests and its cache entry from there).
 */
import fs from "node:fs";
import path from "node:path";
import { Worker } from "node:worker_threads";
import { createRequire } from "node:module";
import { fileURLToPath } from "node:url";

const require = createRequire(import.meta.url);
const { payloadTransform, payloadKind } = require("./zones/payload.cjs");
const { buildKeyOf } = require("./zones/describe.cjs");
const { clientManifestForZone } = require("./zones/client-manifest.cjs");
const ZONES_DIR = path.join(path.dirname(fileURLToPath(import.meta.url)), "zones");
const HASHED_EXTERNAL = /^((?:@[^/]+\/)?[^/@]+)-[0-9a-f]{16}$/;
const PRERENDERED = /\.(html|rsc|meta|body)$/;

const runWorker = (file, workerData) => new Promise((resolve, reject) => {
  const worker = new Worker(path.join(ZONES_DIR, file), { workerData });
  worker.once("message", resolve);
  worker.once("error", reject);
});
const readJson = (file, fallback) => { try { return JSON.parse(fs.readFileSync(file, "utf8")); } catch { return fallback; } };
const writeJson = (file, value) => fs.writeFileSync(file, JSON.stringify(value));
/* Manifests Next also writes as JS (`self.X = "<json>"`): the same JSON, assigned. */
function writeJsManifest(file, name, value) {
  fs.writeFileSync(file, `self.${name}=${JSON.stringify(JSON.stringify(value))}`);
}
function walk(dir, visit, rel = "") {
  for (const entry of fs.readdirSync(path.join(dir, rel), { withFileTypes: true })) {
    const next = rel ? `${rel}/${entry.name}` : entry.name;
    if (entry.isDirectory()) walk(dir, visit, next); else visit(next);
  }
}
const BUILD_ONLY = new Set(["cache", "trace", "trace-build", "diagnostics", "types", "standalone"]);

/**
 * Links the shell (`shellDir`, built) and the zone images ({ zone, mount, aliases, dir }) into the Next app `out`.
 * Returns { out, zones: [{ zone, pages, remapped }] }.
 */
export async function linkApp({ shellDir, images, out, policy = {}, into = false }) {
  const fromShell = createRequire(path.join(shellDir, "package.json"));
  const { getSortedRoutes } = fromShell("next/dist/shared/lib/router/utils");
  const { buildCustomRoute } = fromShell("next/dist/lib/build-custom-route");
  const shellDist = path.join(shellDir, ".next");
  const shellBuildId = fs.readFileSync(path.join(shellDist, "BUILD_ID"), "utf8").trim();
  const { config } = readJson(path.join(shellDist, "required-server-files.json"), {});

  /* `into`: link into an app folder that exists (the shell's standalone folder: its server.js and traced
     node_modules are kept, its .next and public/ are written again). Otherwise a new app folder. */
  if (into) {
    for (const entry of [".next", "public"]) fs.rmSync(path.join(out, entry), { recursive: true, force: true });
  } else {
    fs.rmSync(out, { recursive: true, force: true });
    fs.mkdirSync(out, { recursive: true });
  }
  const dist = path.join(out, ".next");
  /* Entry by entry: a standalone folder lives inside the shell's .next, and is never copied into itself. */
  fs.mkdirSync(dist, { recursive: true });
  for (const entry of fs.readdirSync(shellDist)) {
    if (!BUILD_ONLY.has(entry)) fs.cpSync(path.join(shellDist, entry), path.join(dist, entry), { recursive: true });
  }
  if (fs.existsSync(path.join(shellDir, "public"))) fs.cpSync(path.join(shellDir, "public"), path.join(out, "public"), { recursive: true, dereference: true });
  if (!into) {
    fs.writeFileSync(path.join(out, "package.json"), JSON.stringify({ name: "next-zones-linked", private: true }, null, 2) + "\n");
    /* The app's config: the shell's, as its build recorded it (a linked app has no sources to load a config from). */
    fs.writeFileSync(path.join(out, "next.config.mjs"), `/* Written by next-zones: the shell's config, as its build recorded it. */\nexport default ${JSON.stringify(config ?? {}, null, 2)};\n`);
  }

  const server = path.join(dist, "server");
  const appPaths = readJson(path.join(server, "app-paths-manifest.json"), {});
  const appPathRoutes = readJson(path.join(dist, "app-path-routes-manifest.json"), {});
  const routes = readJson(path.join(dist, "routes-manifest.json"), {});
  const prerender = readJson(path.join(dist, "prerender-manifest.json"), {});
  const actions = readJson(path.join(server, "server-reference-manifest.json"), { node: {}, edge: {} });
  const fonts = readJson(path.join(server, "next-font-manifest.json"), { app: {}, pages: {}, appUsingSizeAdjust: false, pagesUsingSizeAdjust: false });
  const pagesManifest = readJson(path.join(server, "pages-manifest.json"), {});
  const { escapeStringRegexp } = fromShell("next/dist/shared/lib/escape-regexp");
  const pagesZones = [];                                   // { zone, mount }: zones with Pages Router pages
  const notFoundZones = [];                                // { zone, mounts, page }: zones with a not-found page of their own
  const chunksDir = path.join(dist, "static", "chunks");
  let known = null;
  const linked = [];

  for (const { zone, mount, aliases = [], dir } of images) {
    const buildId = fs.readFileSync(path.join(dir, "BUILD_ID"), "utf8").trim(), buildKey = buildKeyOf(dir);
    const own = (route) => !route.startsWith("/_");
    /* The image, whole, under .next/zones/<zone>: its runtime resolves its chunks from there. */
    const home = path.join(dist, "zones", zone);
    fs.cpSync(dir, home, { recursive: true, verbatimSymlinks: true, filter: (src) => !["public", "out", "zone.json"].includes(path.relative(dir, src)) });
    /* Its server's external packages, which Turbopack names "<package>-<hash>" through links to the build machine: made
       to point at the package as this app resolves it. */
    const modules = path.join(home, "node_modules");
    if (fs.existsSync(modules)) {
      const fromApp = createRequire(path.join(out, "package.json"));
      const relink = (entry, at) => {
        const named = HASHED_EXTERNAL.exec(entry)?.[1];
        if (!named) return;
        /* The image's own copy first (an image built with output: "standalone" carries it), else the app's. */
        let target = fs.existsSync(path.join(at, named, "package.json")) ? path.join(at, named) : null;
        if (!target) try { target = path.dirname(fromApp.resolve(`${named}/package.json`)); } catch { return; }
        fs.rmSync(path.join(at, entry), { recursive: true, force: true });
        fs.symlinkSync(path.relative(path.dirname(path.join(at, entry)), target), path.join(at, entry));
      };
      for (const entry of fs.readdirSync(modules)) {
        if (entry.startsWith("@")) for (const inner of fs.readdirSync(path.join(modules, entry))) relink(`${entry}/${inner}`, modules);
        else relink(entry, modules);
      }
    }

    /* The client side, as an install analyses it: the chunks it writes again go straight into .next/static. A zone
       without App Router pages has nothing that runs in the shell's document. */
    const notFound = readJson(path.join(dir, "zone.json"), {}).notFound ?? null;
    const hasAppPages = notFound === "/_not-found/page" || Object.keys(readJson(path.join(dir, "server", "app-paths-manifest.json"), {})).some(own);
    const analysis = hasAppPages
      ? await runWorker("zone-client.cjs", { dist: dir, shellDist, buildKey, outDir: chunksDir, known })
      : { missingUsed: [], shellModules: null, zoneModules: {}, mainItems: null, chunkMap: {}, idMap: {} };
    if (analysis.missingUsed.length) throw new Error(`${zone} uses client runtime features the shell's runtime lacks (${analysis.missingUsed.join(", ")}): import @runsnip/next-zones/client in the shell (render <ZoneUpdates />), which gives its runtime every feature, and rebuild the shell`);
    known ??= Object.fromEntries(Object.entries(analysis.shellModules ?? {}).map(([id, h]) => [id, [...h]]));
    for (const [id, hashes] of Object.entries(analysis.zoneModules ?? {})) known[id] = [...new Set([...(known[id] ?? []), ...hashes])];
    const mainChunks = [];
    if (analysis.mainItems) {
      const file = `zone-${zone}-${buildKey}-main.js`;
      fs.writeFileSync(path.join(chunksDir, file), `(globalThis.TURBOPACK||(globalThis.TURBOPACK=[])).push(["object"==typeof document?document.currentScript:void 0,${analysis.mainItems.join(",")}]);\n`);
      mainChunks.push(`/_next/static/chunks/${file}`);
    }
    const chunkUrls = Object.fromEntries(Object.entries(analysis.chunkMap).map(([from, to]) => [`/_next/${from}`, `/_next/${to}`]));
    const change = { idMap: analysis.idMap, chunkUrls, mainChunks };
    const rewrite = payloadTransform({ buildId, shellBuildId, ...change });
    walk(path.join(dir, "static"), (rel) => {
      const target = path.join(dist, "static", rel);
      if (fs.existsSync(target)) return;
      fs.mkdirSync(path.dirname(target), { recursive: true });
      fs.copyFileSync(path.join(dir, "static", rel), target);
    });
    if (fs.existsSync(path.join(dir, "public"))) fs.cpSync(path.join(dir, "public"), path.join(out, "public"), { recursive: true, dereference: true });

    /* Its pages: in the app-paths manifest, pointing into its image; their own manifests where Next reads them. */
    const zonePaths = readJson(path.join(dir, "server", "app-paths-manifest.json"), {});
    const zoneRoutes = readJson(path.join(dir, "app-path-routes-manifest.json"), {});
    const pages = Object.keys(zonePaths).filter(own);
    for (const page of pages) {
      appPaths[page] = path.posix.join("..", "zones", zone, "server", zonePaths[page]);
      appPathRoutes[page] = zoneRoutes[page];
      const manifestFile = path.join(dir, "server", "app", `${page}_client-reference-manifest.js`);
      if (fs.existsSync(manifestFile)) {
        const sandbox = { globalThis: {} };
        new Function("globalThis", fs.readFileSync(manifestFile, "utf8"))(sandbox.globalThis);
        const entries = Object.entries(sandbox.globalThis.__RSC_MANIFEST ?? {});
        const target = path.join(server, "app", `${page}_client-reference-manifest.js`);
        fs.mkdirSync(path.dirname(target), { recursive: true });
        fs.writeFileSync(target, `globalThis.__RSC_MANIFEST = globalThis.__RSC_MANIFEST || {};\n${entries.map(([key, value]) => `globalThis.__RSC_MANIFEST[${JSON.stringify(key)}] = ${JSON.stringify(clientManifestForZone(value, change))};`).join("\n")}\n`);
      }
      const pageManifests = path.join(dir, "server", "app", page);
      if (fs.existsSync(pageManifests) && fs.statSync(pageManifests).isDirectory()) {
        for (const file of fs.readdirSync(pageManifests)) {
          if (!file.endsWith(".json")) continue;
          fs.mkdirSync(path.join(server, "app", page), { recursive: true });
          fs.copyFileSync(path.join(pageManifests, file), path.join(server, "app", page, file));
        }
      }
    }
    /* Its own not-found page renders a 404 under its mount from its image; an App Router one in the shell's document,
       so its client reference manifest there is made to run in it, as a page's. */
    if (notFound) {
      notFoundZones.push({ zone, mounts: [mount, ...aliases.map((a) => `/${a.source.split("/")[1]}`)], page: notFound });
      const manifestFile = path.join(home, "server", "app", "_not-found", "page_client-reference-manifest.js");
      if (notFound === "/_not-found/page" && fs.existsSync(manifestFile)) {
        const sandbox = { globalThis: {} };
        new Function("globalThis", fs.readFileSync(manifestFile, "utf8"))(sandbox.globalThis);
        const entries = Object.entries(sandbox.globalThis.__RSC_MANIFEST ?? {});
        fs.writeFileSync(manifestFile, `globalThis.__RSC_MANIFEST = globalThis.__RSC_MANIFEST || {};\n${entries.map(([key, value]) => `globalThis.__RSC_MANIFEST[${JSON.stringify(key)}] = ${JSON.stringify(clientManifestForZone(value, change))};`).join("\n")}\n`);
      }
    }
    /* Its prerendered pages, where Next reads them, made to run in the shell's document. */
    if (fs.existsSync(path.join(dir, "server", "app"))) walk(path.join(dir, "server", "app"), (rel) => {
      if (rel.startsWith("_") || !(PRERENDERED.test(rel) || rel.includes(".segments/"))) return;
      const target = path.join(server, "app", rel);
      fs.mkdirSync(path.dirname(target), { recursive: true });
      if (/\.(rsc|html|meta|body)$/.test(rel)) fs.writeFileSync(target, rewrite(fs.readFileSync(path.join(dir, "server", "app", rel)), payloadKind(rel)));
      else fs.copyFileSync(path.join(dir, "server", "app", rel), target);
    });

    /* Its Pages Router pages: in the pages manifest, pointing into its image (its _app, _document and _error too when
       the app has none); its prerendered pages and their data where Next reads them, as built. */
    const zonePages = readJson(path.join(dir, "server", "pages-manifest.json"), {});
    const SYSTEM = new Set(["/_app", "/_document", "/_error", "/404", "/500"]);
    const pageRoutes = Object.keys(zonePages).filter((p) => !SYSTEM.has(p));
    for (const page of Object.keys(zonePages)) {
      if (SYSTEM.has(page) && (!page.startsWith("/_") || pagesManifest[page])) continue;
      pagesManifest[page] = path.posix.join("..", "zones", zone, "server", zonePages[page]);
    }
    if (pageRoutes.length) {
      pagesZones.push({ zone, mount, buildId });
      const segments = new Set(pageRoutes.map((r) => r.split("/")[1]));
      walk(path.join(dir, "server", "pages"), (rel) => {
        if (!segments.has(rel.split("/")[0].replace(/\..*$/, "")) || !/\.(html|json|meta)$/.test(rel)) return;
        if (/-manifest\.json$/.test(rel)) return;
        const target = path.join(server, "pages", rel);
        fs.mkdirSync(path.dirname(target), { recursive: true });
        fs.copyFileSync(path.join(dir, "server", "pages", rel), target);
      });
    }

    /* Routing: its dynamic routes, its own rules, its aliases (as Zones serves them: rewrites before files). */
    const zoneRoutesManifest = readJson(path.join(dir, "routes-manifest.json"), {});
    const ownRule = (r) => !r.internal;
    const zoneRoutePaths = new Set([...pages.map((p) => zoneRoutes[p]), ...pageRoutes]);
    /* A page's /_next/data route under the app's build id; a request under the zone's own is rewritten to it. */
    routes.dataRoutes = [...(routes.dataRoutes ?? []), ...(zoneRoutesManifest.dataRoutes ?? []).filter((r) => pageRoutes.includes(r.page)).map((r) => {
      const swap = (re) => re && re.replace(`/${escapeStringRegexp(buildId)}/`, `/${escapeStringRegexp(shellBuildId)}/`);
      return { ...r, dataRouteRegex: swap(r.dataRouteRegex), ...(r.namedDataRouteRegex ? { namedDataRouteRegex: swap(r.namedDataRouteRegex) } : {}) };
    })];
    routes.dynamicRoutes = [...(routes.dynamicRoutes ?? []), ...(zoneRoutesManifest.dynamicRoutes ?? []).filter((r) => zoneRoutePaths.has(r.page))];
    routes.staticRoutes = [...(routes.staticRoutes ?? []), ...(zoneRoutesManifest.staticRoutes ?? []).filter((r) => zoneRoutePaths.has(r.page))];
    routes.headers = [...(routes.headers ?? []), ...(zoneRoutesManifest.headers ?? []).filter(ownRule)];
    routes.redirects = [...(routes.redirects ?? []), ...(zoneRoutesManifest.redirects ?? []).filter(ownRule)];
    const asPhases = (r) => (Array.isArray(r) ? { beforeFiles: [], afterFiles: r, fallback: [] } : { beforeFiles: [], afterFiles: [], fallback: [], ...r });
    const shellRewrites = asPhases(routes.rewrites ?? []), zoneRewrites = asPhases(zoneRoutesManifest.rewrites ?? []);
    const dataRewrite = pageRoutes.length && buildId !== shellBuildId ? [buildCustomRoute("rewrite", { source: `/_next/data/${buildId}/:path*`, destination: `/_next/data/${shellBuildId}/:path*` })] : [];
    routes.rewrites = {
      beforeFiles: [...dataRewrite, ...aliases.map((a) => buildCustomRoute("rewrite", { source: a.source, destination: a.destination })), ...shellRewrites.beforeFiles, ...zoneRewrites.beforeFiles.filter(ownRule)],
      afterFiles: [...shellRewrites.afterFiles, ...zoneRewrites.afterFiles.filter(ownRule)],
      fallback: [...shellRewrites.fallback, ...zoneRewrites.fallback.filter(ownRule)],
    };

    /* Prerendered routes, server actions, fonts. */
    const zonePrerender = readJson(path.join(dir, "prerender-manifest.json"), {});
    const pick = (o) => Object.fromEntries(Object.entries(o ?? {}).filter(([r]) => own(r)));
    prerender.routes = { ...prerender.routes, ...pick(zonePrerender.routes) };
    prerender.dynamicRoutes = { ...prerender.dynamicRoutes, ...pick(zonePrerender.dynamicRoutes) };
    prerender.notFoundRoutes = [...new Set([...(prerender.notFoundRoutes ?? []), ...(zonePrerender.notFoundRoutes ?? []).filter(own)])];
    const zoneActions = readJson(path.join(dir, "server", "server-reference-manifest.json"), { node: {}, edge: {} });
    actions.node = { ...actions.node, ...zoneActions.node };
    actions.edge = { ...actions.edge, ...zoneActions.edge };
    const zoneFonts = readJson(path.join(dir, "server", "next-font-manifest.json"), {});
    fonts.app = { ...fonts.app, ...zoneFonts.app };
    fonts.appUsingSizeAdjust = fonts.appUsingSizeAdjust || Boolean(zoneFonts.appUsingSizeAdjust);
    linked.push({ zone, pages: pages.length + pageRoutes.length, remapped: Object.keys(analysis.idMap).length });
  }

  /* Instrumentation, as Zones runs it: the shell's for every route, each zone's own for its routes, under the
     workspace's policy (zones.config.json: shell.skip, own). Next loads server/instrumentation.js: it becomes this. */
  const zonesWithOwn = images.filter((i) => fs.existsSync(path.join(dist, "zones", i.zone, "server", "instrumentation.js")));
  if (zonesWithOwn.length) {
    const shellOwn = fs.existsSync(path.join(server, "instrumentation.js"));
    if (shellOwn) fs.renameSync(path.join(server, "instrumentation.js"), path.join(server, "instrumentation-shell.js"));
    fs.writeFileSync(path.join(server, "instrumentation.js"), `/* Written by next-zones: the shell's instrumentation for every route, each zone's own for its routes, as on Zones. */
const shell = ${shellOwn ? `require(__dirname + "/instrumentation-shell.js")` : "{}"};
const policy = ${JSON.stringify(policy)};
const zones = [
${zonesWithOwn.map((i) => `  { name: ${JSON.stringify(i.zone)}, mount: ${JSON.stringify(i.mount)}, own: require(${JSON.stringify(`../zones/${i.zone}/server/instrumentation.js`)}) },`).join("\n")}
];
const mounts = ${JSON.stringify(images.map((i) => ({ name: i.zone, mount: i.mount })))};
const ownRuns = (name) => policy.own?.[name] !== false;
async function register() {
  await shell.register?.();
  for (const z of zones) if (ownRuns(z.name)) await z.own.register?.();
}
async function onRequestError(error, request, context) {
  const at = context?.routePath ?? request?.path ?? "";
  const name = mounts.find((m) => at === m.mount || at.startsWith(m.mount + "/"))?.name;
  if (!name || !(policy.shell?.skip ?? []).includes(name)) await shell.onRequestError?.(error, request, context);
  const own = name && ownRuns(name) ? zones.find((z) => z.name === name)?.own : undefined;
  if (own?.onRequestError) {
    try { await own.onRequestError(error, request, context); }
    catch (e) { console.error(\`Error in zone "\${name}" instrumentation.onRequestError:\`, e); }
  }
}
module.exports = { register, onRequestError };
`);
  }

  /* What Zones does in memory (zones/hooks.cjs), done by the app's own server: Next loads instrumentation.js before any
     route renders (RouteModule.prepare), and it first requires next-zones-runtime.js, which
     - makes the Pages route modules read a zone page's manifests (its build id, its build manifest…) from the zone's
       image;
     - renders a 404 under a zone's mount with the zone's own not-found page, from its image: the server's
       findPageComponents loads it there, the App Router's reads its manifests there, and its cache entry is the zone's
       ("<mount>/__zone-not-found"), not the shell's /_not-found. */
  if (pagesZones.length || notFoundZones.length) {
    fs.writeFileSync(path.join(server, "next-zones-runtime.js"), `/* Written by next-zones: zones' Pages Router pages and not-found pages render from their own build (.next/zones/<zone>). */
const path = require("node:path");
const { AsyncLocalStorage } = require("node:async_hooks");
const zones = ${JSON.stringify(pagesZones.map(({ zone, mount }) => ({ zone, mount })))};
const notFoundZones = ${JSON.stringify(notFoundZones)};
const zoneOf = (page) => zones.find((z) => page === z.mount || page.startsWith(z.mount + "/"));
const notFoundOf = (url) => {
  const p = typeof url === "string" ? url.split("?")[0] : "";
  return notFoundZones.find((z) => z.mounts.some((m) => p === m || p.startsWith(m + "/"))) ?? null;
};
const current = new AsyncLocalStorage();               // the zone whose not-found page renders this request's 404
for (const runtime of ["next/dist/compiled/next-server/pages-turbo.runtime.prod.js", "next/dist/compiled/next-server/pages-api-turbo.runtime.prod.js"]) {
  let loaded;
  try { loaded = require(runtime); } catch { continue; }
  for (const exported of Object.values(loaded)) {
    if (typeof exported !== "function") continue;
    let proto = exported.prototype;
    while (proto && !Object.prototype.hasOwnProperty.call(proto, "loadManifests")) proto = Object.getPrototypeOf(proto);
    if (!proto || proto.__nextZonesPages) continue;
    Object.defineProperty(proto, "__nextZonesPages", { value: true });
    const loadManifests = proto.loadManifests;
    proto.loadManifests = function (srcPage, ...rest) {
      const notFound = current.getStore();
      const zone = typeof srcPage !== "string" ? null : zoneOf(srcPage) ?? (notFound && notFound.page === srcPage ? notFound : null);
      if (!zone) return loadManifests.call(this, srcPage, ...rest);
      const own = this.distDir;
      this.distDir = path.join(own, "zones", zone.zone);
      try { return loadManifests.call(this, srcPage, ...rest); } finally { this.distDir = own; }
    };
  }
}
if (notFoundZones.length) {
  const KEY = /^(.*\\/\\$)?\\/(_not-found|404)$/;
  const ownKey = (key) => {
    const zone = current.getStore();
    const m = zone && typeof key === "string" ? KEY.exec(key) : null;
    return m ? (m[1] || "") + zone.mounts[0] + "/__zone-not-found" : key;
  };
  const NextNodeServer = require("next/dist/server/next-server").default;
  const { loadComponents } = require("next/dist/server/load-components");
  const proto = NextNodeServer.prototype;
  if (!proto.__nextZonesNotFound) {
    Object.defineProperty(proto, "__nextZonesNotFound", { value: true });
    /* A URL no route matches is rendered as the route /_not-found (or /404); a page's notFound by the error render. */
    const renderPageComponent = proto.renderPageComponent;
    proto.renderPageComponent = function (ctx, bubbleNoFallback) {
      const zone = ctx && (ctx.pathname === "/_not-found" || ctx.pathname === "/404") ? notFoundOf(ctx.req && ctx.req.url) : null;
      return zone ? current.run(zone, () => renderPageComponent.call(this, ctx, bubbleNoFallback)) : renderPageComponent.call(this, ctx, bubbleNoFallback);
    };
    const renderErrorToResponseImpl = proto.renderErrorToResponseImpl;
    proto.renderErrorToResponseImpl = function (ctx, err) {
      const zone = ctx && ctx.res && ctx.res.statusCode === 404 ? notFoundOf(ctx.req && ctx.req.url) : null;
      return zone ? current.run(zone, () => renderErrorToResponseImpl.call(this, ctx, err)) : renderErrorToResponseImpl.call(this, ctx, err);
    };
    const findPageComponents = proto.findPageComponents;
    proto.findPageComponents = async function (args) {
      const zone = current.getStore();
      if (!zone || !args || !((args.page === "/_not-found/page" && args.isAppPath) || (args.page === "/404" && !args.isAppPath))) return findPageComponents.call(this, args);
      const components = await loadComponents({ distDir: path.join(this.distDir, "zones", zone.zone), page: zone.page, isAppPath: zone.page === "/_not-found/page", isDev: false, sriEnabled: this.sriEnabled, needsManifestsForLegacyReasons: false });
      /* Its render is cached like the page it is: the route module makes an incremental cache per request, whose
         keys are moved under the zone's mount, not the shell's /_not-found or /404. */
      const routeModule = components.routeModule;
      if (routeModule && typeof routeModule.getIncrementalCache === "function" && !Object.prototype.hasOwnProperty.call(routeModule, "getIncrementalCache")) {
        const getIncrementalCache = routeModule.getIncrementalCache;
        routeModule.getIncrementalCache = async function (...args) {
          const cache = await getIncrementalCache.apply(this, args);
          if (cache && !cache.__nextZonesNotFound) {
            const { get, set } = cache;
            Object.assign(cache, { __nextZonesNotFound: true, get: (key, ...rest) => get.call(cache, ownKey(key), ...rest), set: (key, ...rest) => set.call(cache, ownKey(key), ...rest) });
          }
          return cache;
        };
      }
      return { components, query: components.getStaticProps ? {} : args.query };
    };
  }
  /* The App Router's route module reads its page's manifests through this module, as it renders: the zone's not-found
     page's, from its image. */
  const file = require.resolve("next/dist/server/load-manifest.external.js");
  const loaded = require(file);
  if (!loaded.__nextZonesNotFound) {
    const fromZone = (load) => (args) => {
      const zone = current.getStore();
      if (!zone || zone.page !== "/_not-found/page" || !args || typeof args.manifest !== "string" || !args.manifest.startsWith("server/app/_not-found/page")) return load(args);
      return load({ ...args, distDir: path.join(args.distDir, "zones", zone.zone) });
    };
    const replacement = { ...loaded, __nextZonesNotFound: true, loadManifestFromRelativePath: fromZone(loaded.loadManifestFromRelativePath) };
    if (typeof loaded.evalManifestFromRelativePath === "function") replacement.evalManifestFromRelativePath = fromZone(loaded.evalManifestFromRelativePath);
    require.cache[file].exports = replacement;
  }
}
`);
    const hook = path.join(server, "instrumentation.js");
    const existing = fs.existsSync(hook) ? fs.readFileSync(hook, "utf8") : "module.exports = {};\n";
    fs.writeFileSync(hook, `require(__dirname + "/next-zones-runtime.js");\n${existing}`);
  }
  writeJson(path.join(server, "pages-manifest.json"), pagesManifest);

  /* Dynamic routes in Next's order. */
  const byPage = new Map((routes.dynamicRoutes ?? []).map((r) => [r.page, r]));
  routes.dynamicRoutes = getSortedRoutes([...byPage.keys()]).map((p) => byPage.get(p));
  writeJson(path.join(server, "app-paths-manifest.json"), appPaths);
  writeJson(path.join(dist, "app-path-routes-manifest.json"), appPathRoutes);
  writeJson(path.join(dist, "routes-manifest.json"), routes);
  writeJson(path.join(dist, "prerender-manifest.json"), prerender);
  writeJson(path.join(server, "server-reference-manifest.json"), actions);
  writeJsManifest(path.join(server, "server-reference-manifest.js"), "__RSC_SERVER_MANIFEST", actions);
  writeJson(path.join(server, "next-font-manifest.json"), fonts);
  writeJsManifest(path.join(server, "next-font-manifest.js"), "__NEXT_FONT_MANIFEST", fonts);
  return { out, zones: linked };
}
