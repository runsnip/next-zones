"use strict";
/*
 * What Next reads from the shell's manifests, with the zones added: the app paths (the overlay), the prerendered
 * routes, the server actions, and each zone route's own client reference manifest with the zone's main chunk; the
 * shell's and the zones' root layout stylesheets named by the segments below the root (client-manifest.cjs).
 */
const { clientManifestForZone, rootCssBelow } = require("./client-manifest.cjs");

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
    if (!value?.__RSC_MANIFEST) return value;
    let copy = augmented.get(value);
    if (!copy) {
      const change = { idMap, chunkUrls: urls, mainChunks: zone.mainChunks ?? [] };
      const plain = !change.mainChunks.length && !Object.keys(idMap).length;
      const manifests = Object.fromEntries(Object.entries(value.__RSC_MANIFEST).map(([page, manifest]) => [page, plain ? rootCssBelow(manifest, page) : clientManifestForZone(manifest, change, page)]));
      copy = { ...value, __RSC_MANIFEST: manifests };
      augmented.set(value, copy);
    }
    return copy;
  }


  /* A shell route's client reference manifest: its root layout's stylesheets named below the root, as a zone's are,
     so a soft navigation from a zone back to the shell brings them. Whether zones are installed yet or not: Next keeps
     a manifest it has loaded, and a zone may be installed after. */
  function withShellRootCss(value) {
    if (!value?.__RSC_MANIFEST) return value;
    let copy = augmented.get(value);
    if (!copy) {
      copy = { ...value, __RSC_MANIFEST: Object.fromEntries(Object.entries(value.__RSC_MANIFEST).map(([page, manifest]) => [page, rootCssBelow(manifest, page)])) };
      augmented.set(value, copy);
    }
    return copy;
  }

  /*
   * A route's react-loadable manifest: the chunks next/dynamic preloads while rendering, under their new URLs where a
   * chunk was written again (zone-client.cjs), as in the client reference manifest. Copied once per manifest.
   */
  function withZoneLoadable(value, zone) {
    const urls = zone.chunkUrls ?? {};
    if (!Object.keys(urls).length || !value || typeof value !== "object") return value;
    let copy = augmented.get(value);
    if (!copy) {
      const renamed = (file) => (urls[`/_next/${file}`] ?? `/_next/${file}`).slice("/_next/".length);
      copy = Object.fromEntries(Object.entries(value).map(([key, entry]) => [key, Array.isArray(entry?.files) ? { ...entry, files: entry.files.map(renamed) } : entry]));
      augmented.set(value, copy);
    }
    return copy;
  }

  /*
   * The shell's build manifest, from Next 16.4: `pagesChunkGroupBootstrapParams` names, by page, the runtime's
   * registration Next writes inline in the page's document (`TURBOPACK.push({otherChunks, runtimeModuleIds})`); with
   * none, the runtime never starts and the page never hydrates. A zone's page rendered on request has no entry in the
   * shell's: it runs in the shell's document, on the shell's runtime and root main files, so it gets the shell's (the
   * same for every page of a build: its root main files). Read through a proxy, so a zone installed later has it too.
   */
  function withShellBootstrap(value) {
    const params = value?.pagesChunkGroupBootstrapParams;
    if (!params || typeof params !== "object") return value;
    let copy = augmented.get(value);
    if (!copy) {
      const shell = params["/_not-found/page"] ?? Object.values(params)[0];
      copy = { ...value, pagesChunkGroupBootstrapParams: new Proxy(params, {
        get: (target, page) => (page in target || typeof page !== "string" || !page.endsWith("/page") ? target[page] : shell),
      }) };
      augmented.set(value, copy);
    }
    return copy;
  }

  return { withZonePrerenders, withZoneActions, withZoneAppPaths, withZoneMainChunks, withShellRootCss, withZoneLoadable, withShellBootstrap };
}

module.exports = { createManifests };
