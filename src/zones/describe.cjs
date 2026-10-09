"use strict";
/*
 * What a zone build is, for Zones: read from the build's files by describeBuild(), once, when `next-zones build`
 * stores it, and written into its zone.json ("install"). Zones then reads that one file to install the version,
 * instead of a dozen manifests on its event loop (D2). A build stored without it is described when it is installed.
 *
 * digestBuild(): the build's integrity, a sha256 over every file's path and content (zone.json aside), recorded at
 * build time and checked by Zones, in a worker, before it installs the version: a store copied in part, or
 * changed since the build, is refused.
 */
const fs = require("node:fs");
const path = require("node:path");
const crypto = require("node:crypto");
const { missingBuildOptions } = require("../build-options.cjs");

/* The config keys that shape every URL or image, compared with the shell's at install. */
const CONFIG_KEYS = ["basePath", "i18n", "trailingSlash", "assetPrefix", "skipTrailingSlashRedirect", "cacheComponents", "partialPrefetching", "images"];
/* Bumped when what describeBuild() returns changes: a zone.json of another format is described again. */
const FORMAT = 3;
/* Pages every Pages Router build has, which route nothing of the zone's own (Next's BLOCKED_PAGES, and its static
   404 and 500). */
const SYSTEM_PAGES = new Set(["/_app", "/_document", "/_error", "/404", "/500"]);

const readJson = (file) => JSON.parse(fs.readFileSync(file, "utf8"));

function describeBuild(dist) {
  const serverDir = path.join(dist, "server");
  /* A zone may use the App Router, the Pages Router, or both: each manifest is there only when its router is. */
  const readOptional = (file) => (fs.existsSync(file) ? readJson(file) : {});
  const appPathsManifest = readOptional(path.join(serverDir, "app-paths-manifest.json"));
  const appPathRoutes = readOptional(path.join(dist, "app-path-routes-manifest.json"));
  /* Pages, relative to the build (Zones makes them absolute where the build is stored), without the zone's own
     not-found and global-error. */
  const appPaths = {};
  const routes = [];
  for (const [page, file] of Object.entries(appPathsManifest)) {
    if (page.startsWith("/_")) continue;
    appPaths[page] = path.join("server", file);
    routes.push(appPathRoutes[page]);
  }
  /* Pages Router pages, relative to the build like appPaths; its _app, _document and _error apart (each page bundle
     carries the zone's own _app and _document; Next still loads the server's, so a shell without them gets these). */
  const pagesManifest = readOptional(path.join(serverDir, "pages-manifest.json"));
  const pagePaths = {}, pageSystem = {};
  for (const [page, file] of Object.entries(pagesManifest)) {
    if (SYSTEM_PAGES.has(page)) { if (page.startsWith("/_")) pageSystem[page] = path.join("server", file); continue; }
    pagePaths[page] = path.join("server", file);
  }
  const pageRoutes = Object.keys(pagePaths);
  const middleware = readJson(path.join(serverDir, "middleware-manifest.json"));
  const functionsFile = path.join(serverDir, "functions-config-manifest.json");
  const functions = fs.existsSync(functionsFile) ? readJson(functionsFile).functions ?? {} : {};
  const routesManifest = readJson(path.join(dist, "routes-manifest.json"));
  const own = (list) => (list ?? []).filter((r) => !r.internal);
  const rewrites = Array.isArray(routesManifest.rewrites) ? { afterFiles: routesManifest.rewrites } : routesManifest.rewrites ?? {};
  const actionsFile = path.join(serverDir, "server-reference-manifest.json");
  const prerender = readJson(path.join(dist, "prerender-manifest.json"));
  const ownRoute = (r) => !r.startsWith("/_");
  const pick = (o) => Object.fromEntries(Object.entries(o ?? {}).filter(([r]) => ownRoute(r)));
  const config = readJson(path.join(dist, "required-server-files.json")).config;
  const publicDir = path.join(dist, "public");
  return {
    format: FORMAT,
    buildId: fs.readFileSync(path.join(dist, "BUILD_ID"), "utf8").trim(),
    appPaths,
    routes,
    pagePaths,
    pageRoutes,
    pageSystem,
    /* The pages with a /_next/data route (getStaticProps, getServerSideProps): the router serves those as JSON. */
    dataRoutes: (routesManifest.dataRoutes ?? []).filter((r) => pageRoutes.includes(r.page)).map((r) => ({ page: r.page, dataRouteRegex: r.dataRouteRegex })),
    dynamicRoutes: routesManifest.dynamicRoutes.filter((r) => !r.skipInternalRouting && (routes.includes(r.page) || pageRoutes.includes(r.page))),
    rules: {
      headers: own(routesManifest.headers), redirects: own(routesManifest.redirects),
      beforeFiles: own(rewrites.beforeFiles), afterFiles: own(rewrites.afterFiles), fallback: own(rewrites.fallback),
    },
    actions: fs.existsSync(actionsFile) ? readJson(actionsFile) : { node: {}, edge: {} },
    prerender: { routes: pick(prerender.routes), dynamicRoutes: pick(prerender.dynamicRoutes), notFoundRoutes: (prerender.notFoundRoutes ?? []).filter(ownRoute) },
    proxy: Object.keys(middleware.middleware ?? {}).length > 0 || Boolean(functions["/_middleware"]),
    edgeFunctions: Object.keys(middleware.functions ?? {}),
    instrumentation: fs.existsSync(path.join(serverDir, "instrumentation.js")),
    publicEntries: fs.existsSync(publicDir) ? fs.readdirSync(publicDir) : null,
    config: Object.fromEntries(CONFIG_KEYS.map((key) => [key, config[key] ?? null])),
    /* The build options Zones needs that this build was made without (build-options.cjs): empty for a build for Zones. */
    missingBuildOptions: missingBuildOptions(config.experimental),
  };
}

