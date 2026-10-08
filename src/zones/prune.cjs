"use strict";
/*
 * Pruning the store: removing zone images no longer needed, with their caches. A zone image weighs up to hundreds of
 * MB, and every pull adds one, so a store left alone fills the disk.
 *
 * For each zone with an active version, prune keeps:
 * - the active version;
 * - the version pinned for it (zones.json, createZones({ pins }));
 * - the `keep` versions installed last before the active one (the rollback window), from the install history in
 *   state.json, so it holds across restarts;
 * - images added to the store after the zone's last install (pulled, not installed yet);
 * - images being installed, and, in a running Zones, images whose code the module registry still shares (D9).
 * Every other version of that zone is removed: renamed out of sight first (so nothing ever reads half a folder), then
 * deleted, with its disk caches unless a kept image shares them (the same build id). A zone with no active version is
 * left alone. Folders a crashed pull or prune left behind (`.<version>.<pid>….incoming|removing`) are removed too.
 *
 * planPrune() decides, from what is on disk; prune() acts. Both work on a store with no Zones running (next-zones prune)
 * and inside a running Zones (after each pull and install, and POST <base>/prune), where loaded code is unloaded first.
 */
const fs = require("node:fs");
const path = require("node:path");
const crypto = require("node:crypto");
const { buildKeyOf } = require("./describe.cjs");

const NAME = /^[a-z0-9][a-z0-9-]*$/, VERSION = /^[A-Za-z0-9._-]+$/;
const LEFTOVER = /^\.(.+)\.(\d+)\.[0-9a-f-]+\.(incoming|removing)$/;

/** The store's state.json: { zones: { zone: version }, history: { zone: [{ version, at }] } }, or empty. */
function readState(store) {
  try { return JSON.parse(fs.readFileSync(path.join(store, "state.json"), "utf8")); } catch { return {}; }
}

/** The zone images in a store: zone → [{ version, dir, addedAt, buildId }]. */
function listImages(store) {
  const zones = {};
  if (!fs.existsSync(store)) return zones;
  for (const zone of fs.readdirSync(store).filter((z) => NAME.test(z) && fs.statSync(path.join(store, z)).isDirectory())) {
    const images = [];
    for (const version of fs.readdirSync(path.join(store, zone)).filter((v) => VERSION.test(v) && !v.startsWith("."))) {
      const dir = path.join(store, zone, version);
      if (!fs.existsSync(path.join(dir, "zone.json"))) continue;
      let buildId = null;
      try { buildId = fs.readFileSync(path.join(dir, "BUILD_ID"), "utf8").trim(); } catch {}
      images.push({ version, dir, addedAt: fs.statSync(dir).mtimeMs, buildId });
    }
    if (images.length) zones[zone] = images;
  }
  return zones;
}

/** The bytes a folder holds (files, not following links). */
async function folderBytes(dir) {
  let total = 0;
  const walk = async (d) => {
    for (const e of await fs.promises.readdir(d, { withFileTypes: true }).catch(() => [])) {
      const full = path.join(d, e.name);
      if (e.isDirectory()) await walk(full);
      else if (e.isFile()) total += (await fs.promises.lstat(full).catch(() => ({ size: 0 }))).size;
    }
  };
  await walk(dir);
  return total;
}

/**
 * What prune would keep and remove, from the store alone.
 * @param {object} o
 * @param {string} o.store
 * @param {object} [o.active]   zone → active version (a running Zones' own; else state.json's)
 * @param {object} [o.pins]     zone → pinned version
 * @param {number} [o.keep=2]   installed versions kept before the active one
 * @param {object} [o.history] zone → [{ version, at }], the installs (a running Zones' own; else state.json's)
 * @param {Set<string>} [o.busy] "zone@version" a running Zones must keep (being installed)
 * @returns {{ keep: {zone, version, why}[], remove: {zone, version, dir, buildId}[], leftovers: string[] }}
 */
function planPrune({ store, active, history, pins = {}, keep = 2, busy = new Set() }) {
  const state = readState(store);
  active = active ?? state.zones ?? {};
  history = history ?? state.history ?? {};
  const plan = { keep: [], remove: [], leftovers: [] };
  for (const [zone, images] of Object.entries(listImages(store))) {
    const current = active[zone];
    if (current === undefined) { for (const i of images) plan.keep.push({ zone, version: i.version, why: "no active version" }); continue; }
    const installs = (history[zone] ?? []).filter((h) => h && VERSION.test(String(h.version)));
    const lastInstall = installs.length ? Math.max(...installs.map((h) => Date.parse(h.at) || 0)) : 0;
    const installed = new Set(installs.map((h) => String(h.version)));
    /* Most recent first, the active version aside: the rollback window. */
    const window = [];
    for (const h of [...installs].reverse()) {
      const v = String(h.version);
      if (v !== current && !window.includes(v)) window.push(v);
    }
    const reasons = new Map([[current, "active"]]);
    if (pins[zone] !== undefined && !reasons.has(String(pins[zone]))) reasons.set(String(pins[zone]), "pinned");
    for (const v of window.slice(0, Math.max(0, keep))) if (!reasons.has(v)) reasons.set(v, "rollback");
    for (const i of images) {
      if (!reasons.has(i.version) && busy.has(`${zone}@${i.version}`)) reasons.set(i.version, "installing");
      /* Added after the zone's last install and never installed: pulled for an install still to come. */
      if (!reasons.has(i.version) && !installed.has(i.version) && i.addedAt > lastInstall) reasons.set(i.version, "pulled, not installed yet");
    }
    for (const i of images) {
      if (reasons.has(i.version)) plan.keep.push({ zone, version: i.version, why: reasons.get(i.version) });
      else plan.remove.push({ zone, version: i.version, dir: i.dir, buildId: i.buildId });
    }
  }
  /* Leftovers of a pull or a prune whose process is gone. */
  if (fs.existsSync(store)) {
    for (const zone of fs.readdirSync(store).filter((z) => NAME.test(z))) {
      let entries = [];
      try { entries = fs.readdirSync(path.join(store, zone)); } catch { continue; }
      for (const name of entries) {
        const m = LEFTOVER.exec(name);
        if (m && !alive(Number(m[2]))) plan.leftovers.push(path.join(store, zone, name));
      }
    }
  }
  return plan;
}

