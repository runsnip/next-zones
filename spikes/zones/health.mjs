/*
 * /_next-zones/health: 200 once Zones serves, with the active versions for an authorized (here, local) caller.
 */
const BASE = "http://127.0.0.1:3900";
const health = async () => { const r = await fetch(`${BASE}/_next-zones/health`); return { status: r.status, body: await r.json() }; };
const before = await health();
await fetch(`${BASE}/_next-zones/images/blog/2/install`, { method: "POST" });
const after = await health();
const wrong = {};
if (before.status !== 200 || before.body.ok !== true || before.body.degraded !== false) wrong.before = before;
if (after.body.zones?.blog !== "2" || typeof after.body.rssMB !== "number") wrong.after = after;
console.log(JSON.stringify({ before: before.body, after: after.body, wrong }, null, 2));
