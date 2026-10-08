"use strict";
/*
 * Pulling a zone image into a store: the only way one enters it. The image is fetched from a source (sources.cjs),
 * streamed into a folder of its own beside where it will live, checked, then moved in by one rename. Used by a running
 * Zones (install.cjs: on the server side, or on a ping for a zone that allows live pulls) and by `next-zones pull`.
 *
 * - **Live pulls.** A pull asked for by a ping (`live`) is refused before anything is fetched unless the zone's latest
 *   image in the store declares zoneConfig({ livePull: true }); the pulled image must declare it too. A zone's first
 *   image is pulled on the server side.
 * - **The disk.** A pull leaves `minFree` bytes free on the store's disk (1 GiB by default). Before it starts, the
 *   image's size is estimated from the zone's latest image (zone.json integrity.bytes, else its files); short of room,
 *   `onShort` (a prune) runs, and the pull is refused if it still does not fit. While it runs, the free space is read
 *   every 250 ms, and the pull stops as soon as it falls below `minFree`: a source's sizes are never trusted.
 * - **Checked.** The image must name the zone and version asked for, record its integrity and match it.
 */
const fs = require("node:fs");
const path = require("node:path");
const crypto = require("node:crypto");
const { listImages, folderBytes } = require("./prune.cjs");
const { ZoneError } = require("./context.cjs");

/** A pull or an admission that is refused: the store is unchanged. A ZoneError, so the endpoints answer 409. */
class PullRefused extends ZoneError {}

const mb = (n) => `${(n / 1048576).toFixed(0)} MB`;
const readJson = (file) => { try { return JSON.parse(fs.readFileSync(file, "utf8")); } catch { return null; } };
const latestImage = (store, name) => (listImages(store)[name] ?? []).sort((a, b) => b.addedAt - a.addedAt)[0] ?? null;

/** A new, empty folder for an incoming zone image, next to where it will live (prune.cjs LEFTOVER names it). */
async function incoming(store, name, version) {
  const dir = path.join(store, name, `.${version}.${process.pid}.${crypto.randomUUID()}.incoming`);
  await fs.promises.mkdir(dir, { recursive: true });
  return dir;
}

/**
 * Moves the zone image in `from` into <store>/<name>/<version> once it is checked; resolves its zone.json. `verify(dir)`
 * resolves { digest, files } (a worker in a running Zones). `from` is the caller's to remove.
 */
async function admit({ store, name, version, from, origin, live, verify }) {
  const dist = path.join(store, name, version);
  const identity = readJson(path.join(from, "zone.json"));
  if (!identity) throw new PullRefused(`zone "${name}" ${version} from ${origin}: no zone.json, so not a zone image`);
  if (identity.name !== name || identity.version !== version) throw new PullRefused(`zone "${name}" ${version} from ${origin}: the zone image is ${identity.name} ${identity.version}`);
  if (live && identity.livePull !== true) throw new PullRefused(`zone "${name}" ${version} from ${origin}: the zone does not allow live pulls (zoneConfig({ livePull: true }))`);
  if (!identity.integrity) throw new PullRefused(`zone "${name}" ${version} from ${origin}: the zone image records no integrity (build it with next-zones build)`);
  const found = await verify(from);
  if (found.digest !== identity.integrity.digest) throw new PullRefused(`zone "${name}" ${version} from ${origin}: the zone image differs from the one built (${found.files} files, ${identity.integrity.files} at build time)`);
  if (fs.existsSync(path.join(dist, "zone.json"))) throw new PullRefused(`zone "${name}" ${version} is already in the store: a version is immutable, delete it first`);
  try { await fs.promises.rename(from, dist); }
  catch (error) { if (!fs.existsSync(path.join(dist, "zone.json"))) throw error; }          // another process put it there first
  return identity;
}

/**
 * Pulls <name> <version> into `store` from the first of `sources` that has it; resolves { source, identity }.
 * @param {object} o
 * @param {boolean} [o.live]      asked for by a ping: the zone must allow live pulls
 * @param {number} [o.minFree]    bytes left free on the store's disk (default 1 GiB)
 * @param {() => Promise<void>} [o.onShort]  frees room (a prune) when the estimate does not fit
 * @param {(dir: string) => Promise<{ digest: string, files: number }>} o.verify
 * @param {(dir: string) => Promise<{ bavail: number|bigint, bsize: number|bigint }>} [o.statfs]  for tests
 */
async function pullImage({ store, name, version, sources = [], live = false, minFree = 1024 ** 3, onShort, verify, statfs, interval = 250 }) {
  if (!sources.length) throw new PullRefused(`zone "${name}" ${version} is not in the store, and there are no sources to pull it from`);
  const latest = latestImage(store, name);
  if (live) {
    if (!latest) throw new PullRefused(`zone "${name}" has no image in the store: its first image is pulled on the server (next-zones pull), not on a ping`);
    if (readJson(path.join(latest.dir, "zone.json"))?.livePull !== true) throw new PullRefused(`zone "${name}" does not allow live pulls (zoneConfig({ livePull: true })): nothing was fetched; pull ${version} on the server (next-zones pull)`);
  }
  await fs.promises.mkdir(store, { recursive: true });
  const stat = statfs ?? ((dir) => fs.promises.statfs(dir));
  const free = async () => { const s = await stat(store); return Number(s.bavail) * Number(s.bsize); };
  /* Room for it, before anything is fetched. */
  const recorded = latest ? readJson(path.join(latest.dir, "zone.json"))?.integrity?.bytes : 0;
  const need = Number.isFinite(recorded) ? recorded : latest ? await folderBytes(latest.dir) : 0;
  if ((await free()) - need < minFree) {
    if (onShort) await onShort();
    const now = await free();
    if (now - need < minFree) throw new PullRefused(`zone "${name}" ${version} is not pulled: ${mb(now)} free on the store's disk, about ${mb(need)} needed and ${mb(minFree)} kept free, even after pruning`);
  }
  const into = await incoming(store, name, version);
  const controller = new AbortController();
  let stopped = null;
  const watch = setInterval(async () => {
    const left = await free().catch(() => Infinity);
    if (left < minFree && !stopped) {
      stopped = new PullRefused(`zone "${name}" ${version}: the pull was stopped, the store's disk fell to ${mb(left)} free (${mb(minFree)} kept free)`);
      controller.abort(stopped);
    }
  }, interval);
  watch.unref();
  try {
    for (const source of sources) {
      let found;
      try { found = await source.fetch({ zone: name, version, into, signal: controller.signal }); }
      catch (error) { throw stopped ?? (error instanceof PullRefused ? error : new PullRefused(`zone "${name}" ${version} from ${source.name}: ${error.message}`)); }
      if (stopped) throw stopped;
      if (!found) continue;
      const identity = await admit({ store, name, version, from: into, origin: source.name, live, verify });
      return { source: source.name, identity };
    }
    throw new PullRefused(`zone "${name}" ${version} is not in the store, and no source has it (${sources.map((s) => s.name).join(", ")})`);
  } finally {
    clearInterval(watch);
    await fs.promises.rm(into, { recursive: true, force: true });
  }
}

module.exports = { pullImage, admit, incoming, PullRefused };
