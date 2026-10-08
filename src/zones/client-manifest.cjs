"use strict";
/*
 * A zone's client reference manifest (one page's __RSC_MANIFEST entry), made to run in the shell's document: what
 * Zones does when it loads one (manifests.cjs) and what the server link writes to disk (../link-app.mjs).
 * - Every client module's chunks: the zone's main chunk first, and the chunks written again under their new URLs.
 * - Remapped module ids (zone-client.cjs), and the SSR, RSC and edge mappings, keyed by client module id, given the new
 *   ids where the old ones were.
 */
function clientManifestForZone(manifest, { idMap = {}, chunkUrls = {}, mainChunks = [] }) {
  const chunksOf = (list) => [...mainChunks.filter((c) => !list.includes(c)), ...list.map((c) => chunkUrls[c] ?? c)];
  const withMain = (entry) => ({ ...entry, id: idMap[entry.id] ?? entry.id, chunks: chunksOf(entry.chunks) });
  const withNewIds = (mapping) => {
    if (!mapping) return mapping;
    const next = { ...mapping };
    for (const [from, to] of Object.entries(idMap)) if (mapping[from] !== undefined) next[to] = mapping[from];
    return next;
  };
  return {
    ...manifest,
    clientModules: Object.fromEntries(Object.entries(manifest.clientModules ?? {}).map(([key, entry]) => [key, withMain(entry)])),
    ssrModuleMapping: withNewIds(manifest.ssrModuleMapping),
    edgeSSRModuleMapping: withNewIds(manifest.edgeSSRModuleMapping),
    rscModuleMapping: withNewIds(manifest.rscModuleMapping),
    edgeRscModuleMapping: withNewIds(manifest.edgeRscModuleMapping),
    entryJSFiles: Object.fromEntries(Object.entries(manifest.entryJSFiles ?? {}).map(([key, files]) => [key, files.map((f) => (chunkUrls[`/_next/${f}`] ?? `/_next/${f}`).slice("/_next/".length))])),
  };
}

module.exports = { clientManifestForZone };
