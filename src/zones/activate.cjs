"use strict";
/*
 * The switch. prepare() builds, from the current state, everything that grows with the app (matchers, the overlay, the
 * router's lists, the segment map, the zones' routes, the rule tables); activate() only assigns what was prepared, in
 * one synchronous step, so no request sees half an install, and bumps the zone's segments (cached misses go lazily).
 */

const { compareRoutes, mergeSorted } = require("./route-order.cjs");

const now = () => performance.now();
/* Whether a list is in Next's route order: checked before merging into it (O(n)), so a merge never builds on a list
   sorted otherwise. */
const inOrder = (list, key) => { for (let i = 1; i < list.length; i++) if (compareRoutes(key(list[i - 1]), key(list[i])) > 0) return false; return true; };
/* The rest of an object without some keys, in one pass: a copy, so the switch can replace the old one whole (a delete
   after a spread puts a large object in V8's slow dictionary mode). */
const without = (object, keys) => { const out = {}; for (const k in object) if (!keys.has(k)) out[k] = object[k]; return out; };

function createActivation(ctx, { rules }) {
  const { normalizeAppPath } = ctx.requireNext("next/dist/shared/lib/router/utils/app-paths");
  const { getSortedRoutes } = ctx.requireNext("next/dist/shared/lib/router/utils");
  const { getRouteMatcher } = ctx.requireNext("next/dist/shared/lib/router/utils/route-matcher");
  const { getRouteRegex } = ctx.requireNext("next/dist/shared/lib/router/utils/route-regex");

  /* The providers whose matchers a zone adds to: app pages and app route handlers (route.ts, metadata routes). Each
     transforms only its own kind out of the zone's manifest. */
  const ZONE_PROVIDERS = ["AppPageRouteMatcherProvider", "AppRouteRouteMatcherProvider"];
  /* And Pages Router pages and API routes, out of the zone's pages manifest. */
  const PAGES_PROVIDERS = ["PagesRouteMatcherProvider", "PagesAPIRouteMatcherProvider"];
  function zoneProviders(server, names = ZONE_PROVIDERS) {
    const found = server.matchers.providers.filter((p) => names.includes(p.constructor.name));
    if (found.length !== names.length) throw new Error(`next-zones: expected Next's ${names.join(", ")}`);
    return found;
  }
  const { escapeStringRegexp } = ctx.requireNext("next/dist/shared/lib/escape-regexp");
  /* Every route of a zone: its app routes and its Pages Router pages. */
  const allRoutes = (z) => z.routes.concat(z.pageRoutes ?? []);

  /** Everything activation needs, built from the current state: O(app), off the switch. `marks` (the benchmark's)
      gets the time of each part, in ms. */
  async function prepare(staged, marks = null) {
    let m0 = now();
    const mark = (name) => { if (marks) { const t1 = now(); marks[name] = (marks[name] ?? 0) + t1 - m0; m0 = t1; } };
    const server = ctx.servers.values().next().value;
    /* Next 16.4 on has no route matchers: it matches from appPathsManifest and appPathRoutes, assigned below. */
    const matched = Boolean(server.matchers);
    const zoneMatchers = matched ? (await Promise.all([
      ...zoneProviders(server).map((p) => p.transform(staged.appPaths)),
      ...(Object.keys(staged.pagePaths ?? {}).length ? zoneProviders(server, PAGES_PROVIDERS).map((p) => p.transform(staged.pagePaths)) : []),
    ])).flat() : [];
    m0 = now();
    const old = ctx.placed.get(staged.name);
    const keep = (m) => !old || !old.matchers.has(m);
    const staticMatchers = matched ? server.matchers.matchers.static.filter(keep).concat(zoneMatchers.filter((m) => !m.isDynamic)) : null;
    const baseDynamic = matched ? server.matchers.matchers.dynamic.filter(keep) : [];
    mark("matchers");
    /* The zone's dynamic matchers in Next's order (getSortedRoutes on its own paths, which also checks them), merged
       into the rest, already in that order (route-order.cjs): O(n), not a sort of every route. */
    const pathOf = (m) => m.definition.pathname;
    const byPath = new Map();
    for (const m of zoneMatchers) if (m.isDynamic) (byPath.get(pathOf(m)) ?? byPath.set(pathOf(m), []).get(pathOf(m))).push(m);
    const zoneDynamic = getSortedRoutes([...byPath.keys()]).flatMap((p) => byPath.get(p));
    let dynamicMatchers;
    if (inOrder(baseDynamic, pathOf)) dynamicMatchers = mergeSorted(baseDynamic, zoneDynamic, pathOf);
    else {
      const all = new Map();
      for (const m of baseDynamic.concat(zoneDynamic)) (all.get(pathOf(m)) ?? all.set(pathOf(m), []).get(pathOf(m))).push(m);
      dynamicMatchers = getSortedRoutes([...all.keys()]).flatMap((p) => all.get(p));
    }
    mark("sortMatchers");
    const appPathRoutes = without(server.appPathRoutes, new Set((old?.pages ?? []).map((page) => normalizeAppPath(page))));
    for (const page of Object.keys(staged.appPaths)) {
      const route = normalizeAppPath(page);
      (appPathRoutes[route] ??= []).push(page);
    }
    mark("appPathRoutes");
    /* The router server's dynamic list, in the order Next builds it (routes-manifest is sorted by getSortedRoutes). */
    const checkerDynamic = new Map();
    const oldDynamic = new Set(old?.dynamicPages ?? []);
    /* The zone's, with their matchers, in Next's order: made once per staged build. */
    staged.routerDynamic ??= (() => {
      const byPage = new Map(staged.dynamicRoutes.map((r) => [r.page, { ...r, match: getRouteMatcher(getRouteRegex(r.page)) }]));
      return getSortedRoutes([...byPage.keys()]).map((p) => byPage.get(p));
    })();
    /* A dynamic page's /_next/data route, as Next adds it to the router's list (filesystem.js): its regex under the
       shell's build id, since Zones reads a request under the zone's as the shell's (server.cjs). */
    staged.routerData ??= (() => {
      const shellBuildId = server.buildId ?? [...ctx.fsCheckers][0]?.buildId;
      return (staged.dataRoutes ?? []).filter((r) => staged.dynamicRoutes.some((d) => d.page === r.page)).map((r) => {
        const re = new RegExp(r.dataRouteRegex.replace(`/${escapeStringRegexp(staged.buildId)}/`, `/${escapeStringRegexp(shellBuildId)}/`));
        return { page: r.page, dataRouteRegex: re.source, match: getRouteMatcher({ re, groups: getRouteRegex(r.page).groups }) };
      });
    })();
    const pageOf = (r) => r.page;
    for (const checker of ctx.fsCheckers) {
      const zonePages = new Set(staged.routerDynamic.map(pageOf));
      /* Next's list holds a dynamic page's data route ahead of the pages, matched on /_next/data paths only: the
         zones' are kept at its head, the old version's out, the new one's in. */
      const isData = (r) => typeof r.dataRouteRegex === "string";
      const oldData = new Set(old?.dataPages ?? []);
      const data = checker.dynamicRoutes.filter((r) => isData(r) && !oldData.has(r.page) && !(staged.routerData.some((d) => d.page === r.page)));
      const pages = checker.dynamicRoutes.filter((r) => !isData(r));
      const base = pages.filter((r) => !oldDynamic.has(r.page) && !zonePages.has(r.page));
      let merged;
      if (inOrder(base, pageOf)) merged = mergeSorted(base, staged.routerDynamic, pageOf);
      else {
        const byPage = new Map(base.concat(staged.routerDynamic).map((r) => [r.page, r]));
        merged = getSortedRoutes([...byPage.keys()]).map((p) => byPage.get(p));
      }
      checkerDynamic.set(checker, data.concat(staged.routerData, merged));
    }
    mark("routerDynamic");
    /* The overlay after the switch, copied here so the switch only assigns it: the old version's pages out, the new
       one's in. */
    const manifest = without(ctx.mergedManifest ?? server.getAppPathsManifest(), new Set(old?.pages ?? []));
    Object.assign(manifest, staged.appPaths);
    /* The pages manifest after the switch, the same way: the old version's pages out, the new one's in. A shell
       without a Pages Router of its own has no _app, _document or _error, which Next loads for every page: the zone's
       stand in (each page bundle renders with its own zone's _app and _document). */
    const pagesManifest = without(ctx.mergedPagesManifest ?? server.pagesManifest ?? {}, new Set([...(old?.pagePages ?? []), ...(old?.systemPages ?? [])]));
    Object.assign(pagesManifest, staged.pagePaths);
    const systemPages = [];
    for (const [page, file] of Object.entries(staged.pageSystem ?? {})) if (!pagesManifest[page]) { pagesManifest[page] = file; systemPages.push(page); }
    mark("manifest");
    /* The zones' routes for the router's appFiles and pageFiles after the switch, and the pages with a data route. */
    const others = [...ctx.zones.values()].filter((z) => z.name !== staged.name);
    const nextZoneAppFiles = new Set(others.flatMap((z) => z.routes).concat(staged.routes));
    const nextZonePageFiles = new Set(others.flatMap((z) => z.pageRoutes ?? []).concat(staged.pageRoutes ?? []));
    const nextZoneDataRoutes = new Set(others.flatMap((z) => (z.dataRoutes ?? []).map((r) => r.page)).concat((staged.dataRoutes ?? []).map((r) => r.page)));
    const nextZoneBuildIds = new Set(others.filter((z) => z.pageRoutes?.length).map((z) => z.buildId).concat(staged.pageRoutes?.length ? [staged.buildId] : []));
    /* The segment → zone map after the switch, copied here so the switch only assigns it. */
    const nextSegmentZone = new Map(ctx.segmentZone);
    if (old) for (const route of old.routes) nextSegmentZone.delete(route.split("/")[1]);
    for (const route of allRoutes(staged)) nextSegmentZone.set(route.split("/")[1], staged);
    mark("segments");
    /* The zones' routing rules after the switch (aliases included): compiled here, assigned by the switch. */
    const tables = rules.buildRuleTables([...ctx.zones.values()].filter((z) => z.name !== staged.name).concat(staged));
    mark("rules");
    const segments = new Set(allRoutes(staged).concat(old?.routes ?? []).map((r) => r.split("/")[1] ?? ""));
    return {
      revision: ctx.revision, staged, old, staticMatchers, checkerDynamic, tables, manifest, segmentZone: nextSegmentZone, zoneAppFiles: nextZoneAppFiles, dynamicMatchers, appPathRoutes, segments,
      zoneMatchers: new Set(zoneMatchers), pages: Object.keys(staged.appPaths),
      pagesManifest, systemPages, zonePageFiles: nextZonePageFiles, zoneDataRoutes: nextZoneDataRoutes, zoneBuildIds: nextZoneBuildIds,
    };
  }

  async function activate(staged, t, plan) {
    if (!plan || plan.revision !== ctx.revision) plan = await prepare(staged);
    let s0 = now();
    /* What prepare built, assigned: nothing here grows with the app. */
    ctx.mergedManifest = plan.manifest;
    ctx.zones.set(staged.name, staged);
    ctx.zonesRevision++;
    Object.assign(ctx.ruleTables, plan.tables);
    ctx.segmentZone = plan.segmentZone;
    t.overlay += now() - s0; s0 = now();
    ctx.mergedPagesManifest = plan.pagesManifest;
    for (const server of ctx.servers) {
      server.appPathsManifest = ctx.mergedManifest;
      server.pagesManifest = plan.pagesManifest;
      server.appPathRoutes = plan.appPathRoutes;
      if (server.matchers) {
        server.matchers.matchers.static = plan.staticMatchers;
        server.matchers.matchers.dynamic = plan.dynamicMatchers;
      }
      server._cachedPreviewManifest = undefined;          // re-read through the overlay on the next request
    }
    t.reloadMatchers += now() - s0; s0 = now();
    ctx.zoneAppFiles = plan.zoneAppFiles;
    ctx.zonePageFiles = plan.zonePageFiles;
    ctx.zoneDataRoutes = plan.zoneDataRoutes;
    ctx.zoneBuildIds = plan.zoneBuildIds;
    for (const checker of ctx.fsCheckers) checker.dynamicRoutes = plan.checkerDynamic.get(checker);
    t.fsCheck += now() - s0; s0 = now();
    for (const seg of plan.segments) ctx.segmentGeneration.set(seg, (ctx.segmentGeneration.get(seg) ?? 0) + 1);
    t.lru += now() - s0;
    ctx.placed.set(staged.name, {
      matchers: plan.zoneMatchers, pages: plan.pages, routes: allRoutes(staged),
      dynamicPages: staged.dynamicRoutes.map((r) => r.page),
      pagePages: Object.keys(staged.pagePaths ?? {}), systemPages: plan.systemPages, dataPages: staged.routerData.map((r) => r.page),
    });
    ctx.revision++;
  }

  return { prepare, activate };
}

module.exports = { createActivation };
