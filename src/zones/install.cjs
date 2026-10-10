"use strict";
/*
 * Installing a zone image: stage it, analyse its main chunk and seed its cache (in parallel with other installs),
 * then, one at a time, register its instrumentation, prepare and switch, and tell open tabs. The store's state.json
 * keeps the active versions across restarts.
 *
 * Stopping a zone takes it out of serving and keeps it installed: the same switch with an empty build in its place
 * (activate.cjs), so its URLs answer 404 (server.cjs) while its build stays loaded; resuming switches that build back
 * in, with no install. A version installed while the zone is stopped replaces the stopped one and stays stopped. The
 * stopped zones are kept in state.json too.
 */
const fs = require("node:fs");
const path = require("node:path");
const { monitorEventLoopDelay } = require("node:perf_hooks");
const { ZoneError } = require("./context.cjs");
const { prune: pruneStore } = require("./prune.cjs");
const { pullImage, admit, incoming: incomingDir } = require("./pull.cjs");
const metrics = require("../metrics.cjs");

const now = () => performance.now();

function createInstaller(ctx, { staging, activation, instrumentation, collector }) {
  /* One switch at a time: a plan is always prepared from the state its switch replaces (activate re-prepares a stale
     plan only once, which a concurrent switch could outrun). */
  let switchQueue = Promise.resolve();
  const blocked = metrics.histogram("nextzones_install_blocked_seconds", { help: "Longest the event loop was held during an install, by zone", buckets: [0.001, 0.005, 0.01, 0.025, 0.05, 0.1, 0.25, 0.5, 1] });
  const pruned = metrics.counter("nextzones_pruned_images_total", { help: "Zone images pruned from the store" });
  const prunedBytes = metrics.counter("nextzones_pruned_bytes_total", { help: "Bytes freed by pruning" });
  function exclusive(task) {
    const run = switchQueue.then(task);
    switchQueue = run.catch(() => {});
    return run;
  }

  /* Open tabs listening for swaps (<base>/events, read by <ZoneUpdates />); told after every switch, a stop and a
     resume included, so a tab's next navigation sees what serves now. */
  function announceSwap(staged, state = "serving") {
    const message = `event: swap\ndata: ${JSON.stringify({ zone: staged.name, version: staged.version, state })}\n\n`;
    for (const res of ctx.listeners) res.write(message);
  }
  const zeroTimings = () => ({ stage: 0, prepare: 0, overlay: 0, reloadMatchers: 0, fsCheck: 0, lru: 0, activate: 0 });

  /** Installs the zone build in `dist`; resolves with the timings, once it serves. Measured (metrics.cjs). */
  function install(name, dist) {
    return metrics.time("nextzones_install_seconds", () => installOnce(name, dist), { zone: name }, { help: "Installs, staging to serving, by zone and outcome" })
      .then((r) => { blocked.observe(r.blockedMs / 1000, { zone: name }); return r; });
  }
  async function installOnce(name, dist) {
    const t = zeroTimings();
    let s0 = now();
    let stopped = false;
    const loop = monitorEventLoopDelay({ resolution: 1 });
    loop.enable();
    const staged = await staging.stage(name, dist);
    /* Reading and checking the build (its integrity checked in a worker, the first time), then the rules. */
    t.verify = staged.timing.verify;
    t.read = now() - s0 - staged.timing.verify;
    await staging.analyseZoneClient(staged);
    await staging.seedCache(staged);
    t.stage = now() - s0;
    await exclusive(async () => {
      s0 = now();
      await instrumentation.registerZoneInstrumentation(staged);
      t.instrumentation = now() - s0;
      /* A stopped zone: the new version takes the stopped one's place, and serves once the zone is resumed. */
      stopped = ctx.stopped.has(name);
      if (stopped) { ctx.stopped.set(name, staged); ctx.stoppedRevision++; }
      else {
        const plan = await activation.prepare(staged);
        t.prepare = now() - s0; s0 = now();
        await activation.activate(staged, t, plan);
        t.activate = now() - s0;
        ctx.zoneSince.set(name, new Date().toISOString());
      }
      collector.record(staged);
      /* What the browser may now hold, for the next install's conflict check. */
      for (const [id, hashes] of Object.entries(staged.zoneModules ?? {})) {
        const held = ctx.clientKnown.get(id) ?? ctx.clientKnown.set(id, new Set()).get(id);
        for (const h of hashes) held.add(h);
      }
      if (!stopped) announceSwap(staged);
    });
    loop.disable();
    /* How long the install kept the event loop from serving requests, at most. */
    return {
      name, version: staged.version, state: stopped ? "stopped" : "serving", routes: staged.routes, ms: +(t.stage + t.activate).toFixed(3),
      blockedMs: +(loop.max / 1e6).toFixed(1), t, ...(staged.warnings?.length ? { warnings: staged.warnings } : {}),
    };
  }

  /** Stops a zone: its URLs answer 404 until it is resumed; it stays installed. Resolves { name, version, state, changed, ms }. */
  async function stop(name, { save = true } = {}) {
    checkZone(name);
    const result = await exclusive(async () => {
      const already = ctx.stopped.get(name);
      if (already) return { name, version: already.version, state: "stopped", changed: false };
      const staged = ctx.zones.get(name);
      if (!staged) throw new ZoneError(`zone "${name}" is not installed`);
      const removal = activation.removal(name);
      const plan = await activation.prepare(removal);
      const t = zeroTimings(), s0 = now();
      await activation.activate(removal, t, plan);
      const ms = now() - s0;
      ctx.stopped.set(name, staged);
      ctx.stoppedRevision++;
      ctx.zoneSince.set(name, new Date().toISOString());
      announceSwap(staged, "stopped");
      return { name, version: staged.version, state: "stopped", changed: true, ms: +ms.toFixed(3) };
    });
    if (result.changed && save) await saveState();
    return result;
  }

  /** Resumes a stopped zone: the build it had serves again, with no install. Resolves { name, version, state, changed, ms }. */
  async function resume(name, { save = true } = {}) {
    checkZone(name);
    const result = await exclusive(async () => {
      const serving = ctx.zones.get(name);
      if (serving) return { name, version: serving.version, state: "serving", changed: false };
      const staged = ctx.stopped.get(name);
      if (!staged) throw new ZoneError(`zone "${name}" is not installed`);
      const plan = await activation.prepare(staged);
      const t = zeroTimings(), s0 = now();
      await activation.activate(staged, t, plan);
      const ms = now() - s0;
      ctx.stopped.delete(name);
      ctx.stoppedRevision++;
      ctx.zoneSince.set(name, new Date().toISOString());
      announceSwap(staged);
      return { name, version: staged.version, state: "serving", changed: true, ms: +ms.toFixed(3) };
    });
    if (result.changed && save) await saveState();
    return result;
  }

  /* ── the store's state: which version of each zone is active ──────────────────────────────────────────────────
   * <store>/state.json, written after every install (to a temporary file, then renamed, one write at a time), and read
   * at boot over the pinned versions (options.pins, e.g. a read-only zones.json shipped with the deploy). Two Zones services on
   * one store never leave it half-written (each write is a rename); the last write wins. Keeping several Zones
   * processes on the same versions is another matter: each installs on its own admin request. */
  const stateFile = path.join(ctx.store, "state.json");
  /* The installed version of each zone, serving or stopped. */
  const installedVersions = () => Object.fromEntries([...ctx.zones.values(), ...ctx.stopped.values()].map((z) => [z.name, z.version]));
  const persist = ctx.options.persist !== false;
  /* The installs of each zone, most recent last ({ version, at }), kept across restarts: prune's rollback window. */
  const HISTORY = 20;
  let installHistory = {};
  try {
    const saved = persist ? JSON.parse(fs.readFileSync(stateFile, "utf8")) : {};
    installHistory = saved.history ?? {};
    /* A state.json from before the history: its active versions are the last installs known. */
    for (const [zone, version] of Object.entries(saved.zones ?? {})) {
      if (!installHistory[zone]?.length) installHistory[zone] = [{ version: String(version), at: saved.updatedAt ?? new Date(0).toISOString() }];
    }
  } catch {}
  function remember(name, version) {
    const list = (installHistory[name] ?? []).filter((h) => h.version !== version);
    list.push({ version, at: new Date().toISOString() });
    installHistory[name] = list.slice(-HISTORY);
  }
  let stateWrites = Promise.resolve();
  function saveState() {
    if (!persist) return stateWrites;
    stateWrites = stateWrites.then(async () => {
      const active = installedVersions();
      const temp = `${stateFile}.${process.pid}.tmp`;
      await fs.promises.mkdir(ctx.store, { recursive: true });
      await fs.promises.writeFile(temp, JSON.stringify({ zones: active, stopped: [...ctx.stopped.keys()], history: installHistory, updatedAt: new Date().toISOString() }, null, 2) + "\n");
      await fs.promises.rename(temp, stateFile);
    }).catch((error) => console.error("next-zones: could not write the store's state", error));
    return stateWrites;
  }

  /* ── pulls ────────────────────────────────────────────────────────────────────────────────────────────────────
   * A zone image enters the store only by a pull: Zones itself fetches it from its sources (options.sources), checks it
   * and moves it into the store in one rename. Nothing is ever uploaded to Zones. A pull is asked for in one of two ways:
   * - by the server side: next-zones pull, createZones().pull()/install(), or a version pinned at boot;
   * - by a ping: an admin request to <base>/images/<zone>/<version>/pull (or /install, of a version the store lacks).
   *   Only for a zone whose images declare zoneConfig({ livePull: true }): read from the zone's latest image in the
   *   store before anything is fetched, then from the pulled image itself. A zone's first image is pulled server side.
   * Two requests for one version pull it once. */
  const pulls = new Map();
  ctx.installing = new Set();                        // "zone@version" being pulled or installed: prune keeps them
  function pull(name, version, { via = "server" } = {}) {
    const key = `${name}@${version}`;
    if (!pulls.has(key)) {
      ctx.installing.add(key);
      pulls.set(key, pullOnce(name, version, via).finally(() => { pulls.delete(key); ctx.installing.delete(key); }));
    }
    return pulls.get(key);
  }
  /** Admits a zone image already fetched into `from` (pull.cjs admit), its integrity checked in a worker. */
  async function admitImage(name, version, from, { origin, live }) {
    const identity = await admit({ store: ctx.store, name, version, from, origin, live, verify: staging.verifyImage });
    staging.markVerified(path.join(ctx.store, name, version), identity.integrity.digest);
    return identity;
  }
  const incoming = (name, version) => incomingDir(ctx.store, name, version);

  function pullOnce(name, version, via) {
    return metrics.time("nextzones_pull_seconds", () => pullImageOnce(name, version, via), { zone: name, via }, { help: "Pulls of a zone image from a source, by zone, what asked and outcome", buckets: [0.1, 0.5, 1, 2.5, 5, 10, 30, 60, 120, 300] });
  }
  async function pullImageOnce(name, version, via) {
    const { source, identity } = await pullImage({
      store: ctx.store, name, version, sources: ctx.options.sources ?? [], live: via === "ping",
      minFree: ctx.options.minFree, statfs: ctx.options.statfs, verify: staging.verifyImage,
      onShort: pruneOptions ? () => prune() : undefined,
    });
    staging.markVerified(path.join(ctx.store, name, version), identity.integrity.digest);
    return source;
  }

  /** Pulls a version into the store without installing it; resolves { pulledFrom } (null when it was there already). */
  async function pullVersion(name, version, { via = "server" } = {}) {
    checkName(name, version);
    if (fs.existsSync(path.join(ctx.store, name, version, "zone.json"))) return { name, version, pulledFrom: null };
    const pulledFrom = await pull(name, version, { via });
    await autoPrune();
    return { name, version, pulledFrom };
  }

  /* ── prune ────────────────────────────────────────────────────────────────────────────────────────────────────
   * prune.cjs, on this Zones: its active versions, pins and installs in progress kept, and a version it loaded
   * unloaded first (collect.cjs); one the module registry still shares is held until a restart (D9). Automatic after
   * every pull and install unless createZones({ prune: false }) or { prune: { auto: false } }. */
  const pruneOptions = ctx.options.prune === false ? null : { keep: 2, auto: true, ...(ctx.options.prune ?? {}) };
  let pruning = Promise.resolve();
  function prune({ keep = pruneOptions?.keep ?? 2, dryRun = false } = {}) {
    const run = pruning.then(() => pruneStore({
      store: ctx.store, cacheDir: ctx.cacheDir, keep, dryRun, pins: ctx.options.pins ?? {}, busy: ctx.installing, history: installHistory,
      active: installedVersions(),
      release: async (key) => (ctx.staged?.has(key) ? (await collector.collect({ only: key })).pinned.length === 0 : true),
      holds: (key) => collector.holds(key),
    }));
    pruning = run.catch(() => {});
    if (!dryRun) run.then((r) => { pruned.inc(r.removed.length); prunedBytes.inc(r.freedBytes ?? 0); }, () => {});
    return run;
  }
  const mb = (n) => `${(n / 1048576).toFixed(0)} MB`;
  async function autoPrune() {
    if (!pruneOptions?.auto) return;
    try {
      const r = await prune();
      if (r.removed.length || r.leftovers) console.log(`next-zones: pruned ${r.removed.join(", ") || "leftovers"} (${mb(r.freedBytes)} freed)`);
    } catch (error) { console.error("next-zones: prune failed", error); }
  }

  function checkZone(name) {
    if (!/^[a-z0-9][a-z0-9-]*$/.test(name ?? "")) throw new ZoneError(`a zone name is required, got ${JSON.stringify(name)}`);
  }
  function checkName(name, version) {
    if (!/^[a-z0-9][a-z0-9-]*$/.test(name ?? "") || !/^[A-Za-z0-9._-]+$/.test(version ?? "")) {
      throw new ZoneError(`a zone name and version are required, got ${JSON.stringify({ name, version })}`);
    }
  }

  /** Installs a version from the store, pulled from the sources first when the store lacks it, and records it as active. */
  async function installVersion(name, version, { save = true, via = "server" } = {}) {
    checkName(name, version);
    const dist = path.join(ctx.store, name, version);
    const key = `${name}@${version}`;
    let pulledFrom = null;
    if (!fs.existsSync(path.join(dist, "zone.json"))) pulledFrom = await pull(name, version, { via });
    ctx.installing.add(key);
    let result;
    try { result = await install(name, dist); } finally { if (!pulls.has(key)) ctx.installing.delete(key); }
    if (pulledFrom) result.pulledFrom = pulledFrom;
    /* A boot reinstalls what was live: not an install of its own, so not in the history. */
    if (save) { remember(name, version); await saveState(); await autoPrune(); }
    return result;
  }

  const bootReport = {};
  /** Installs the pinned versions, overlaid with the store's state. A zone that fails is reported, never fatal. */
  async function restore() {
    const state = persist && fs.existsSync(stateFile) ? JSON.parse(fs.readFileSync(stateFile, "utf8")) : {};
    /* Pins written after the state (a new build, a new deploy) replace it; otherwise a restart keeps what was live. */
    const pinsAt = ctx.options.pinsAt ?? 0;
    const fresh = pinsAt > (Date.parse(state.updatedAt ?? "") || 0);
    const saved = fresh ? {} : state.zones ?? {};
    for (const [name, version] of Object.entries({ ...(ctx.options.pins ?? {}), ...saved })) {
      try {
        await installVersion(name, String(version), { save: false });
        bootReport[name] = { version: String(version), ok: true };
      } catch (error) {
        bootReport[name] = { version: String(version), ok: false, error: error.message };
        console.error(`next-zones: ${name} ${version} was not installed at boot: ${error.message}`);
      }
    }
    /* The zones stopped when the state was written stay stopped (before Zones listens: no request sees them serve). */
    for (const name of fresh ? [] : state.stopped ?? []) {
      if (ctx.zones.has(name)) await stop(name, { save: false });
    }
    /* What a crashed pull left, and what the last run would have pruned. */
    await autoPrune();
  }

  /** Every zone and its state: "serving", "stopped", "failed" (at boot), or "available" (only images in the store). */
  function describe() {
    const zones = {};
    const previousOf = (name, version) => [...(installHistory[name] ?? [])].reverse().find((h) => h.version !== String(version))?.version ?? null;
    const installed = (z, state) => ({
      state, version: String(z.version), mount: z.mount, aliases: (z.aliases ?? []).map((a) => a.source), livePull: z.livePull === true,
      since: ctx.zoneSince.get(z.name) ?? null, previous: previousOf(z.name, z.version),
    });
    for (const z of ctx.zones.values()) zones[z.name] = installed(z, "serving");
    for (const z of ctx.stopped.values()) zones[z.name] = installed(z, "stopped");
    for (const [name, r] of Object.entries(bootReport)) if (!r.ok && !zones[name]) zones[name] = { state: "failed", version: r.version, error: r.error };
    let names = [];
    try { names = fs.readdirSync(ctx.store).filter((n) => /^[a-z0-9][a-z0-9-]*$/.test(n) && !zones[n]); } catch {}
    for (const name of names) {
      let versions = [];
      try { versions = fs.readdirSync(path.join(ctx.store, name)).filter((v) => !v.startsWith(".") && fs.existsSync(path.join(ctx.store, name, v, "zone.json"))); } catch {}
      if (versions.length) zones[name] = { state: "available", versions: versions.sort((a, b) => a.localeCompare(b, undefined, { numeric: true })) };
    }
    return Object.fromEntries(Object.entries(zones).sort(([a], [b]) => a.localeCompare(b)));
  }

  return { install, installVersion, pullVersion, prune, restore, admitImage, incoming, stop, resume, describe, boot: () => ({ ...bootReport }) };
}

module.exports = { createInstaller };
