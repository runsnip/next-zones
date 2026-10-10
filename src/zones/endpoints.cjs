"use strict";
/*
 * The URLs Zones serves of its own: none unless the shell declares them (zoneConfig({ mount: "/", endpoints })), or
 * createZones({ endpoints }) does (false: none). All under one base path, "/_next-zones" unless changed:
 *
 *   events  GET  <base>/events                         swap events for <ZoneUpdates />, public
 *   health  GET  <base>/health                         200 once Zones serves; details for an admin
 *   metrics GET  <base>/metrics                        Prometheus text, to an admin, with zoneConfig({ metrics: true })
 *   admin   GET  <base>/images                          the zone images in the store, by zone, with the active version
 *           GET  <base>/images/<zone>/<version>         one zone image: built with, live pull, integrity
 *           POST <base>/images/<zone>/<version>/pull    Zones pulls it from its sources (a ping: the zone must allow live pulls)
 *           POST <base>/images/<zone>/<version>/install installs, swaps to or rolls back to it (pulled first, as a ping,
 *                                                      when the store lacks it)
 *           DELETE <base>/images/<zone>/<version>       removes it from the store (never the active version)
 *           POST <base>/prune?keep=2[&dry=1]           removes zone images no longer needed (prune.cjs)
 *           POST <base>/collect?keep=2                 collects old versions' loaded code and caches
 *           POST <base>/policy                         replaces the instrumentation policy
 *           <base>/debug, <base>/bench                 with createZones({ debug: true })
 *   mcp     POST <mcp path>                            Zones' MCP server (mcp.cjs), with zoneConfig({ mcp }), whatever
 *                                                      groups are declared
 *
 * Admin means `Authorization: Bearer <adminToken>`, or a request from the same machine when no token is configured.
 * A zone image never travels over these endpoints: they ask Zones to pull it, and Zones fetches it from its sources.
 */
const fs = require("node:fs");
const path = require("node:path");
const { ZoneError } = require("./context.cjs");

