"use strict";
/*
 * What Zones measures of itself, into the metrics store (../metrics.cjs) the shell opens with zoneConfig({ metrics:
 * true }): every request (its zone, the zone's active version, its status class, how long), the process (memory, the
 * event loop's delay), the module registry and reclaims, and which version of each zone is active. Installs, pulls
 * and prunes are measured where they run (install.cjs).
 */
const { monitorEventLoopDelay } = require("node:perf_hooks");
const metrics = require("../metrics.cjs");

const REQUEST_BUCKETS = [0.001, 0.0025, 0.005, 0.01, 0.025, 0.05, 0.1, 0.25, 0.5, 1, 2.5, 5, 10];

function installZoneMetrics(ctx) {
  metrics.open();
  const requests = metrics.counter("nextzones_requests_total", { help: "Requests served, by zone, its active version and status class" });
  const duration = metrics.histogram("nextzones_request_duration_seconds", { help: "Time to the end of each response, by zone", buckets: REQUEST_BUCKETS });

  /* The process. */
  const memory = {
    rss: metrics.gauge("process_resident_memory_bytes", { help: "Resident memory" }),
    heapUsed: metrics.gauge("nodejs_heap_used_bytes", { help: "V8 heap in use" }),
    heapTotal: metrics.gauge("nodejs_heap_total_bytes", { help: "V8 heap allocated" }),
    external: metrics.gauge("nodejs_external_memory_bytes", { help: "Memory of C++ objects bound to JavaScript (buffers among them)" }),
  };
  const loop = monitorEventLoopDelay({ resolution: 10 });
  loop.enable();
  const loopDelay = metrics.gauge("nodejs_eventloop_delay_seconds", { help: "Event loop delay since the last read, by quantile" });
  const uptime = metrics.gauge("process_uptime_seconds", { help: "Seconds since the process started" });
  /* Zones. */
  const registryModules = metrics.gauge("nextzones_registry_modules", { help: "Server modules the registry shares across builds" });
  const registryShared = metrics.counter("nextzones_registry_shared_total", { help: "Times a build used a module another build had loaded" });
  const reclaims = metrics.counter("nextzones_reclaims_total", { help: "Last-resort collections run once idle after a version was collected" });
  const active = metrics.gauge("nextzones_zone_active", { help: "1 for the version of each zone that serves" });
  let lastShared = 0, lastReclaims = 0, lastActive = new Map();
  metrics.collect(() => {
    const m = process.memoryUsage();
    memory.rss.set(m.rss); memory.heapUsed.set(m.heapUsed); memory.heapTotal.set(m.heapTotal); memory.external.set(m.external);
    for (const [q, v] of [["0.5", loop.percentile(50)], ["0.99", loop.percentile(99)], ["1", loop.max]]) loopDelay.set(v / 1e9, { quantile: q });
    loop.reset();
    uptime.set(process.uptime());
    if (ctx.registry) {
      registryModules.set(ctx.registry.size());
      const shared = ctx.registry.stats.shared;
      if (shared > lastShared) registryShared.inc(shared - lastShared);
      lastShared = shared;
    }
    const reclaimed = ctx.reclaimed?.runs ?? 0;
    if (reclaimed > lastReclaims) reclaims.inc(reclaimed - lastReclaims);
    lastReclaims = reclaimed;
    /* A version that stopped serving reads 0, so a scraper sees the swap. */
    const now = new Map([...ctx.zones.values()].map((z) => [`${z.name}\n${z.version}`, { zone: z.name, version: String(z.version) }]));
    for (const [key, labels] of lastActive) if (!now.has(key)) active.set(0, labels);
    for (const labels of now.values()) active.set(1, labels);
    lastActive = now;
  });

  /** Measures one request, from now to the end of its response. `zoneOf(pathname)` names the zone that serves it. */
  function track(req, res, pathname) {
    const start = process.hrtime.bigint();
    res.once("finish", () => {
      const zone = ctx.zoneOfRoute?.(pathname) ?? null;
      const name = zone?.name ?? (pathname.startsWith("/_next/") ? "static" : "shell");
      const labels = { zone: name, version: zone ? String(zone.version) : "", code: `${Math.floor(res.statusCode / 100)}xx` };
      requests.inc(labels);
      duration.observe(Number(process.hrtime.bigint() - start) / 1e9, { zone: name });
    });
  }

  return { track };
}

module.exports = { installZoneMetrics };
