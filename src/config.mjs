/*
 * A zone declares itself in its own next.config:
 *
 *   import { zoneConfig } from "@runsnip/next-zones/config";
 *   export default zoneConfig({
 *     mount: "/blog",
 *     aliases: [{ source: "/post/:id", destination: "/blog/:id" }],
 *     livePull: true,                               // a ping to Zones may make it pull this zone's images (off by default)
 *   }, {
 *     // the zone's own Next config
 *   });
 *
 * zoneConfig returns the zone's Next config as it is, with the zone's declaration attached under a symbol, which Next
 * ignores and readZone() reads back; in a build for Zones only, it fills in the build options separately built zones
 * need (BUILD_OPTIONS below). The shell is the zone mounted at "/".
 */
import fs from "node:fs";
import path from "node:path";
import { pathToFileURL } from "node:url";
import { createRequire } from "node:module";

const buildOptions = createRequire(import.meta.url)("./build-options.cjs");

const ZONE = Symbol.for("@runsnip/next-zones/zones");
const SEGMENT = /^\/[a-z0-9][a-z0-9-]*$/;
const MODES = ["zones", "single"];

/** Checks a zone declaration; returns it normalised. */
export function checkZone(zone, where = "zone") {
  const mount = zone?.mount;
  if (mount !== "/" && !SEGMENT.test(mount ?? "")) {
    throw new Error(`${where}: mount must be "/" (the shell) or one URL segment like "/blog", got ${JSON.stringify(mount)}`);
  }
  const aliases = zone.aliases ?? [];
  for (const alias of aliases) {
    if (!/^\/[a-z0-9][a-z0-9-]*(\/|$)/.test(alias?.source ?? "")) {
      throw new Error(`${where}: an alias source must start with a fixed segment like "/p/:slug", got ${JSON.stringify(alias?.source)}`);
    }
    if (mount !== "/" && !(alias.destination === mount || alias.destination?.startsWith(`${mount}/`))) {
      throw new Error(`${where}: alias ${alias.source} must point under ${mount}, got ${JSON.stringify(alias.destination)}`);
    }
  }
  /* Whether a ping (an admin request to Zones) may make Zones pull this zone's images from its sources. Recorded in the
     zone image's zone.json at build time; Zones refuses a ping for a zone that does not allow it. Off unless declared. */
  if (zone.livePull !== undefined && typeof zone.livePull !== "boolean") throw new Error(`${where}: livePull must be true or false, got ${JSON.stringify(zone.livePull)}`);
  const endpoints = checkEndpoints(zone.endpoints, mount, where);
  /* How the workspace is served, the shell's to declare: "zones" (the default: the shell as an app, every other zone as
     an image Zones installs while it runs) or "single" (every zone in one Next app, run by next start). Next's own
     options, output included, stay the app's: next-zones reads them, never sets them for the app. */
  if (zone.mode !== undefined) {
    if (mount !== "/") throw new Error(`${where}: mode is the shell's to declare (mount "/"), not a zone's`);
    if (!MODES.includes(zone.mode)) throw new Error(`${where}: mode must be ${MODES.map((m) => JSON.stringify(m)).join(" or ")}, got ${JSON.stringify(zone.mode)}`);
  }
  if (zone.output !== undefined) throw new Error(`${where}: output is Next's option, in the zone's Next config (the second argument), not in its zone declaration; the way the workspace is served is mode`);
  return { mount, aliases, ...(zone.livePull ? { livePull: true } : {}), ...(endpoints ? { endpoints } : {}), ...(zone.mode && zone.mode !== "zones" ? { mode: zone.mode } : {}) };
}

export const DEFAULT_ENDPOINTS_BASE = "/_next-zones";
const ENDPOINT_GROUPS = ["events", "health", "admin"];

/* The URLs a Zones service serves of its own, declared by the shell (none unless declared): a base path, and which groups.
   - events: the swap events <ZoneUpdates /> listens to;
   - health: for a supervisor;
   - admin: the zone images (list, read, pull, install, delete, prune), collect, policy; behind the admin token. */
/** The endpoints declaration, normalised (createZones({ endpoints }) uses it too); null when none. */
export function normalizeEndpoints(endpoints, where = "endpoints") {
  return checkEndpoints(endpoints, "/", where);
}

function checkEndpoints(endpoints, mount, where) {
  if (endpoints === undefined || endpoints === false) return null;
  if (mount !== "/") throw new Error(`${where}: endpoints are the shell's to declare (mount "/"), not a zone's`);
  if (typeof endpoints !== "object" || endpoints === null) throw new Error(`${where}: endpoints must be an object like { base: "/_next-zones", events: true }`);
  const base = endpoints.base ?? DEFAULT_ENDPOINTS_BASE;
  if (!/^\/[A-Za-z0-9_.~-]+(\/[A-Za-z0-9_.~-]+)*$/.test(base) || base.startsWith("/_next/") || base === "/_next") {
    throw new Error(`${where}: endpoints.base must be a path like "/_next-zones" (not under /_next), got ${JSON.stringify(base)}`);
  }
  const unknown = Object.keys(endpoints).filter((key) => key !== "base" && !ENDPOINT_GROUPS.includes(key));
  if (unknown.length) throw new Error(`${where}: endpoints has unknown keys ${unknown.join(", ")} (known: base, ${ENDPOINT_GROUPS.join(", ")})`);
  for (const group of ENDPOINT_GROUPS) {
    if (endpoints[group] !== undefined && typeof endpoints[group] !== "boolean") throw new Error(`${where}: endpoints.${group} must be true or false`);
  }
  return { base, ...Object.fromEntries(ENDPOINT_GROUPS.map((group) => [group, endpoints[group] === true])) };
}

