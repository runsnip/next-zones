"use strict";
/*
 * The warm-up: what a first request would load, loaded before one comes. Zones listens only once it is done, so a
 * proxy that sends requests to it as soon as it listens finds its routes warm.
 * - modules(build): every page and route bundle of a build required (its server chunks read and compiled, its module
 *   factories registered, fetch patched as Next patches it), and each route's own manifests loaded through its route
 *   module, in that build (the client reference manifest evaluated); for the shell, its node middleware (proxy.ts)
 *   too. On the shell before Zones listens, and on each zone version as it installs, after staging and before its
 *   switch, outside the one-at-a-time queue: the switch assigns what it did before, nothing more.
 * - render(): routes rendered once in-process, before listening (Next's request mocks, no socket), as a document and as
 *   an RSC request (a soft navigation's), through Zones' routing as a request goes: what only a render loads (the
 *   page's and its layouts' modules, the SSR side of its client components, React's renderers) is loaded. By default
 *   each zone's mount and the shell's "/"; a render that fails or runs out of time is reported, never fatal.
 * A page's components are not evaluated outside a render: Turbopack keeps a module factory's error, so a module that
 * failed outside its render's context would fail every render after.
 */
const fs = require("node:fs");
const net = require("node:net");
const path = require("node:path");

const now = () => performance.now();
const readOptional = (file) => { try { return JSON.parse(fs.readFileSync(file, "utf8")); } catch { return {}; } };

/** createZones({ warm }): false, true (the default: modules, and each mount rendered) or { routes, timeoutMs }. */
function warmOptions(warm) {
  if (warm === false) return null;
  const o = warm === true || warm === undefined ? {} : warm;
  if (typeof o !== "object" || o === null) throw new Error(`next-zones: warm is false, true or { routes, timeoutMs }, got ${JSON.stringify(warm)}`);
  const routes = o.routes ?? "mounts";
  if (routes !== "mounts" && routes !== false && !(Array.isArray(routes) && routes.every((r) => typeof r === "string" && r.startsWith("/")))) {
    throw new Error(`next-zones: warm.routes is a list of paths ("/blog"), "mounts" or false, got ${JSON.stringify(routes)}`);
  }
  const timeoutMs = o.timeoutMs ?? 10_000;
  if (!(Number.isFinite(timeoutMs) && timeoutMs > 0)) throw new Error(`next-zones: warm.timeoutMs is a number of ms, got ${JSON.stringify(o.timeoutMs)}`);
  return { routes, timeoutMs };
}

/** --warm and NEXT_ZONES_WARM: "off", "on", "mounts", or a comma-separated list of paths to render. */
function warmFromText(text) {
  if (text === undefined || text === "") return undefined;
  if (/^(off|false|0)$/.test(text)) return false;
  if (/^(on|true|1)$/.test(text)) return true;
  if (text === "mounts") return { routes: "mounts" };
  return { routes: text.split(",").map((r) => r.trim()).filter(Boolean) };
}

