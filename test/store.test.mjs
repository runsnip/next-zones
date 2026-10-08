/* The store: what prune keeps and removes (prune.cjs), and how a pull enters it (pull.cjs). */
import { test } from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { createRequire } from "node:module";

const require = createRequire(import.meta.url);
const { planPrune, prune, running, claimStore, releaseStore } = require("../src/zones/prune.cjs");
const { pullImage } = require("../src/zones/pull.cjs");
const { digestBuild, buildKeyOf } = require("../src/zones/describe.cjs");

const temp = () => fs.mkdtempSync(path.join(os.tmpdir(), "nz-store-"));
const verify = async (dir) => digestBuild(dir);

/** A zone image in `store` (or a loose folder), added at `at` (its folder's mtime). */
function image(store, zone, version, { at = Date.now(), buildId = `b-${version}`, livePull = false, bytes = 1000 } = {}) {
  const dir = path.join(store, zone, version);
  fs.mkdirSync(path.join(dir, "server"), { recursive: true });
  fs.writeFileSync(path.join(dir, "BUILD_ID"), buildId);
  fs.writeFileSync(path.join(dir, "server", "page.js"), "x".repeat(bytes));
  const integrity = digestBuild(dir);
  fs.writeFileSync(path.join(dir, "zone.json"), JSON.stringify({ name: zone, version, integrity, ...(livePull ? { livePull } : {}) }));
  fs.utimesSync(dir, new Date(at), new Date(at));
  return dir;
}
const state = (store, zones, history) => fs.writeFileSync(path.join(store, "state.json"), JSON.stringify({ zones, history }));
const keptOf = (plan) => Object.fromEntries(plan.keep.map((k) => [`${k.zone}@${k.version}`, k.why]));
const removedOf = (plan) => plan.remove.map((r) => `${r.zone}@${r.version}`).sort();

test("prune keeps the active, the pinned, the rollback window, pulled-not-installed and busy images", () => {
  const store = temp();
  try {
    const t = (s) => Date.parse("2026-10-01T00:00:00Z") + s * 1000;
    for (const v of ["1", "2", "3", "4", "5", "6"]) image(store, "blog", v, { at: t(Number(v)) });
    image(store, "blog", "7", { at: t(100) });                       // pulled after the last install, never installed
    image(store, "blog", "8", { at: t(101) });                       // being installed
    image(store, "shop", "1", { at: t(1) });                          // a zone with no active version
    state(store, { blog: "5" }, { blog: ["1", "2", "3", "4", "6", "5"].map((version, i) => ({ version, at: new Date(t(10 + i)).toISOString() })) });
    const plan = planPrune({ store, pins: { blog: "1" }, keep: 2, busy: new Set(["blog@8"]) });
    assert.deepEqual(keptOf(plan), {
      "blog@5": "active", "blog@1": "pinned", "blog@6": "rollback", "blog@4": "rollback",
      "blog@7": "pulled, not installed yet", "blog@8": "installing", "shop@1": "no active version",
    });
    assert.deepEqual(removedOf(plan), ["blog@2", "blog@3"]);
    assert.deepEqual(removedOf(planPrune({ store, keep: 0 })), ["blog@1", "blog@2", "blog@3", "blog@4", "blog@6"]);
  } finally { fs.rmSync(store, { recursive: true, force: true }); }
});

test("prune removes the images and their caches (by build key, two builds may share a build id); legacy caches by build id unless kept", async () => {
  const store = temp(), cacheDir = temp();
  try {
    const keys = [["1", "same"], ["2", "own"], ["3", "same"]].map(([v, buildId]) => buildKeyOf(image(store, "blog", v, { buildId })));
    state(store, { blog: "3" }, { blog: [{ version: "1", at: "2026-10-01T00:00:00Z" }, { version: "2", at: "2026-10-02T00:00:00Z" }, { version: "3", at: new Date(Date.now() + 60_000).toISOString() }] });
    const caches = [...keys.map((k) => `${k}--shell--s4`), `${keys[1]}--abc-chunks`, "same--shell--1", "own--shell--1"];
    for (const name of caches) fs.mkdirSync(path.join(cacheDir, "blog", name), { recursive: true });
    const dry = await prune({ store, cacheDir, keep: 0, dryRun: true });
    assert.deepEqual(dry.removed.sort(), ["blog@1", "blog@2"]);
    assert.ok(fs.existsSync(path.join(store, "blog", "1")), "a dry run removes nothing");
    const result = await prune({ store, cacheDir, keep: 0 });
    assert.deepEqual(result.removed.sort(), ["blog@1", "blog@2"]);
    assert.ok(result.freedBytes > 2000);
    assert.deepEqual(fs.readdirSync(path.join(store, "blog")), ["3"]);
    assert.deepEqual(fs.readdirSync(path.join(cacheDir, "blog")).sort(), [`${keys[2]}--shell--s4`, "same--shell--1"].sort());
  } finally { for (const d of [store, cacheDir]) fs.rmSync(d, { recursive: true, force: true }); }
});

test("prune leaves an image a running Zones still holds, and removes what a dead process left", async () => {
  const store = temp();
  try {
    image(store, "blog", "1"); image(store, "blog", "2");
    state(store, { blog: "2" }, { blog: [{ version: "1", at: "2026-10-01T00:00:00Z" }, { version: "2", at: new Date(Date.now() + 60_000).toISOString() }] });
    fs.mkdirSync(path.join(store, "blog", ".3.999999.0b1c-aa.incoming"));
    fs.mkdirSync(path.join(store, "blog", `.4.${process.pid}.0b1c-ab.incoming`));
    const result = await prune({ store, keep: 0, release: async () => false });
    assert.deepEqual(result.held, ["blog@1"]);
    assert.equal(result.leftovers, 1);
    assert.deepEqual(fs.readdirSync(path.join(store, "blog")).sort(), [`.4.${process.pid}.0b1c-ab.incoming`, "1", "2"]);
  } finally { fs.rmSync(store, { recursive: true, force: true }); }
});