/* Run alone (next build / next start), a zone serves its aliases as its own rewrites. A build for Zones (next-zones
   build) leaves them out: Zones serves them from zone.json. */
function withAliases(config, { aliases }) {
  if (!aliases.length || process.env.NEXT_ZONES_BUILD) return config;
  const aliasRules = aliases.map(({ source, destination }) => ({ source, destination }));
  return {
    ...config,
    async rewrites() {
      const own = typeof config.rewrites === "function" ? await config.rewrites() : (config.rewrites ?? []);
      const rules = Array.isArray(own) ? { beforeFiles: [], afterFiles: own, fallback: [] } : { beforeFiles: [], afterFiles: [], fallback: [], ...own };
      return { ...rules, beforeFiles: [...aliasRules, ...rules.beforeFiles] };
    },
  };
}

/* zoneConfig fills in the build options of a build for Zones (build-options.cjs) only in next-zones build
   (NEXT_ZONES_BUILD=zones: the shell and the zone images, which both modes run), and only where the zone's config leaves
   them unset; a zone that sets one otherwise is told so, never overridden. Anywhere else (next build of a zone run
   alone, next-zones dev's composed app) the zone's Next config is passed through untouched. */
export const BUILD_OPTIONS = buildOptions.BUILD_OPTIONS;

/** Wraps a zone's Next config (an object or a function of the phase) with its zone declaration. */
export function zoneConfig(zone, nextConfig = {}) {
  const declared = checkZone(zone);
  const apply = (config) => {
    /* NEXT_ZONES_BUILD: "dev" in next-zones dev's composed app (one next dev, no build options needed), anything else
       set when next-zones builds. */
    if (!process.env.NEXT_ZONES_BUILD || process.env.NEXT_ZONES_BUILD === "dev") return { ...withAliases(config, declared), [ZONE]: declared };
    const conflicting = Object.keys(BUILD_OPTIONS).filter((key) => config.experimental?.[key] !== undefined && config.experimental[key] !== BUILD_OPTIONS[key]);
    if (conflicting.length) {
      throw new Error(`next-zones: a build for Zones needs ${conflicting.map((k) => `experimental.${k}: ${BUILD_OPTIONS[k]}`).join(", ")}, which this zone's Next config sets otherwise: remove it from the config (a zone built alone, with next build, keeps it). See configuration.md, "Build options for Zones"`);
    }
    /* The project root, pinned: Turbopack names every module by its path from the root and derives its id from that, so
       builds that share modules (the shell, every zone image) must have one root. Next infers it from the topmost
       lockfile above the app, so a lockfile added in a parent folder changed every id of the builds after it, and
       nothing was shared with the images built before. NEXT_ZONES_ROOT, else the nearest folder Next is installed in. */
    const root = projectRoot();
    return {
      ...withAliases(config, declared),
      experimental: { ...config.experimental, ...BUILD_OPTIONS },
      turbopack: { ...config.turbopack, root: config.turbopack?.root ?? root },
      outputFileTracingRoot: config.outputFileTracingRoot ?? config.turbopack?.root ?? root,
      [ZONE]: declared,
    };
  };
  if (typeof nextConfig === "function") {
    const wrapped = async (...args) => apply(await nextConfig(...args));
    wrapped[ZONE] = declared;
    return wrapped;
  }
  return apply(nextConfig);
}

/** The root a build for Zones is made from: NEXT_ZONES_ROOT, else the nearest folder from the current one whose
    node_modules holds next (where Next itself is resolved from), whatever lockfiles lie above it; widened to hold
    that node_modules where it really is, when it is a link. */
export function projectRoot(from = process.cwd()) {
  if (process.env.NEXT_ZONES_ROOT) return path.resolve(process.env.NEXT_ZONES_ROOT);
  for (let dir = path.resolve(from); ; dir = path.dirname(dir)) {
    if (fs.existsSync(path.join(dir, "node_modules", "next", "package.json"))) {
      /* A node_modules linked from elsewhere must stay inside the root: the nearest folder holding both. */
      const real = path.dirname(fs.realpathSync(path.join(dir, "node_modules")));
      let root = fs.realpathSync(dir);
      while (real !== root && !real.startsWith(root + path.sep)) root = path.dirname(root);
      return root;
    }
    if (path.dirname(dir) === dir) return path.resolve(from);
  }
}

const CONFIG_FILES = ["next.config.mjs", "next.config.js", "next.config.ts", "next.config.mts"];

/** Loads the next.config of the app in `dir` and returns its zone declaration, or null when it is not a zone. */
export async function readZone(dir) {
  const file = CONFIG_FILES.map((f) => path.join(dir, f)).find((f) => fs.existsSync(f));
  if (!file) return null;
  const loaded = (await import(pathToFileURL(file).href)).default;
  return loaded?.[ZONE] ?? null;
}