function createWarm(ctx, { render }) {
  const options = warmOptions(ctx.options.warm);
  ctx.warming = new Set();                       // staged builds warmed before their switch (hooks.cjs reads their manifests)
  /* What the boot's warm-up did (zones' installs at boot included); an install's own goes in its result. */
  const report = { ms: 0, modules: 0, failed: [], routes: [] };
  let booted = false;

  /* A build's page and route bundles: the shell's from its manifests, a zone's from its staged build (absolute). */
  function bundles(staged) {
    if (staged) {
      const all = { ...staged.appPaths, ...staged.pagePaths, ...staged.pageSystem };
      return Object.entries(all).filter(([, file]) => file.endsWith(".js")).map(([page, file]) => ({ page, file }));
    }
    const server = path.join(ctx.shell, ".next", "server");
    const all = { ...readOptional(path.join(server, "app-paths-manifest.json")), ...readOptional(path.join(server, "pages-manifest.json")) };
    return Object.entries(all).filter(([, file]) => file.endsWith(".js")).map(([page, file]) => ({ page, file: path.join(server, file) }));
  }

  async function load({ file }) {
    let mod = require(file);
    if (typeof mod?.then === "function") mod = await mod;
    mod?.patchFetch?.();
    const route = mod?.routeModule;
    if (typeof route?.loadManifests === "function" && route.definition?.page) route.loadManifests(route.definition.page, ctx.shell);
  }

  /** Loads a build's bundles (a staged zone, or the shell's when none is given): { ms, modules, failed }. */
  async function modules(staged = null) {
    const done = { ms: 0, modules: 0, failed: [] };
    if (!options) return done;
    const t0 = now();
    const fail = (page, error) => done.failed.push({ ...(staged ? { zone: staged.name } : {}), page, error: error.message });
    if (staged) ctx.warming.add(staged);
    try {
      await (ctx.requestScope ?? ((fn) => fn()))(async () => {
        for (const bundle of bundles(staged)) {
          try { await load(bundle); done.modules++; } catch (error) { fail(bundle.page, error); }
          /* A bundle is required synchronously: the event loop turns between two, so a live install holds requests up
             for one bundle at a time. */
          await new Promise((resolve) => setImmediate(resolve));
        }
        /* The shell's node middleware (proxy.ts), as Next loads it at its first request. */
        if (!staged) for (const server of ctx.servers) await server.loadNodeMiddleware?.().catch((error) => fail("middleware", error));
      });
    } finally { if (staged) ctx.warming.delete(staged); }
    done.ms = +(now() - t0).toFixed(1);
    if (!booted) { report.ms += done.ms; report.modules += done.modules; report.failed.push(...done.failed); }
    return done;
  }

  /* The routes rendered at boot: the list given, or each serving zone's mount and the shell's "/", where a page is. */
  function routes() {
    if (options.routes !== "mounts") return options.routes || [];
    const own = (z) => z.routes.concat(z.pageRoutes ?? []);
    const shellRoutes = Object.values(readOptional(path.join(ctx.shell, ".next", "app-path-routes-manifest.json")));
    return [...(shellRoutes.includes("/") ? ["/"] : []), ...[...ctx.zones.values()].filter((z) => own(z).includes(z.mount)).map((z) => z.mount)];
  }

  /** Renders the routes once each, as a document and as an RSC request, before Zones listens. */
  async function renders() {
    if (!options) return;
    const { createRequestResponseMocks } = ctx.requireNext("next/dist/server/lib/mock-request");
    const t0 = now();
    for (const route of routes()) {
      /* The RSC request carries the cache-busting parameter Next checks (`_rsc`, empty for a request with no router
         headers), or Next redirects it. */
      for (const [url, headers] of [[route, {}], [`${route}${route.includes("?") ? "&" : "?"}_rsc=`, { rsc: "1" }]]) {
        const s0 = now();
        /* A socket that is not connected: Next and a proxy may read its address. */
        const { req, res } = createRequestResponseMocks({ url, headers: { host: "localhost", accept: "text/html", ...headers }, socket: new net.Socket(), resWriter: () => true });
        let timer;
        const outcome = await Promise.race([
          render(req, res).then(() => res.hasStreamed).then(() => null, (error) => error.message),
          new Promise((resolve) => { timer = setTimeout(() => resolve(`out of time (${options.timeoutMs} ms)`), options.timeoutMs); }),
        ]);
        clearTimeout(timer);
        report.routes.push({ path: route, rsc: Boolean(headers.rsc), status: res.statusCode, ms: +(now() - s0).toFixed(1), ...(outcome ? { error: outcome } : {}) });
      }
    }
    report.ms += now() - t0;
  }

  return {
    enabled: Boolean(options), modules, renders,
    /** The boot is over: installs from now on report their warm-up in their own result. */
    booted: () => { booted = true; },
    /** The page and route bundles of the shell and the serving zones in Node's module cache now: { total, loaded, missing }. */
    loaded() {
      const all = bundles(null).concat(...[...ctx.zones.values()].map((z) => bundles(z)));
      const missing = all.filter(({ file }) => { try { return !require.cache[fs.realpathSync(file)]; } catch { return true; } }).map((b) => b.page);
      return { total: all.length, loaded: all.length - missing.length, missing };
    },
    /** What the boot's warm-up did: { ms, modules, failed, routes }, or null when it is off. */
    report: () => (options ? { ...report, ms: +report.ms.toFixed(1) } : null),
  };
}

module.exports = { createWarm, warmOptions, warmFromText };
