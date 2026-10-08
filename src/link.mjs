/*
 * The static link: Next's output: "export" in mode "zones". The shell and every zone are exported separately (each
 * zone's own Next config says output: "export"; its image keeps its out/), then linked here into one static site,
 * which any static host serves, with soft navigation between zones in one document. It does at link time what Zones
 * does at install:
 * - each zone's client code against what the document may already hold (zones/zone-client.cjs, the same analysis):
 *   module ids that clash are remapped, the chunks holding them written again under new names, and the modules the
 *   zone's root main chunks hold and the shell's lack gathered into one main chunk of its own;
 * - each zone's exported pages (HTML and flight .txt) carry the shell's build id, the zone's main chunk, the remapped
 *   ids and chunk URLs (zones/payload.cjs).
 * The site: the shell's out/, then each zone's pages under its mount and its _next/ files beside the shell's.
 */
import fs from "node:fs";
import path from "node:path";
import { Worker } from "node:worker_threads";
import { createRequire } from "node:module";
import { fileURLToPath } from "node:url";

const require = createRequire(import.meta.url);
const { payloadTransform, payloadKind } = require("./zones/payload.cjs");
const { buildKeyOf } = require("./zones/describe.cjs");
const ZONES_DIR = path.join(path.dirname(fileURLToPath(import.meta.url)), "zones");

const runWorker = (file, workerData) => new Promise((resolve, reject) => {
  const worker = new Worker(path.join(ZONES_DIR, file), { workerData });
  worker.once("message", resolve);
  worker.once("error", reject);
});

/** Whether a build (its .next) was made with Next's output: "export". */
export function isExport(dotNext) {
  try { return JSON.parse(fs.readFileSync(path.join(dotNext, "required-server-files.json"), "utf8")).config.output === "export"; } catch { return false; }
}

const buildIdOf = (dotNext) => fs.readFileSync(path.join(dotNext, "BUILD_ID"), "utf8").trim();

/**
 * Links the shell's export (shellDir/out, shellDir/.next) and each zone image ({ zone, mount, dir }: an image's folder,
 * its build at the root and its export in out/) into `site`. Returns { site, zones: [{ zone, remapped, chunks }] }.
 */
export async function linkStaticSite({ shellDir, images, site }) {
  const shellDist = path.join(shellDir, ".next");
  const shellBuildId = buildIdOf(shellDist);
  fs.rmSync(site, { recursive: true, force: true });
  fs.cpSync(path.join(shellDir, "out"), site, { recursive: true });
  const chunksDir = path.join(site, "_next", "static", "chunks");
  let known = null;
  const linked = [];
  for (const { zone, mount, dir } of images) {
    const exported = path.join(dir, "out");
    if (!fs.existsSync(exported)) throw new Error(`${zone}: its image has no export (its Next config must say output: "export", as the shell's does)`);
    const buildId = buildIdOf(dir), buildKey = buildKeyOf(dir);
    /* The same analysis as an install (zone-client.cjs): the chunks it writes again go straight into the site. */
    const result = await runWorker("zone-client.cjs", { dist: dir, shellDist, buildKey, outDir: chunksDir, known });
    if (result.missingUsed.length) throw new Error(`${zone} uses client runtime features the shell's runtime lacks (${result.missingUsed.join(", ")}): import @runsnip/next-zones/client in the shell (render <ZoneUpdates />), which gives its runtime every feature, and rebuild the shell`);
    known ??= Object.fromEntries(Object.entries(result.shellModules ?? {}).map(([id, h]) => [id, [...h]]));
    for (const [id, hashes] of Object.entries(result.zoneModules ?? {})) known[id] = [...new Set([...(known[id] ?? []), ...hashes])];
    const mainChunks = [];
    if (result.mainItems) {
      const file = `zone-${zone}-${buildKey}-main.js`;
      fs.writeFileSync(path.join(chunksDir, file), `(globalThis.TURBOPACK||(globalThis.TURBOPACK=[])).push(["object"==typeof document?document.currentScript:void 0,${result.mainItems.join(",")}]);\n`);
      mainChunks.push(`/_next/static/chunks/${file}`);
    }
    const chunkUrls = Object.fromEntries(Object.entries(result.chunkMap).map(([from, to]) => [`/_next/${from}`, `/_next/${to}`]));
    const rewrite = payloadTransform({ buildId, shellBuildId, mainChunks, idMap: result.idMap, chunkUrls });
    /* The zone's files: its _next/ files beside the shell's (one name, one content), its pages under its mount. */
    const segment = mount.slice(1);
    const copyTree = (from, to, transform) => {
      for (const entry of fs.readdirSync(from, { withFileTypes: true })) {
        const source = path.join(from, entry.name), target = path.join(to, entry.name);
        if (entry.isDirectory()) { copyTree(source, target, transform); continue; }
        if (!transform && fs.existsSync(target)) continue;
        fs.mkdirSync(path.dirname(target), { recursive: true });
        /* Flight data: an exported page's .txt (beside its .html) and Next's __next.*.txt segment files. A public
           .txt is copied as it is. */
        const flight = /\.html$/.test(entry.name) || (/\.txt$/.test(entry.name) && (entry.name.startsWith("__next.") || fs.existsSync(source.replace(/\.txt$/, ".html"))));
        if (transform && flight) fs.writeFileSync(target, rewrite(fs.readFileSync(source), payloadKind(entry.name)));
        else fs.copyFileSync(source, target);
      }
    };
    copyTree(path.join(exported, "_next"), path.join(site, "_next"), false);
    for (const file of [`${segment}.html`, `${segment}.txt`]) {
      if (fs.existsSync(path.join(exported, file))) fs.writeFileSync(path.join(site, file), rewrite(fs.readFileSync(path.join(exported, file)), payloadKind(file)));
    }
    if (fs.existsSync(path.join(exported, segment))) copyTree(path.join(exported, segment), path.join(site, segment), true);
    linked.push({ zone, remapped: Object.keys(result.idMap).length, chunks: Object.keys(result.chunkMap).length, mainChunk: mainChunks.length > 0 });
  }
  return { site, zones: linked };
}