test("the store's pid file says which Zones runs on it", () => {
  const store = temp();
  try {
    fs.writeFileSync(path.join(store, "zones.pid"), `${process.ppid}\n`);
    assert.equal(running(store), process.ppid);
    fs.writeFileSync(path.join(store, "zones.pid"), "999999\n");
    assert.equal(running(store), null);
    claimStore(store);
    assert.equal(running(store), null, "this process is not another Zones");
    releaseStore(store);
    assert.equal(fs.existsSync(path.join(store, "zones.pid")), false);
  } finally { fs.rmSync(store, { recursive: true, force: true }); }
});

/** A source holding the images of `root`, recording what it was asked for. */
function folderSource(root) {
  const asked = [];
  return {
    asked, name: `folder ${root}`,
    async fetch({ zone, version, into }) {
      asked.push(`${zone}@${version}`);
      const dir = path.join(root, zone, version);
      if (!fs.existsSync(dir)) return false;
      fs.cpSync(dir, into, { recursive: true });
      return true;
    },
  };
}
const roomy = async () => ({ bavail: 1e9, bsize: 4096 });

test("a pull checks the image and moves it into the store; a ping needs a zone that allows live pulls, before any fetch", async () => {
  const store = temp(), remote = temp();
  try {
    image(remote, "blog", "1"); image(remote, "blog", "2", { livePull: true }); image(remote, "shop", "1"); image(remote, "shop", "2");
    const source = folderSource(remote);
    const pull = (name, version, o = {}) => pullImage({ store, name, version, sources: [source], verify, statfs: roomy, ...o });

    await assert.rejects(pull("blog", "1", { live: true }), /first image is pulled on the server/);
    assert.deepEqual(source.asked, [], "nothing fetched");
    assert.equal((await pull("blog", "1")).source, source.name);
    await assert.rejects(pull("blog", "2", { live: true }), /does not allow live pulls.*nothing was fetched/);
    assert.deepEqual(source.asked, ["blog@1"]);
    await pull("blog", "2");
    assert.ok(fs.existsSync(path.join(store, "blog", "2", "zone.json")));

    image(remote, "blog", "3", { livePull: true });
    assert.equal((await pull("blog", "3", { live: true })).identity.version, "3", "the latest image allows live pulls now");

    /* Changed after it was built. */
    fs.appendFileSync(path.join(remote, "shop", "1", "server", "page.js"), "!");
    await assert.rejects(pull("shop", "1"), /differs from the one built/);
    await assert.rejects(pull("shop", "9"), /no source has it/);
    assert.deepEqual(fs.readdirSync(path.join(store, "shop")), [], "refusals leave nothing behind");
  } finally { for (const d of [store, remote]) fs.rmSync(d, { recursive: true, force: true }); }
});

test("a pull that would not leave minFree on the disk prunes first, then is refused before any fetch", async () => {
  const store = temp(), remote = temp();
  try {
    image(store, "blog", "1", { bytes: 4096 }); image(remote, "blog", "2");
    const source = folderSource(remote);
    let pruned = 0;
    const tight = async () => ({ bavail: 10, bsize: 1024 });          // 10 KB free
    await assert.rejects(pullImage({ store, name: "blog", version: "2", sources: [source], verify, statfs: tight, minFree: 8 * 1024, onShort: async () => { pruned++; } }), /not pulled: 0 MB free.*even after pruning/);
    assert.equal(pruned, 1);
    assert.deepEqual(source.asked, []);
    let free = 10;
    await pullImage({ store, name: "blog", version: "2", sources: [source], verify, statfs: async () => ({ bavail: free, bsize: 1024 }), minFree: 8 * 1024, onShort: async () => { free = 1000; } });
    assert.ok(fs.existsSync(path.join(store, "blog", "2", "zone.json")), "pruning made room");
  } finally { for (const d of [store, remote]) fs.rmSync(d, { recursive: true, force: true }); }
});

test("a pull stops when the disk fills while it runs, and leaves nothing behind", async () => {
  const store = temp();
  try {
    let free = 1e6;
    const slow = {
      name: "slow",
      fetch: ({ into, signal }) => new Promise((resolve, reject) => {
        fs.writeFileSync(path.join(into, "part"), "x");
        free = 0;                                                       // the disk fills meanwhile
        signal.addEventListener("abort", () => reject(signal.reason));
      }),
    };
    await assert.rejects(pullImage({ store, name: "blog", version: "1", sources: [slow], verify, statfs: async () => ({ bavail: free, bsize: 1024 }), minFree: 1024, interval: 10 }), /pull was stopped, the store's disk fell/);
    assert.deepEqual(fs.readdirSync(path.join(store, "blog")), []);
  } finally { fs.rmSync(store, { recursive: true, force: true }); }
});

test("an image's version is the zone's package.json version, unless one is given", async () => {
  const { zoneVersion } = await import("../src/build.mjs");
  const dir = temp();
  try {
    assert.throws(() => zoneVersion(dir), /no "version" in its package.json/);
    fs.writeFileSync(path.join(dir, "package.json"), JSON.stringify({ name: "blog", version: "1.4.2" }));
    assert.equal(zoneVersion(dir), "1.4.2");
    assert.equal(zoneVersion(dir, "7"), "7");
  } finally { fs.rmSync(dir, { recursive: true, force: true }); }
});
