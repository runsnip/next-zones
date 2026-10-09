"use strict";
/*
 * Staging a zone image, before its switch:
 * - stage(): reads the zone's zone.json (what Zones needs, written at build time: describe.cjs), checks the build's
 *   integrity once in a worker, and checks every rule (mount, aliases, routing rules, versions, config that must
 *   equal the shell's, what a zone may not bring);
 * - analyseZoneClient(): the zone's client code against what a browser may hold, in a worker thread (zone-client.cjs):
 *   conflicting module ids remapped, the main chunk, the runtime check;
 * - seedCache(): the zone image's writable cache from its build, in a worker thread (zone-seed.cjs).
 */
const fs = require("node:fs");
const path = require("node:path");
const crypto = require("node:crypto");
const { Worker } = require("node:worker_threads");
const { ZoneError } = require("./context.cjs");
const { describeBuild, buildKey, FORMAT, CONFIG_KEYS } = require("./describe.cjs");
const { imageKeysDiffering } = require("./image-config.cjs");

const runWorker = (file, workerData) => new Promise((resolve, reject) => {
  const worker = new Worker(path.join(__dirname, file), { workerData });
  worker.once("message", resolve);
  worker.once("error", reject);
});

function createStaging(ctx) {
  /* The shell's own facts, read once: they do not change while Zones runs. */
  let shellFacts = null;
  function shell() {
    if (shellFacts) return shellFacts;
    const dist = path.join(ctx.shell, ".next");
    const config = JSON.parse(fs.readFileSync(path.join(dist, "required-server-files.json"), "utf8")).config;
    shellFacts = {
      routes: Object.values(JSON.parse(fs.readFileSync(path.join(dist, "app-path-routes-manifest.json"), "utf8"))),
      buildId: fs.readFileSync(path.join(dist, "BUILD_ID"), "utf8").trim(),
      config: Object.fromEntries(CONFIG_KEYS.map((key) => [key, config[key] ?? null])),
    };
    return shellFacts;
  }
  /* Builds whose integrity was checked: `${dist}:${digest}`. */
  const verified = new Set();
  /** Hashes a zone image folder in a worker: { digest, files }. */
  const verifyImage = (dist) => runWorker("zone-verify.cjs", { dist });
  /** Records a folder as checked (a pulled zone image, checked before it was moved into the store). */
  const markVerified = (dist, digest) => verified.add(`${dist}:${digest}`);

  /**
   * Reads a zone's build: what activation needs, prepared before the switch. One file is read, asynchronously: the
   * zone.json `next-zones build` wrote, with what Zones needs (describe.cjs) and the build's integrity, checked in a
   * worker the first time. A build without them is described here, from its manifests.
   */
  async function stage(name, dist) {
    const t0 = performance.now();
    const identityFile = path.join(dist, "zone.json");
    let identity;
    try { identity = JSON.parse(await fs.promises.readFile(identityFile, "utf8")); }
    catch { throw new ZoneError(`no zone build at ${dist} (zone.json is missing or unreadable)`); }
    /* Same Next and React as the shell's: they are shared, so a zone built against others is refused. */
    if (!identity.built) throw new ZoneError(`zone "${name}": its zone.json does not say which Next and React it was built with (rebuild it with next-zones build)`);
    for (const [pkg, built] of Object.entries(identity.built)) {
      const running = ctx.requireNext(`${pkg}/package.json`).version;
      if (built !== running) throw new ZoneError(`zone "${name}" was built with ${pkg} ${built}; this Zones runs ${pkg} ${running}`);
    }
    if (identity.name !== name) throw new ZoneError(`the store's ${dist} holds zone "${identity.name}", not "${name}"`);
    /* The build as it was stored: checked once per build, off the event loop. */
    if (identity.integrity && !verified.has(`${dist}:${identity.integrity.digest}`)) {
      const found = await verifyImage(dist);
      if (found.digest !== identity.integrity.digest) {
        throw new ZoneError(`zone "${name}" ${identity.version}: the stored build differs from the one built (${found.files} files, ${identity.integrity.files} at build time): copy it again, or rebuild it`);
      }
      verified.add(`${dist}:${identity.integrity.digest}`);
    }
    const t1 = performance.now();
    const info = identity.install?.format === FORMAT ? identity.install : describeBuild(dist);
    ctx.zoneDists.add(path.resolve(dist) + path.sep);
    ctx.zoneDists.add(fs.realpathSync(dist) + path.sep);          // Node names modules by their real path (/var → /private/var)

    /* The URL segment the zone owns ("/blog"): every route of the zone must be under it. */
    const mount = identity.mount;
    if (mount === "/") throw new ZoneError(`zone "${name}" claims /, which is the shell's: the shell is the app Zones starts with`);
    if (ctx.endpoints && `/${ctx.endpoints.base.split("/")[1]}` === mount) throw new ZoneError(`zone "${name}": ${mount} is where Zones serves its own URLs (endpoints.base ${ctx.endpoints.base})`);
    if (!/^\/[a-z0-9][a-z0-9-]*$/.test(mount)) throw new ZoneError(`zone "${name}": mount must be one URL segment like "/blog", got "${mount}"`);
    const serverDir = path.join(dist, "server");
    const appPaths = Object.fromEntries(Object.entries(info.appPaths).map(([page, file]) => [page, path.join(dist, file)]));
    const routes = info.routes;
    /* One proxy and one instrumentation per server, the shell's: a zone's own would silently not run (an auth gate
       skipped), so such a zone is refused. Its logic belongs in the shell. */
    if (info.proxy) throw new ZoneError(`zone "${name}" has its own proxy.ts, which would not run under Zones: move it into the shell's proxy`);
    /* Aliases: root URLs the zone serves. The source's first segment must be free (not the shell's, not another zone's
       mount or alias); the destination must be under the zone's mount. */
    const aliases = identity.aliases ?? [];
    for (const a of aliases) {
      const first = /^\/([a-z0-9][a-z0-9-]*)(\/|$)/.exec(a.source ?? "")?.[1];
      if (!first) throw new ZoneError(`zone "${name}": alias source must start with a fixed segment like "/p/:slug", got ${JSON.stringify(a.source)}`);
      if (!(a.destination === mount || a.destination?.startsWith(`${mount}/`))) throw new ZoneError(`zone "${name}": alias ${a.source} must point under ${mount}, got ${a.destination}`);
      if (`/${first}` === mount) throw new ZoneError(`zone "${name}": alias ${a.source} is inside its own mount`);
      for (const z of ctx.zones.values()) {
        if (z.name === name) continue;
        if (z.mount === `/${first}`) throw new ZoneError(`zone "${name}": alias ${a.source} is under zone "${z.name}"'s mount`);
        if ((z.aliases ?? []).some((b) => b.source.split("/")[1] === first)) throw new ZoneError(`zone "${name}": alias ${a.source} overlaps zone "${z.name}"'s aliases`);
      }
    }
    /* public/: served at the root by Next, so a zone's files must live under its mount (public/blog/…). */
    const publicDir = info.publicEntries ? path.join(dist, "public") : null;
    const stray = (info.publicEntries ?? []).filter((entry) => `/${entry}` !== mount);
    if (stray.length) throw new ZoneError(`zone "${name}" has public files outside its mount (put them under public${mount}/): ${stray.join(", ")}`);
    /* The zone's next.config headers, redirects and rewrites: each source under its mount or one of its aliases. */
    const rules = info.rules;
    const ownSegments = new Set([mount, ...aliases.map((a) => `/${a.source.split("/")[1]}`)]);
    for (const [list, entries] of Object.entries(rules)) {
      for (const rule of entries) {
        const first = `/${(rule.source ?? "").split("/")[1] ?? ""}`;
        if (!ownSegments.has(first)) throw new ZoneError(`zone "${name}": its ${list} rule ${rule.source} is outside ${[...ownSegments].join(", ")}`);
      }
    }
    if (identity.clientInstrumentation) throw new ZoneError(`zone "${name}" has an instrumentation-client file, which runs only in its own documents, not when it is reached from the shell: move it into the shell's`);
    /* Pages Router routes: Zones serves a zone's app/ routes only, so a pages/ route would answer the shell's 404. Next's
       own pages (/_app, /_document, /_error, /404, /500) are in every build. */
    let pagesManifest = {};
    try { pagesManifest = JSON.parse(await fs.promises.readFile(path.join(serverDir, "pages-manifest.json"), "utf8")); } catch {}
    const pagesRoutes = Object.keys(pagesManifest).filter((route) => !["/_app", "/_document", "/_error", "/404", "/500"].includes(route));
    if (pagesRoutes.length) throw new ZoneError(`zone "${name}" has Pages Router routes (${pagesRoutes.join(", ")}), not supported under Zones yet: move them into app/`);
    /* Edge routes have their own manifests and sandbox, not proved under Zones. */
    if (info.edgeFunctions.length) throw new ZoneError(`zone "${name}" has edge routes (${info.edgeFunctions.join(", ")}), not supported under Zones yet: use the Node.js runtime`);
    /* What shapes every URL must be the shell's. The image optimizer runs with the shell's images config: a zone that
       set its own, otherwise, is refused, so its images never fail silently (image-config.cjs). */
    const shellNow = shell();
    if (info.missingBuildOptions.length) throw new ZoneError(`zone "${name}" ${identity.version} was not built for Zones (it lacks ${info.missingBuildOptions.join(", ")}): build it with next-zones build`);
    const imageDiffers = imageKeysDiffering(info.config.images, shellNow.config.images);
    if (imageDiffers.length) throw new ZoneError(`zone "${name}": images.${imageDiffers.join(", images.")} differ from the shell's, whose images config serves every zone: put them in the shell's next.config`);
    const differs = ["basePath", "i18n", "trailingSlash", "assetPrefix", "skipTrailingSlashRedirect", "cacheComponents", "partialPrefetching"]
      .filter((key) => JSON.stringify(info.config[key] ?? null) !== JSON.stringify(shellNow.config[key] ?? null));
    if (differs.length) throw new ZoneError(`zone "${name}": ${differs.join(", ")} must equal the shell's (${differs.map((k) => `${k}: ${JSON.stringify(info.config[k])} vs ${JSON.stringify(shellNow.config[k])}`).join("; ")})`);
    const outside = routes.filter((r) => r !== mount && !r.startsWith(`${mount}/`));
    if (outside.length) throw new ZoneError(`zone "${name}" owns ${mount}, but has routes outside it: ${outside.join(", ")}`);
    /* No other zone, and not the shell, may serve under this mount. */
    for (const z of ctx.zones.values()) {
      if (z.name !== name && z.mount === mount) throw new ZoneError(`${mount} already belongs to zone "${z.name}"`);
    }
    const taken = shellNow.routes.filter((r) => r === mount || r.startsWith(`${mount}/`));
    if (taken.length) throw new ZoneError(`${mount} is the shell's: ${taken.join(", ")}`);
    for (const a of aliases) {
      const first = `/${a.source.split("/")[1]}`;
      const shellTaken = shellNow.routes.filter((r) => r === first || r.startsWith(`${first}/`));
      if (shellTaken.length) throw new ZoneError(`zone "${name}": alias ${a.source} is the shell's: ${shellTaken.join(", ")}`);
    }
    /* The router server's dynamic routes come from routes-manifest, read once at startup: the zone brings its own. */
    const dynamicRoutes = info.dynamicRoutes;
    /* Prerendered pages: the zone's routes (not its own /_not-found), and its build's outputs seeded into a writable
       cache of this version, so the zone image is never written and a new version starts from its own build. A
       prerendered payload carries its build's id, and the client router hard-navigates when it differs from the
       page's own: the seeded copies carry the shell's id (payload.cjs rewrites the rows' lengths). */
    const buildId = info.buildId, shellBuildId = shellNow.buildId;
    const SEED_FORMAT = "s4";                           // bumped when what seeding writes changes
    const key = buildKey(identity, buildId);
    const cacheDir = path.join(ctx.cacheDir, name, `${key}--${shellBuildId}--${SEED_FORMAT}`);
    return {
      name, mount, aliases, rules, publicDir, version: identity.version,
      instrumentationFile: info.instrumentation ? path.join(serverDir, "instrumentation.js") : null,
      dist, appPaths, routes, dynamicRoutes, actions: info.actions, prerender: info.prerender, cacheDir,
      seed: { serverDir, buildId, shellBuildId }, buildKey: key,
      timing: { verify: t1 - t0, described: !(identity.install?.format === FORMAT) },
    };
  }

  /* The zone's client code against what a browser may hold (zone-client.cjs, in a worker thread): conflicting module
     ids remapped and their chunks written again, the main chunk, the runtime check. Kept per (zone build, shell
     build, what was installed before), so a reinstall in the same state reads it back. */
  /* Two installs of one build may analyse it at once, and Zones may read or serve the file: never a half-written one. */
  async function writeAtomic(file, text) {
    const temp = `${file}.${process.pid}.${crypto.randomUUID()}.tmp`;
    await fs.promises.writeFile(temp, text);
    await fs.promises.rename(temp, file);
  }

  const ANALYSIS = "m13";                                 // bumped when the client analysis changes (zone-client.cjs FORMAT)
  async function analyseZoneClient(staged) {
    const fingerprint = crypto.createHash("sha1").update(JSON.stringify([ANALYSIS, ctx.clientKnown ? [...ctx.clientKnown].map(([id, h]) => [id, [...h].sort()]).sort() : "shell"])).digest("hex").slice(0, 12);
    const base = path.join(ctx.cacheDir, staged.name, `${staged.buildKey}--${fingerprint}`);
    const resultFile = `${base}-client.json`;
    let result = fs.existsSync(resultFile) ? JSON.parse(fs.readFileSync(resultFile, "utf8")) : null;
    if (!result) {
      result = await runWorker("zone-client.cjs", {
        dist: staged.dist, shellDist: path.join(ctx.shell, ".next"), buildKey: staged.buildKey, outDir: `${base}-chunks`,
        readCache: path.join(ctx.cacheDir, `module-reads-${ANALYSIS}.json`),
        known: ctx.clientKnown ? Object.fromEntries([...ctx.clientKnown].map(([id, h]) => [id, [...h]])) : null,
      });
      /* Most of what the zone has in common with the shell must be under the same ids, or the two were built from
         different project roots (every module named otherwise) and would share nothing. */
      if (result.shared && result.shared.sameCode >= 10 && result.shared.sameId < result.shared.sameCode / 2) {
        throw new ZoneError(`zone "${staged.name}" ${staged.version ?? ""} was built from another project root than the shell: of the ${result.shared.sameCode} client modules it has in common with the shell, ${result.shared.sameId} are under the same ids, so it would load a second copy of each (React's contexts among them). Build the shell and the zone with next-zones build from the same workspace (it pins the root; NEXT_ZONES_ROOT sets it)`);
      }
      if (result.statefulConflicts?.length) {
        const list = result.statefulConflicts.slice(0, 5).map((c) => `module ${c.id} (${c.reason})`).join("; ");
        const message = `zone "${staged.name}": ${result.statefulConflicts.length} client module(s) the shell also has differ in the zone and may hold state, so the zone gets its own copy of each and does not see what the shell set up in it (a context's provider, a client): ${list}. Build the shell and the zone against the same versions of their packages`;
        if (ctx.options.strictModules) throw new ZoneError(message);
        result.warnings = [...(result.warnings ?? []), message];
      }
      if (result.missingUsed.length) {
        throw new ZoneError(`zone "${staged.name}" uses client runtime features the shell's runtime lacks (${result.missingUsed.join(", ")}): import @runsnip/next-zones/client in the shell (render <ZoneUpdates />), which gives its runtime every feature, and rebuild the shell`);
      }
      result.mainChunkFile = null;
      result.mainChunks = [];
      if (result.mainSource) {
        result.mainChunkFile = `${base}-main.js`;
        await fs.promises.mkdir(path.dirname(result.mainChunkFile), { recursive: true });
        await writeAtomic(result.mainChunkFile, result.mainSource);
        result.mainChunks = [`/_next/static/chunks/zone-${staged.name}-${staged.buildKey}-${fingerprint}-main.js`];
      }
      delete result.mainSource;
      await fs.promises.mkdir(path.dirname(resultFile), { recursive: true });
      await writeAtomic(resultFile, JSON.stringify(result));
    }
    if (result.shellModules && !ctx.clientKnown) ctx.clientKnown = new Map(Object.entries(result.shellModules).map(([id, h]) => [id, new Set(h)]));
    Object.assign(staged, {
      mainChunks: result.mainChunks, mainChunkFile: result.mainChunkFile, idMap: result.idMap, chunkDir: `${base}-chunks`,
      chunkUrls: Object.fromEntries(Object.entries(result.chunkMap).map(([from, to]) => [`/_next/${from}`, `/_next/${to}`])),
      zoneModules: result.zoneModules, cacheDir: `${staged.cacheDir}--${fingerprint}`, analysisFiles: [resultFile, `${base}-chunks`, result.mainChunkFile].filter(Boolean),
      warnings: result.warnings ?? [],
    });
    for (const warning of staged.warnings) console.warn(`next-zones: ${warning}`);
  }

  /* The prerendered outputs of the zone's routes, with the shell's build id and the zone's main chunk, written to a
     temporary folder renamed at the end, so a cache is never half seeded. */
  async function seedCache(staged) {
    if (fs.existsSync(staged.cacheDir)) return;
    const { cacheDir, mainChunks, routes, idMap, chunkUrls, seed: { serverDir, buildId, shellBuildId } } = staged;
    await runWorker("zone-seed.cjs", { cacheDir, mainChunks, routes, idMap, chunkUrls, serverDir, buildId, shellBuildId });
  }

  return { stage, analyseZoneClient, seedCache, verifyImage, markVerified };
}

module.exports = { createStaging };