/** Every file of the build but zone.json, as [relative path, absolute path], sorted. */
function buildFiles(dist) {
  const files = [];
  const walk = (dir) => {
    for (const entry of fs.readdirSync(dir, { withFileTypes: true })) {
      const file = path.join(dir, entry.name);
      if (entry.isDirectory()) walk(file);
      else if (entry.isFile()) files.push([path.relative(dist, file).split(path.sep).join("/"), file]);
    }
  };
  walk(dist);
  return files.filter(([rel]) => rel !== "zone.json").sort(([a], [b]) => (a < b ? -1 : a > b ? 1 : 0));
}

/** The build's integrity: { algorithm, digest, files, bytes } (bytes: the files' sizes, for the disk a pull needs). */
function digestBuild(dist) {
  const whole = crypto.createHash("sha256");
  const files = buildFiles(dist);
  let bytes = 0;
  for (const [rel, file] of files) {
    const content = fs.readFileSync(file);
    bytes += content.length;
    whole.update(`${rel}\0${crypto.createHash("sha256").update(content).digest("hex")}\n`);
  }
  return { algorithm: "sha256", digest: whole.digest("hex"), files: files.length, bytes };
}

/**
 * A zone image's own key, for what next-zones names after a build (its renamed chunks, remapped module ids, main chunk,
 * caches): Next's build id is no identity, as a generateBuildId may give two builds the same one.
 * `identity`: its zone.json ({ name, version, integrity }).
 */
function buildKey(identity, buildId) {
  return crypto.createHash("sha1").update(JSON.stringify([identity.name, identity.version, buildId, identity.integrity?.digest ?? null])).digest("hex").slice(0, 16);
}

/** buildKey() of a zone image folder. */
function buildKeyOf(dir) {
  const identity = JSON.parse(fs.readFileSync(path.join(dir, "zone.json"), "utf8"));
  return buildKey(identity, fs.readFileSync(path.join(dir, "BUILD_ID"), "utf8").trim());
}

module.exports = { describeBuild, digestBuild, buildKey, buildKeyOf, FORMAT, CONFIG_KEYS };
