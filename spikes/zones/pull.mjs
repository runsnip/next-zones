/*
 * Pulls on a ping (check-all gives this Zones a store with blog 1 and shop 1, and a source folder): the admin endpoint
 * asks Zones to pull blog 2 (a .tgz), which Zones fetches from its source, checks, moves into the store and serves.
 * A version no source has is refused, and so is blog 5, whose files changed after it was built. shop does not allow
 * live pulls: its ping is refused before anything is fetched. None of them touches the store or the active version.
 */
import fs from "node:fs";
import path from "node:path";

const BASE = "http://127.0.0.1:3900/_next-zones";
const store = process.env.NEXT_ZONES_STORE;
const post = async (p) => { const r = await fetch(BASE + p, { method: "POST" }); return { status: r.status, body: await r.json() }; };
const served = async () => (await (await fetch("http://127.0.0.1:3900/blog/api/x")).json()).version;
const incoming = () => fs.readdirSync(path.join(store, "shop")).filter((n) => n.startsWith("."));

const one = await post("/images/blog/1/install");
const pulled = await post("/images/blog/2/pull");
const again = await post("/images/blog/2/pull");
const beforeInstall = await served();
const installed = await post("/images/blog/2/install");
const afterPull = await served();
const missing = await post("/images/blog/9/install");
const changed = await post("/images/blog/5/pull");
const notLive = await post("/images/shop/2/pull");
const leftBehind = incoming();
const afterRefusals = await served();
const storeNow = fs.readdirSync(path.join(store, "blog")).sort();

const wrong = {};
if (one.status !== 200 || one.body.pulledFrom) wrong.fromStore = one;
if (pulled.status !== 200 || !/^directory /.test(pulled.body.pulledFrom ?? "")) wrong.pulled = pulled;
if (again.status !== 200 || again.body.pulledFrom !== null) wrong.again = again;
if (beforeInstall !== "1") wrong.beforeInstall = beforeInstall;
if (installed.status !== 200 || installed.body.pulledFrom || afterPull !== "2") wrong.installed = { installed, afterPull };
if (missing.status !== 409 || !/no source has it/.test(missing.body.refused ?? "")) wrong.missing = missing;
if (changed.status !== 409 || !/differs from the one built/.test(changed.body.refused ?? "")) wrong.changed = changed;
if (notLive.status !== 409 || !/does not allow live pulls.*nothing was fetched/.test(notLive.body.refused ?? "")) wrong.notLive = notLive;
if (leftBehind.length) wrong.leftBehind = leftBehind;
if (afterRefusals !== "2") wrong.afterRefusals = afterRefusals;
if (JSON.stringify(storeNow) !== JSON.stringify(["1", "2"])) wrong.store = storeNow;
console.log(JSON.stringify({ pulledFrom: pulled.body.pulledFrom, afterPull, missing: missing.body.refused, changed: changed.body.refused, notLive: notLive.body.refused, storeNow, wrong }, null, 2));
process.exit(Object.keys(wrong).length ? 1 : 0);
