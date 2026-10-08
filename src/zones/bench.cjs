"use strict";
/*
 * The activation benchmark (debug only; tools/bench/activation.mjs): swaps between two builds of one zone `runs` times
 * at the size of a real app (synthetic padding pages, dynamic among them, and cached misses refilled before each run),
 * and reports every phase's p50, p95 and max, in microseconds.
 */
const path = require("node:path");

const now = () => performance.now();

function createBench(ctx, { staging, activation }) {
  const { normalizeAppPath } = ctx.requireNext("next/dist/shared/lib/router/utils/app-paths");
  const { getSortedRoutes } = ctx.requireNext("next/dist/shared/lib/router/utils");
  const { getRouteMatcher } = ctx.requireNext("next/dist/shared/lib/router/utils/route-matcher");
  const { getRouteRegex } = ctx.requireNext("next/dist/shared/lib/router/utils/route-regex");

  return async function bench({ zone = "blog", versions = ["1", "2"], runs, pad, padDynamic, lruFill }) {
    ctx.padding = {};
    for (let i = 0; i < pad; i++) ctx.padding[i < padDynamic ? `/pad${i}/[id]/page` : `/pad${i}/page`] = `app/pad${i}/page.js`;
    ctx.hasPadding = pad > 0;
    ctx.mergedManifest = null;
    ctx.generation++;
    /* The router server's dynamic list gets the padding's dynamic routes too, as Next would build it from routes-manifest. */
    for (const checker of ctx.fsCheckers) {
      const pads = Object.keys(ctx.padding).filter((pg) => pg.includes("[")).map((pg) => normalizeAppPath(pg));
      const all = checker.dynamicRoutes.filter((r) => !r.page.startsWith("/pad")).concat(pads.map((pg) => ({ page: pg, match: getRouteMatcher(getRouteRegex(pg)) })));
      checker.dynamicRoutes = getSortedRoutes(all.map((r) => r.page)).map((pg) => all.find((r) => r.page === pg));
    }
    for (const server of ctx.servers) { server.appPathsManifest = server.getAppPathsManifest(); server.appPathRoutes = server.getAppPathRoutes(); await server.reloadMatchers?.(); }
    const builds = await Promise.all(versions.map((v) => staging.stage(zone, path.join(ctx.store, zone, v))));
    const samples = [];
    for (let r = 0; r < runs; r++) {
      for (const lru of ctx.lrus) for (let i = 0; i < lruFill / ctx.lrus.size; i++) lru.set(`/miss-${r}-${i}`, { itemPath: `/miss-${r}-${i}`, type: "x", fsPath: "" });
      const t = { prepare: 0, overlay: 0, reloadMatchers: 0, fsCheck: 0, lru: 0, activate: 0 };
      const marks = {};
      const p0 = now();
      const plan = await activation.prepare(builds[r % builds.length], marks);
      t.prepare = now() - p0;
      for (const [k, v] of Object.entries(marks)) t[`prepare.${k}`] = v;
      const s0 = now();
      await activation.activate(builds[r % builds.length], t, plan);
      t.activate = now() - s0;
      samples.push(t);
    }
    const stat = (k) => {
      const v = samples.map((x) => x[k] * 1000).sort((a, b) => a - b);
      return { p50: +v[Math.floor(v.length * 0.5)].toFixed(1), p95: +v[Math.floor(v.length * 0.95)].toFixed(1), max: +v[v.length - 1].toFixed(1) };
    };
    return {
      strategy: "v1", runs, routes: Object.keys(ctx.servers.values().next().value.appPathsManifest).length, lruFill, unit: "µs",
      phases: Object.fromEntries(Object.keys(samples[0]).map((k) => [k, stat(k)])),
    };
  };
}

module.exports = { createBench };
