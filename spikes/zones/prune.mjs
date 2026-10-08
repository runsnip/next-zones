/*
 * Pruning on a running Zones (check-all: a store with blog 1, a source with blog 11, 12 and 13, keep 1). Each install
 * pulls its version, then prunes: once 13 is active, only 13 and the one installed before it (12) are left. A version
 * whose loaded code other versions share is held, never removed under them, and goes after a restart. An explicit
 * prune with keep 0 removes the rollback version too; the active one always stays, and serves.
 */
import fs from "node:fs";
import path from "node:path";

const BASE = "http://127.0.0.1:3900/_next-zones";
const store = process.env.NEXT_ZONES_STORE;
const post = async (p) => { const r = await fetch(BASE + p, { method: "POST" }); return { status: r.status, body: await r.json() }; };
const served = async () => (await fetch("http://127.0.0.1:3900/blog/api/x")).status;
const inStore = () => fs.readdirSync(path.join(store, "blog")).filter((n) => !n.startsWith(".")).sort();

const installs = {};
for (const v of ["1", "11", "12", "13"]) installs[v] = (await post(`/images/blog/${v}/install`)).status;
const afterInstalls = inStore();
const state = JSON.parse(fs.readFileSync(path.join(store, "state.json"), "utf8"));
const dry = await post("/prune?keep=0&dry=1");
const afterDry = inStore();
const pruned = await post("/prune?keep=0");
const afterPrune = inStore();
const status = await served();

const wrong = {};
if (Object.values(installs).some((s) => s !== 200)) wrong.installs = installs;
/* 1 and 11 are pruned, or held while other versions share their loaded code (D9). */
const held = (r) => new Set(r?.held ?? []);
if (!afterInstalls.includes("13") || !afterInstalls.includes("12") || afterInstalls.some((v) => !["12", "13", "1", "11"].includes(v))) wrong.afterInstalls = afterInstalls;
if (JSON.stringify(state.history?.blog?.map((h) => h.version)) !== '["1","11","12","13"]' || state.zones?.blog !== "13") wrong.state = state;
/* A dry run says what a prune would do, held versions included. */
if (JSON.stringify(dry.body.removed) !== JSON.stringify(pruned.body.removed) || JSON.stringify(dry.body.held) !== JSON.stringify(pruned.body.held) || JSON.stringify(afterDry) !== JSON.stringify(afterInstalls)) wrong.dry = { dry: dry.body, afterDry };
if (pruned.status !== 200 || afterPrune.includes("12") === !held(pruned.body).has("blog@12")) wrong.pruned = { pruned: pruned.body, afterPrune };
if (!afterPrune.includes("13") || afterPrune.filter((v) => !held(pruned.body).has(`blog@${v}`) && v !== "13").length) wrong.afterPrune = { afterPrune, held: pruned.body.held };
if (status !== 200) wrong.served = status;
console.log(JSON.stringify({ installs, afterInstalls, history: state.history?.blog?.map((h) => h.version), dry: { removed: dry.body.removed, held: dry.body.held }, pruned: { removed: pruned.body.removed, held: pruned.body.held, freedMB: +(pruned.body.freedBytes / 1048576).toFixed(1) }, afterPrune, wrong }, null, 2));
process.exit(Object.keys(wrong).length ? 1 : 0);
