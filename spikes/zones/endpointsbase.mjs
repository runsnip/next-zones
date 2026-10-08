/*
 * Another base path (NEXT_ZONES_ENDPOINTS=/_ops over the shell's declaration): Zones' URLs move there, and the default
 * base is the shell's Next again.
 */
const at = async (method, p) => { const r = await fetch(`http://127.0.0.1:3900${p}`, { method }); return r.status; };
const results = {
  health: await at("GET", "/_ops/health"),
  install: await at("POST", "/_ops/images/blog/1/install"),
  defaultBase: await at("GET", "/_next-zones/health"),
};
const served = (await (await fetch("http://127.0.0.1:3900/blog/api/x")).json()).version;
const wrong = {};
if (results.health !== 200 || results.install !== 200 || served !== "1") wrong.moved = { ...results, served };
if (results.defaultBase !== 404) wrong.defaultBase = results.defaultBase;
console.log(JSON.stringify({ results, served, wrong }, null, 2));
