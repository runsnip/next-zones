"use strict";
/*
 * Zones' shared state, one object passed to every part. What a switch replaces is replaced whole on it (the
 * overlay, the segment map, the zones' routes, the rule tables), so a request never sees half of an install.
 */
const Module = require("node:module");
const path = require("node:path");

/** A zone that cannot be installed as it is: the install is refused and nothing changes. */
class ZoneError extends Error {}

function createContext(options) {
  const shell = path.resolve(options.shell);
  const ctx = {
    options,
    shell,
    store: path.resolve(options.store ?? path.join(shell, ".zones-store")),
    cacheDir: path.resolve(options.cacheDir ?? path.join(shell, ".next", "cache", "next-zones")),
    /* Next is the shell's: every require of Next's internals resolves from the shell's directory. */
    requireNext: Module.createRequire(path.join(shell, "package.json")),

    zones: new Map(),                 // name → staged zone (its build, routes, manifests, cache…)
    zonesRevision: 0,                 // bumped whenever the set of zones changes (memoised merged manifests)
    segmentZone: new Map(),           // first path segment ("blog") → the zone mounted there
    segmentGeneration: new Map(),     // first path segment → generation, bumped by a switch (cached misses)
    zoneAppFiles: new Set(),          // every installed zone's routes, for the router's appFiles
    zonePageFiles: new Set(),         // every installed zone's Pages Router pages, for the router's pageFiles
    zoneDataRoutes: new Set(),        // the zones' pages with a /_next/data route, for the router's nextDataRoutes
    zoneBuildIds: new Set(),          // the zones' build ids: a /_next/data request under one is read as the shell's
    mergedManifest: null,             // the app-paths overlay, built by prepare, assigned by the switch
    revision: 0,                      // bumped by every switch: a plan made on an older one is redone
    placed: new Map(),                // zone name → what its last switch added (matchers, pages, routes)
    zoneDists: new Set(),             // every staged zone build, absolute, with a trailing separator
    loadedManifests: new Set(),
    clientKnown: null,                // module id → hashes a browser may hold (the shell's, then every install's)       // manifest files read from zone builds (Next caches them by path)

    servers: new Set(),               // Next's server instances
    fsCheckers: new Set(),            // the router server's file-system checks
    lrus: new Set(),                  // every LRU Next creates (cached misses live there)
    listeners: new Set(),             // open tabs listening to <base>/events
    policy: options.policy ?? {},     // the instrumentation policy

    /* Benchmark only: synthetic pages added to the shell's manifest, to measure at a real app's size. */
    padding: {},
    hasPadding: false,
    generation: 0,
  };
  /** The zone a route (or a request path) belongs to, by its first segment. */
  ctx.zoneOfRoute = (route) => ctx.segmentZone.get(/^\/([^/]*)/.exec(route ?? "")?.[1] ?? "");
  return ctx;
}

module.exports = { createContext, ZoneError };
