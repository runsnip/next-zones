"use strict";
/*
 * What Next reads from the shell's manifests, with the zones added: the app paths (the overlay), the prerendered
 * routes, the server actions, and each zone route's own client reference manifest with the zone's main chunk.
 */
const { clientManifestForZone } = require("./client-manifest.cjs");

function createManifests(ctx) {
  const prerenderMerged = new WeakMap();               // the shell's prerender manifest → { revision, value }
  const actionsMerged = new WeakMap();                 // the shell's actions manifest → { revision, value }
  const overlays = new Map();                          // the shell's app-paths manifest → { generation, value }
  const augmented = new WeakMap();                     // a zone's client reference manifest → its copy with main chunks

  /** The shell's prerender manifest with every zone's prerendered routes added. */
  function withZonePrerenders(value) {
    if (!ctx.zones.size) return value;
    const known = prerenderMerged.get(value);
    if (known && known.revision === ctx.zonesRevision) return known.value;
    const next = { ...value, routes: { ...value.routes }, dynamicRoutes: { ...value.dynamicRoutes },
      notFoundRoutes: [...(value.notFoundRoutes ?? [])] };
    for (const z of ctx.zones.values()) {
      Object.assign(next.routes, z.prerender.routes);
      Object.assign(next.dynamicRoutes, z.prerender.dynamicRoutes);
      next.notFoundRoutes.push(...z.prerender.notFoundRoutes);
    }
    prerenderMerged.set(value, { revision: ctx.zonesRevision, value: next });
    return next;
  }

  /* Server actions: the shared manifest is the shell's, so every zone's actions are merged into it. Action ids are
     content hashes, so they do not collide; a worker key ("app/blog/page") names the page that holds it. */
  function withZoneActions(value) {
    if (!ctx.zones.size) return value;
    const known = actionsMerged.get(value);
    if (known && known.revision === ctx.zonesRevision) return known.value;
    const next = { ...value, node: { ...value.node }, edge: { ...value.edge } };
    for (const z of ctx.zones.values()) {
      for (const runtime of ["node", "edge"]) {
        for (const [id, entry] of Object.entries(z.actions[runtime] ?? {})) {
          const have = next[runtime][id];
          next[runtime][id] = have ? { ...have, workers: { ...have.workers, ...entry.workers } } : entry;
        }
      }
    }
    actionsMerged.set(value, { revision: ctx.zonesRevision, value: next });
    return next;
  }

  /** The app-paths overlay: the one the last switch assigned (or, for the benchmark, the shell's plus padding). */
  function withZoneAppPaths(value) {
    if (ctx.mergedManifest) return ctx.mergedManifest;
    if (!ctx.zones.size && !ctx.hasPadding) return value;
    const known = overlays.get(value);
    if (known && known.generation === ctx.generation) return known.value;
    const next = { ...value, ...ctx.padding };
    for (const z of ctx.zones.values()) Object.assign(next, z.appPaths);
    overlays.set(value, { generation: ctx.generation, value: next });
    return next;
  }

  /*
   * A zone's main chunks. A build's root main chunks (build-manifest rootMainFiles) load with its own HTML documents
   * only. A zone reached by a soft navigation runs in the shell's document, so modules Turbopack put in the zone's main
   * chunks (and not in the shell's) never load: "module factory is not available". The modules the shell lacks go into
   * one small chunk (stage.cjs), listed first in every client module of the zone's routes. Next freezes the manifests
   * it loads, so this is a copy, made once per manifest.
   */
  function withZoneMainChunks(value, zone) {
    const idMap = zone.idMap ?? {}, urls = zone.chunkUrls ?? {};
    if ((!zone.mainChunks?.length && !Object.keys(idMap).length) || !value?.__RSC_MANIFEST) return value;
    let copy = augmented.get(value);
    if (!copy) {
      const change = { idMap, chunkUrls: urls, mainChunks: zone.mainChunks ?? [] };
      const manifests = Object.fromEntries(Object.entries(value.__RSC_MANIFEST).map(([page, manifest]) => [page, clientManifestForZone(manifest, change)]));
      copy = { ...value, __RSC_MANIFEST: manifests };
      augmented.set(value, copy);
    }
    return copy;
  }


  return { withZonePrerenders, withZoneActions, withZoneAppPaths, withZoneMainChunks };
}

module.exports = { createManifests };
