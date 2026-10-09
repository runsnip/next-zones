"use strict";
/*
 * What Zones relies on in Next, checked before anything is hooked: Zones works on Next's internals, so on a Next it
 * was not checked against it refuses to start, naming every assumption that does not hold, rather than half-working.
 *
 * - The version: one of SUPPORTED, the versions the whole suite has passed on (tools/upgrade-guard.mjs <version>).
 *   createZones({ unsupportedNext: true }) runs anyway, for the upgrade guard itself.
 * - The modules Zones hooks, located by their exact files before anything is hooked (locateNext), and checked once
 *   hooked for the functions and methods Zones wraps or calls (checkNext). hooks.cjs hooks the module loaded from
 *   each of these files, whatever path Next requires it by.
 * - What Zones reads on Next's objects at run time (the router's fs checker, the server's matchers) is checked where
 *   it is first met, with expect() below.
 */
const SUPPORTED = ["16.3.6", "16.3.7", "16.3.8", "16.4.0"];

class NextContractError extends Error {}

/* The files Zones hooks or calls into, and what it needs of each: [export path, "function" | "class" | method list].
   A method entry "a|b+c" is met by a, or by b and c together (where Next changed between versions). */
const MODULES = {
  loadManifest: ["next/dist/server/load-manifest.external", [["loadManifestFromRelativePath", "function"], ["loadManifest", "function"], ["clearManifestCache", "function"]]],
  imageOptimizer: ["next/dist/server/image-optimizer", [["fetchInternalImage", "function"]]],
  instrumentationGlobals: ["next/dist/server/lib/router-utils/instrumentation-globals.external", [["instrumentationOnRequestError", "function"]]],
  filesystem: ["next/dist/server/lib/router-utils/filesystem", [["setupFsCheck", "function"]]],
  lruCache: ["next/dist/server/lib/lru-cache", [["LRUCache", "class", ["set", "has", "get", "remove"]]]],
  nextServer: ["next/dist/server/next-server", [["default", "class", ["instrumentationOnRequestError", "getRouteMatchers|getRouteMatch+getRouteDefinitions+getSortedRouteDefinitions+testRouteDefinition+getAppPathRoutes", "getAppPathsManifest"]]]],
  fileSystemCache: ["next/dist/server/lib/incremental-cache/file-system-cache", [["default", "class", ["getFilePath"]]]],
  appPaths: ["next/dist/shared/lib/router/utils/app-paths", [["normalizeAppPath", "function"]]],
  routerUtils: ["next/dist/shared/lib/router/utils", [["getSortedRoutes", "function"], ["isDynamicRoute", "function"]]],
  routeMatcher: ["next/dist/shared/lib/router/utils/route-matcher", [["getRouteMatcher", "function"]]],
  routeRegex: ["next/dist/shared/lib/router/utils/route-regex", [["getRouteRegex", "function"]]],
  pathMatch: ["next/dist/shared/lib/router/utils/path-match", [["getPathMatch", "function"]]],
  /* Not hooked: the parser Zones reads client modules with (module-code.cjs). */
  acorn: ["next/dist/compiled/acorn", [["parseExpressionAt", "function"]]],
};

const fail = (version, problems) => new NextContractError(`next-zones: this Next does not match what Zones relies on${version ? ` (next ${version})` : ""}:\n  - ${problems.join("\n  - ")}`);

/**
 * Before anything is hooked: the version, and where each module Zones relies on is. Nothing of Next is loaded yet,
 * so the hooks still see every module as Next loads it. Returns { version, files: name → absolute path }.
 */
function locateNext(ctx) {
  const problems = [];
  let version = null;
  try { version = ctx.requireNext("next/package.json").version; } catch { problems.push("next cannot be resolved from the shell"); }
  /* NEXT_ZONES_UNSUPPORTED_NEXT=1 is the upgrade guard's, for every Zones its checks start (next-zones start, a
     standalone zones.js), not only the ones it creates itself. */
  const unsupportedNext = ctx.options.unsupportedNext || process.env.NEXT_ZONES_UNSUPPORTED_NEXT === "1";
  if (version && !SUPPORTED.includes(version) && !unsupportedNext) {
    problems.push(`Next ${version} has not been checked with next-zones (checked: ${SUPPORTED.join(", ")}); run tools/upgrade-guard.mjs ${version}, and add it to SUPPORTED in src/zones/next-contract.cjs once it passes`);
  }
  const files = {};
  for (const [name, [file]] of Object.entries(MODULES)) {
    try { files[name] = ctx.requireNext.resolve(file); } catch (error) { problems.push(`${file}: cannot be resolved (${error.code ?? error.message})`); }
  }
  if (problems.length) throw fail(version, problems);
  return { version, files };
}

/**
 * Once hooked: each module as Next itself has it (Module._cache, the object before any hook), with the functions and
 * methods Zones wraps or calls. Throws one error listing every problem.
 */
function checkNext(ctx, located) {
  const Module = require("node:module");
  const problems = [];
  for (const [name, [file, needs]] of Object.entries(MODULES)) {
    try { ctx.requireNext(file); } catch (error) { problems.push(`${file}: cannot be loaded (${error.code ?? error.message})`); continue; }
    const mod = Module._cache[located.files[name]]?.exports;
    for (const [key, kind, methods = []] of needs) {
      const value = mod?.[key];
      if (typeof value !== "function") { problems.push(`${file}: ${key} is ${value === undefined ? "missing" : `a ${typeof value}`}, a ${kind} was expected`); continue; }
      for (const method of methods) {
        const has = (m) => typeof value.prototype?.[m] === "function";
        if (!method.split("|").some((alt) => alt.split("+").every(has))) {
          problems.push(`${file}: ${key}.prototype.${method.split("|").map((alt) => alt.split("+").join(" and ")).join(", or ")} ${method.includes("|") ? "are" : "is"} missing`);
        }
      }
    }
  }
  if (problems.length) throw fail(located.version, problems);
}

/** A run-time assumption about one of Next's objects; throws a NextContractError naming it when it does not hold. */
function expect(condition, what) {
  if (!condition) throw new NextContractError(`next-zones: Next's internals differ from what Zones relies on: ${what} (is this Next version supported?)`);
}

module.exports = { SUPPORTED, MODULES, locateNext, checkNext, expect, NextContractError };
