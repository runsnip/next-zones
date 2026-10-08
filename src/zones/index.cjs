"use strict";
/*
 * Zones: a Next production server that starts with the shell (the zone mounted at "/") and installs zone images
 * from a store while it runs, with no restart.
 *
 *   const { createZones } = require("@runsnip/next-zones/zones");
 *   const zones = createZones({ shell: "./zones/app", store: process.env.NEXT_ZONES_STORE });
 *   await zones.listen(3000);
 *   await zones.install("blog", "12");
 *
 * It hooks Node's module loader and Next's internals as Next loads, so there is one Zones per process, created before
 * anything else requires Next. The parts:
 *   context.cjs          the shared state
 *   next-contract.cjs    what Zones relies on in Next, checked before anything is hooked
 *   registry.cjs         one module registry for every Turbopack runtime
 *   resolve.cjs          a zone's externals resolve from the shell's node_modules
 *   loaders.cjs          per-render module loaders, bound to the async context
 *   hooks.cjs            the hooks into Next (manifests, router, caches, image optimizer, instrumentation)
 *   manifests.cjs        the shell's manifests with the zones merged in
 *   rules.cjs            a zone's aliases and routing rules
 *   assets.cjs           a zone's static and public files
 *   instrumentation.cjs  the shell's and each zone's instrumentation
 *   stage.cjs            reading and checking a zone build, its client code, its cache (zone-client.cjs, zone-seed.cjs)
 *   activate.cjs         prepare, then the switch
 *   install.cjs          the install pipeline, one switch at a time, state.json
 *   collect.cjs          collecting old versions (disk cache, loaded code), keeping a rollback window
 *   reclaim.cjs          handing the memory of collected versions back (V8's last-resort collection, when idle)
 *   pull.cjs             pulling a zone image into the store: streamed, checked, with room left on the disk
 *   prune.cjs            removing zone images no longer needed from the store
 *   server.cjs           the HTTP layer
 *   endpoints.cjs        the URLs Zones serves of its own, only those the shell declares
 *   bench.cjs            the activation benchmark (debug)
 * spikes/zones/RESULTS.md in the repository has the why of each, with the numbers.
 */
const http = require("node:http");
const { createContext } = require("./context.cjs");
const { locateNext, checkNext } = require("./next-contract.cjs");
const { installModuleRegistry } = require("./registry.cjs");
const { installSharedNodeModules } = require("./resolve.cjs");
const { installScopedLoaders, installScopedManifests } = require("./loaders.cjs");
const { installHooks } = require("./hooks.cjs");
const { createManifests } = require("./manifests.cjs");
const { createRules } = require("./rules.cjs");
const { createAssets } = require("./assets.cjs");
const { createInstrumentation } = require("./instrumentation.cjs");
const { createStaging } = require("./stage.cjs");
const { createActivation } = require("./activate.cjs");
const { createInstaller } = require("./install.cjs");
const { createCollector } = require("./collect.cjs");
const { createReclaim } = require("./reclaim.cjs");
const { createBench } = require("./bench.cjs");
const { createServer } = require("./server.cjs");
const { claimStore, releaseStore } = require("./prune.cjs");

let created = false;
let claimed = null;
/* The pid file goes with the process, however it ends. */
process.once("exit", () => { if (claimed) releaseStore(claimed); });

/**
 * @param {object} options
 * @param {string} options.shell        the shell's directory (its next.config uses zoneConfig({ mount: "/" }))
 * @param {string} [options.store]      the zone store: <store>/<zone>/<version>/ (next-zones build)
 * @param {string} [options.cacheDir]   writable: each zone image's ISR cache and analysis
 * @param {object} [options.pins]       zone → version installed at boot; the store's state.json is read over them,
 *                                       unless the pins are newer (options.pinsAt, ms: a new build or deploy)
 * @param {object|false} [options.endpoints] the URLs Zones serves of its own, over the shell's declaration (endpoints.cjs)
 * @param {object[]} [options.sources]  where zone images are pulled from (../sources.cjs): the only way one enters the store
 * @param {object|false} [options.prune] { keep: 2, auto: true }: old zone images removed after each pull and install,
 *                                       keeping the active, pinned and `keep` previous versions (prune.cjs); false: never
 * @param {number} [options.minFree]    bytes a pull leaves free on the store's disk (default 1 GiB, pull.cjs)
 * @param {object|false} [options.reclaim] { idleMs: 1000, maxWaitMs: 30000 }: after a version is collected, V8's
 *                                       last-resort collection runs once Zones is idle (reclaim.cjs); false: never
 * @param {boolean} [options.persist]   default true: state.json keeps the active versions across restarts
 * @param {object} [options.policy]     instrumentation policy: { instrumentation: { shell: { skip }, own } }
 * @param {string} [options.adminToken] required by the admin endpoints (install, policy) unless the request is local
 * @param {boolean} [options.debug]     enables <base>/debug and <base>/bench (with endpoints declared)
 * @param {boolean} [options.scopedLoaders]  default true (turned off only to measure what it fixes)
 * @param {boolean} [options.moduleRegistry] default true (idem)
 * @param {boolean} [options.unsupportedNext] run on a Next version not in next-contract.cjs SUPPORTED (the upgrade guard)
 */
