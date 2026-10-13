"use strict";
/*
 * A zone's client reference manifest (one page's __RSC_MANIFEST entry), made to run in the shell's document: what
 * Zones does when it loads one (manifests.cjs) and what the server link writes to disk (../link-app.mjs).
 * - Every client module's chunks: the zone's main chunk first, and the chunks written again under their new URLs.
 * - Remapped module ids (zone-client.cjs), and the SSR, RSC and edge mappings, keyed by client module id, given the new
 *   ids where the old ones were.
 * - The root layout's stylesheets named by the segments below it (rootCssBelow).
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
    entryCSSFiles: rootCssBelow(manifest).entryCSSFiles,
    entryJSFiles: Object.fromEntries(Object.entries(manifest.entryJSFiles ?? {}).map(([key, files]) => [key, files.map((f) => (chunkUrls[`/_next/${f}`] ?? `/_next/${f}`).slice("/_next/".length))])),
  };
}

/*
 * The root layout's stylesheets, named by the segments below it instead. Every zone and the shell has a root layout
 * of its own, all at the segment "", so a soft navigation between two of them keeps the root the browser has: Next
 * renders from the first segment that differs, and leaves out the stylesheets of the layouts above it (they are
 * loaded, it assumes: walk-tree-with-flight-router-state, getLinkAndScriptTags). A zone's own stylesheet (its
 * globals.css, through its root layout) then never reaches the shell's document, nor the shell's a zone's. Named by
 * every other entry (each layout and page below the root, a built-in not-found), it comes with the first segment
 * rendered, on a soft navigation and on a load; React hoists it into the head and keeps it, as Next keeps a layout's
 * stylesheets after leaving it. The root keeps none, so it does not count them as loaded. The root layout is the
 * shortest `…/app/layout` entry.
 */
function rootCssBelow(manifest) {
  const css = manifest?.entryCSSFiles;
  if (!css) return manifest;
  const root = Object.keys(css).filter((k) => /(^|\/)app\/layout$/.test(k) && !k.includes("/node_modules/")).sort((a, b) => a.length - b.length)[0];
  if (!root || !css[root]?.length) return manifest;
  const moved = Object.fromEntries(Object.entries(css).map(([key, files]) => {
    if (key === root) return [key, []];
    const paths = new Set(files.map((f) => f.path));
    return [key, [...css[root].filter((f) => !paths.has(f.path)), ...files]];
  }));
  return { ...manifest, entryCSSFiles: moved };
}

module.exports = { clientManifestForZone, rootCssBelow };