function alive(pid) {
  if (pid === process.pid) return true;
  try { process.kill(pid, 0); return true; } catch (error) { return error.code === "EPERM"; }
}

/**
 * Removes what planPrune() says to remove.
 * @param {object} o  planPrune()'s options, and:
 * @param {string} [o.cacheDir]  Zones' cache folder: a removed image's caches (<cacheDir>/<zone>/<build key>--…) go too
 * @param {(key: string) => Promise<boolean>} [o.release]  a running Zones unloads "zone@version" first; false: it is
 *        still held (the module registry shares its modules, D9) and is kept until a restart
 * @param {(key: string) => boolean} [o.holds]  without side effects: whether release() would hold it (a dry run)
 * @param {boolean} [o.dryRun]
 * @returns {Promise<{ removed: string[], held: string[], kept: object[], freedBytes: number, leftovers: number }>}
 */
async function prune(o) {
  const plan = planPrune(o);
  const result = { removed: [], held: [], kept: plan.keep, freedBytes: 0, leftovers: plan.leftovers.length };
  if (o.dryRun) {
    for (const r of plan.remove) {
      const key = `${r.zone}@${r.version}`;
      if (o.holds?.(key)) { result.held.push(key); continue; }
      result.removed.push(key);
      result.freedBytes += await folderBytes(r.dir);
    }
    return result;
  }
  for (const dir of plan.leftovers) {
    result.freedBytes += await folderBytes(dir);
    await fs.promises.rm(dir, { recursive: true, force: true });
  }
  const keptBuildIds = new Map();
  for (const k of plan.keep) {
    try { keptBuildIds.set(`${k.zone}:${fs.readFileSync(path.join(o.store, k.zone, k.version, "BUILD_ID"), "utf8").trim()}`, true); } catch {}
  }
  for (const r of plan.remove) {
    const key = `${r.zone}@${r.version}`;
    if (o.release && !(await o.release(key))) { result.held.push(key); continue; }
    const bytes = await folderBytes(r.dir);
    let ownKey = null;
    try { ownKey = buildKeyOf(r.dir); } catch {}
    const aside = path.join(o.store, r.zone, `.${r.version}.${process.pid}.${crypto.randomUUID()}.removing`);
    try { await fs.promises.rename(r.dir, aside); } catch (error) { if (error.code === "ENOENT") continue; throw error; }
    await fs.promises.rm(aside, { recursive: true, force: true });
    result.freedBytes += bytes;
    result.removed.push(key);
    /* Its caches (named by its build key, describe.cjs; or by its build id, before keys, unless a kept image of the zone
       has the same build id). */
    if (o.cacheDir) {
      const zoneCache = path.join(o.cacheDir, r.zone);
      const legacy = r.buildId && !keptBuildIds.has(`${r.zone}:${r.buildId}`);
      for (const name of await fs.promises.readdir(zoneCache).catch(() => [])) {
        if ((ownKey && name.startsWith(`${ownKey}--`)) || (legacy && name.startsWith(`${r.buildId}--`))) await fs.promises.rm(path.join(zoneCache, name), { recursive: true, force: true });
      }
    }
  }
  return result;
}

/* <store>/zones.pid: the Zones serving from a store, so `next-zones prune` never removes what a running Zones holds. */
const pidFile = (store) => path.join(store, "zones.pid");
function claimStore(store) {
  fs.mkdirSync(store, { recursive: true });
  fs.writeFileSync(pidFile(store), `${process.pid}\n`);
}
function releaseStore(store) {
  try { if (Number(fs.readFileSync(pidFile(store), "utf8")) === process.pid) fs.rmSync(pidFile(store)); } catch {}
}
/** The pid of a Zones running on this store, or null. */
function running(store) {
  try {
    const pid = Number(fs.readFileSync(pidFile(store), "utf8"));
    return pid && pid !== process.pid && alive(pid) ? pid : null;
  } catch { return null; }
}

module.exports = { planPrune, prune, readState, listImages, folderBytes, claimStore, releaseStore, running, LEFTOVER };
