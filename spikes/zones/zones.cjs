/*
 * The spike's Zones: the package's createZones() (src/zones), on this spike's shell, store and cache, with debug on.
 *
 *   node zones.cjs                                    serves ./shell on :3900
 *   POST /_next-zones/images/blog/2/install       installs .zones-store/blog/2 (built by build-zone.sh)
 *
 * NEXT_ZONES_SHELL, NEXT_ZONES_STORE and PORT override the defaults (fixtures-cc uses them). NEXT_ZONES_SCOPED_LOADERS
 * and NEXT_ZONES_REGISTRY set to "off" turn a fix off, to measure what it fixes. NEXT_ZONES_UNSUPPORTED_NEXT=1 runs on a
 * Next not yet in next-contract.cjs SUPPORTED (the upgrade guard sets it). NEXT_ZONES_SOURCE is a folder of zone images
 * Zones pulls a version from (pull.mjs, endpoints.mjs, prune.mjs). NEXT_ZONES_PRUNE_KEEP turns pruning on.
 */
const fs = require("node:fs");
const path = require("node:path");
const { createZones } = require("../../src/zones/index.cjs");
const { fromDirectory } = require("../../src/sources.cjs");

const policyFile = path.join(__dirname, "zones.config.json");
const zones = createZones({
  shell: path.resolve(__dirname, process.env.NEXT_ZONES_SHELL ?? "shell"),
  store: path.resolve(__dirname, process.env.NEXT_ZONES_STORE ?? ".zones-store"),
  cacheDir: path.resolve(__dirname, process.env.NEXT_ZONES_CACHE ?? ".zones-cache"),
  policy: fs.existsSync(policyFile) ? JSON.parse(fs.readFileSync(policyFile, "utf8")) : {},
  debug: true,
  persist: process.env.NEXT_ZONES_PERSIST === "on",          // checks start from an empty Zones
  scopedLoaders: process.env.NEXT_ZONES_SCOPED_LOADERS !== "off",
  moduleRegistry: process.env.NEXT_ZONES_REGISTRY !== "off",
  unsupportedNext: process.env.NEXT_ZONES_UNSUPPORTED_NEXT === "1",        // the upgrade guard, on a Next being checked
  /* NEXT_ZONES_ENDPOINTS: "off" for none, or another base path, over the shell's declaration (endpoints.mjs). */
  ...(process.env.NEXT_ZONES_ENDPOINTS === "off" ? { endpoints: false }
    : process.env.NEXT_ZONES_ENDPOINTS ? { endpoints: { base: process.env.NEXT_ZONES_ENDPOINTS, events: true, health: true, admin: true } } : {}),
  sources: process.env.NEXT_ZONES_SOURCE ? [fromDirectory(path.resolve(__dirname, process.env.NEXT_ZONES_SOURCE))] : [],
  /* Off unless NEXT_ZONES_PRUNE_KEEP is set: most checks run on the workspace's store, whose builds prune would remove
     (prune.mjs, pull.mjs and endpoints.mjs run on stores of their own). */
  prune: process.env.NEXT_ZONES_PRUNE_KEEP ? { keep: Number(process.env.NEXT_ZONES_PRUNE_KEEP) } : false,
});
const port = Number(process.env.PORT ?? 3900);
zones.listen(port, "127.0.0.1").then(() => console.log(`Zones on :${port} (pid ${process.pid})`));