function createZones(options = {}) {
  if (created) throw new Error("next-zones: one Zones per process (it hooks Node's module loader and Next's internals)");
  if (!options.shell) throw new Error("next-zones: createZones({ shell }) is required");
  created = true;
  const ctx = createContext(options);
  claimed = ctx.store;
  /* What Zones relies on in Next: on a Next it was not checked against, it refuses to start. The version and the
     files first, before anything is hooked; their shape once hooked, below. */
  const next = locateNext(ctx);

  /* Before Next loads: the module loader's hooks, then Next's. */
  installModuleRegistry(ctx);
  installSharedNodeModules(ctx);
  installScopedLoaders(ctx);
  installScopedManifests(ctx);
  const manifests = createManifests(ctx);
  const rules = createRules(ctx);
  const assets = createAssets(ctx);
  const instrumentation = createInstrumentation(ctx);
  installHooks(ctx, { manifests, rules, assets, instrumentation, next });
  checkNext(ctx, next);

  const staging = createStaging(ctx);
  const activation = createActivation(ctx, { rules });
  ctx.reclaim = createReclaim(ctx);
  const collector = createCollector(ctx);
  const installer = createInstaller(ctx, { staging, activation, instrumentation, collector });
  const bench = createBench(ctx, { staging, activation });
  const server = createServer(ctx, { assets, installer, bench, collector });
  let httpServer = null;

  return {
    /** Prepares the shell, installs the pinned and saved versions, and starts serving; resolves once listening. */
    async listen(port = 3000, hostname = "0.0.0.0") {
      claimStore(ctx.store);
      await server.prepare(port, hostname);
      await installer.restore();
      httpServer = http.createServer((req, res) => server.handleRequest(req, res).catch((error) => {
        console.error(error);
        if (!res.headersSent) res.writeHead(500, { "content-type": "application/json" }).end('{"failed":"next-zones: internal error"}');
      }));
      await new Promise((resolve) => httpServer.listen(port, hostname, resolve));
      return httpServer;
    },
    /** Prepares the shell without listening, to mount handleRequest in a server of your own. */
    prepare: async (port = 3000, hostname = "0.0.0.0") => { claimStore(ctx.store); await server.prepare(port, hostname); await installer.restore(); },
    /** The request handler (after listen() or prepare()). */
    handleRequest: server.handleRequest,
    /** Installs (or swaps to, or rolls back to) a zone image, pulled from the sources first when the store lacks it. */
    install: (name, version) => installer.installVersion(name, version),
    /** Pulls a zone image into the store from the sources, without installing it. */
    pull: (name, version) => installer.pullVersion(name, version),
    /** Removes zone images no longer needed (prune.cjs): { keep, dryRun }. */
    prune: (options) => installer.prune(options),
    /** Collects old versions, keeping the active one and `keep` before it per zone. */
    collect: (options) => collector.collect(options),
    /** What boot installed: zone → { version, ok, error? }. */
    boot: installer.boot,
    /** The installed zones: name → { version, mount }. */
    zones: () => Object.fromEntries([...ctx.zones.values()].map((z) => [z.name, { version: z.version, mount: z.mount }])),
    async close() {
      for (const res of ctx.listeners) res.end();
      await new Promise((resolve) => (httpServer ? httpServer.close(resolve) : resolve()));
      await server.close();
      releaseStore(ctx.store);
    },
  };
}

module.exports = { createZones };