function createEndpoints(ctx, { installer, collector, bench, debugInfo }) {
  const isLocal = (req) => ["127.0.0.1", "::1", "::ffff:127.0.0.1"].includes(req.socket.remoteAddress);
  const authorized = (req) => (ctx.options.adminToken ? req.headers.authorization === `Bearer ${ctx.options.adminToken}` : isLocal(req));
  const json = (res, status, body) => res.writeHead(status, { "content-type": "application/json" }).end(JSON.stringify(body, null, 1));
  const refusal = (res, error) => {
    /* A refusal is a 409; anything else is Zones' own failure, answered (and logged), never left hanging. */
    const refused = error instanceof ZoneError;
    if (!refused) console.error(error);
    return json(res, refused ? 409 : 500, refused ? { refused: error.message } : { failed: String(error?.message ?? error) });
  };
  const NAME = /^[a-z0-9][a-z0-9-]*$/, VERSION = /^[A-Za-z0-9._-]+$/;
  const readIdentity = (dir) => { try { return JSON.parse(fs.readFileSync(path.join(dir, "zone.json"), "utf8")); } catch { return null; } };
  const summary = (identity) => ({
    version: identity.version, active: ctx.zones.get(identity.name)?.version === identity.version, livePull: identity.livePull === true,
    built: identity.built, integrity: identity.integrity ? { digest: identity.integrity.digest, files: identity.integrity.files } : null,
  });

  function list() {
    const zones = {};
    if (!fs.existsSync(ctx.store)) return zones;
    for (const zone of fs.readdirSync(ctx.store).filter((z) => NAME.test(z))) {
      const items = fs.readdirSync(path.join(ctx.store, zone)).filter((v) => VERSION.test(v) && !v.startsWith("."))
        .map((v) => readIdentity(path.join(ctx.store, zone, v))).filter(Boolean).map(summary);
      if (items.length) zones[zone] = items;
    }
    return zones;
  }

  async function remove(zone, version) {
    if (ctx.zones.get(zone)?.version === version) throw new ZoneError(`zone "${zone}" ${version} is active: install another version first`);
    const dir = path.join(ctx.store, zone, version);
    if (!fs.existsSync(path.join(dir, "zone.json"))) return false;
    /* Loaded once (a rollback target): unloaded first, unless Zones still shares modules it instantiated (D9). */
    const { pinned } = await collector.collect({ only: `${zone}@${version}` });
    if (pinned.length) throw new ZoneError(`zone "${zone}" ${version} cannot be removed while Zones runs: other versions share modules it loaded first (restart Zones, then remove it)`);
    await fs.promises.rm(dir, { recursive: true, force: true });
    return true;
  }

  async function admin(req, res, url, sub, declared) {
    if (!authorized(req)) return json(res, 401, { error: "next-zones: these endpoints need the admin token" });
    try {
      /* With debug on and admin not declared, only debug and bench. */
      if (!declared.admin && sub !== "/debug" && sub !== "/bench") return json(res, 404, { error: "not found" });
      if (sub === "/images" && req.method === "GET") return json(res, 200, { zones: list() });
      const image = /^\/images\/([^/]+)\/([^/]+)(\/install|\/pull)?$/.exec(sub);
      if (image) {
        const [, zone, version, action] = image;
        if (!NAME.test(zone) || !VERSION.test(version)) return json(res, 400, { error: "a zone name and a version are expected" });
        const dir = path.join(ctx.store, zone, version);
        if (action === "/install" && req.method === "POST") return json(res, 200, await installer.installVersion(zone, version, { via: "ping" }));
        if (action === "/pull" && req.method === "POST") return json(res, 200, await installer.pullVersion(zone, version, { via: "ping" }));
        if (action) return json(res, 405, { error: `${req.method} is not supported here` });
        if (req.method === "GET") {
          const identity = readIdentity(dir);
          return identity ? json(res, 200, { name: zone, ...summary(identity) }) : json(res, 404, { error: `zone "${zone}" ${version} is not in the store` });
        }
        if (req.method === "DELETE") return (await remove(zone, version)) ? json(res, 200, { removed: `${zone}@${version}` }) : json(res, 404, { error: `zone "${zone}" ${version} is not in the store` });
        return json(res, 405, { error: `${req.method} is not supported here` });
      }
      if (sub === "/prune" && req.method === "POST") {
        const keep = url.searchParams.has("keep") ? Number(url.searchParams.get("keep")) : undefined;
        if (keep !== undefined && !(Number.isInteger(keep) && keep >= 0)) return json(res, 400, { error: "keep is a whole number" });
        return json(res, 200, await installer.prune({ keep, dryRun: url.searchParams.get("dry") === "1" }));
      }
      if (sub === "/collect" && req.method === "POST") return json(res, 200, await collector.collect({ keep: Number(url.searchParams.get("keep") ?? 2) }));
      if (sub === "/policy" && req.method === "POST") {
        let body = "";
        for await (const chunk of req) body += chunk;
        ctx.policy = JSON.parse(body);
        return json(res, 200, ctx.policy);
      }
      if (ctx.options.debug && sub === "/bench" && req.method === "POST") {
        const n = (k, d) => Number(url.searchParams.get(k) ?? d);
        return json(res, 200, await bench({ zone: url.searchParams.get("zone") ?? "blog", runs: n("runs", 300), pad: n("pad", 212), padDynamic: n("dynamic", 75), lruFill: n("lru", 2000) }));
      }
      if (ctx.options.debug && sub === "/debug") return json(res, 200, await debugInfo(url));
    } catch (error) {
      return refusal(res, error);
    }
    return json(res, 404, { error: "not found" });
  }

  function events(req, res) {
    res.writeHead(200, { "content-type": "text/event-stream", "cache-control": "no-cache, no-transform", connection: "keep-alive" });
    res.write(": next-zones\n\n");
    ctx.listeners.add(res);
    const keepAlive = setInterval(() => res.write(": ping\n\n"), 25_000);   // keeps proxies from closing it
    req.on("close", () => { clearInterval(keepAlive); ctx.listeners.delete(res); });
  }

  /* What Zones serves now: the active versions, the zones that failed at boot, uptime and memory. */
  function status() {
    const failed = Object.entries(installer.boot()).filter(([, r]) => !r.ok).map(([zone, r]) => ({ zone, version: r.version, error: r.error }));
    return {
      ok: true, degraded: failed.length > 0, failed,
      zones: Object.fromEntries([...ctx.zones.values()].map((z) => [z.name, z.version])),
      uptimeS: Math.round(process.uptime()), rssMB: +(process.memoryUsage().rss / 1048576).toFixed(1), reclaimed: ctx.reclaimed,
    };
  }

  /* Health, for a supervisor (Docker's HEALTHCHECK): 200 once Zones serves. A zone that failed at boot does not make it
     unhealthy, since a restart would not fix its build: it is reported as degraded. Details only to an admin. */
  function health(req, res) {
    const now = status();
    if (!authorized(req)) return json(res, 200, { ok: true, degraded: now.degraded });
    return json(res, 200, now);
  }

  /** Answers a request for one of the declared endpoints; returns false when the request is not for them. */
  async function handle(req, res, url) {
    /* Zones' MCP server (mcp.cjs), at its own path, whatever endpoints are declared. */
    if (ctx.mcp && (await ctx.mcp.handle(req, res, url))) return true;
    const declared = ctx.endpoints;
    /* The metrics store as Prometheus text, to an admin (metrics.cjs), when the shell turned metrics on: under the
       declared base, or the default one when no endpoint group is declared. */
    if (ctx.metrics && url.pathname === `${declared?.base ?? "/_next-zones"}/metrics` && req.method === "GET") {
      if (!authorized(req)) { json(res, 401, { error: "next-zones: these endpoints need the admin token" }); return true; }
      const { render, CONTENT_TYPE } = require("../metrics.cjs");
      res.writeHead(200, { "content-type": CONTENT_TYPE, "cache-control": "no-store" });
      res.end(render());
      return true;
    }
    if (!declared) return false;
    const { base } = declared;
    if (url.pathname !== base && !url.pathname.startsWith(`${base}/`)) return false;
    const sub = url.pathname.slice(base.length);
    if (sub === "/events" && req.method === "GET" && declared.events) { events(req, res); return true; }
    if (sub === "/health" && req.method === "GET" && declared.health) { health(req, res); return true; }
    if (declared.admin || ctx.options.debug) { await admin(req, res, url, sub, declared); return true; }
    json(res, 404, { error: "not found" });
    return true;
  }

  return { handle, status, list };
}

module.exports = { createEndpoints };
