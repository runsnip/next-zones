/*
 * Collecting old versions (D5): after a collect with no rollback window, an old version's disk cache (seeded pages,
 * client analysis) is gone, pinned or not, while the active version's stays; a later rollback to the collected
 * version installs it again and serves it.
 */
import fs from "node:fs";
import path from "node:path";
import { createRequire } from "node:module";

const BASE = "http://127.0.0.1:3900";
const post = async (p) => (await fetch(BASE + p, { method: "POST" })).json();
const served = async () => (await (await fetch(`${BASE}/blog/api/x`)).json()).version;
const { buildKeyOf } = createRequire(import.meta.url)("../../src/zones/describe.cjs");
const cacheOf = (v) => fs.readdirSync(path.join(".zones-cache", "blog")).filter((e) => e.startsWith(`${buildKeyOf(path.join(".zones-store", "blog", v))}--`));

await post("/_next-zones/images/blog/1/install");
const v1 = await served();
await post("/_next-zones/images/blog/2/install");
const v2 = await served();
const before = { v1: cacheOf("1").length, v2: cacheOf("2").length };
const collected = await post("/_next-zones/collect?keep=0");
const after = { v1: cacheOf("1").length, v2: cacheOf("2").length };
const stillV2 = await served();
await post("/_next-zones/images/blog/1/install");
const rolledBack = await served();

const wrong = {};
if (!before.v1 || !before.v2) wrong.before = before;
if (after.v1 !== 0) wrong.v1CacheLeft = after.v1;
if (after.v2 !== before.v2) wrong.v2CacheTouched = after;
if (![...(collected.removed ?? []), ...(collected.pinned ?? [])].includes("blog@1")) wrong.collected = collected;
if (v1 !== "1" || v2 !== "2" || stillV2 !== "2") wrong.served = { v1, v2, stillV2 };
if (rolledBack !== "1") wrong.rolledBack = rolledBack;
console.log(JSON.stringify({ v1, v2, before, after, collected, stillV2, rolledBack, wrong }, null, 2));
