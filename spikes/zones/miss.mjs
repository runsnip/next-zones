/*
 * Cached misses across installs and swaps: a URL that answered 404 (and was cached as a miss by the router and the
 * page-path cache) answers 200 once a zone serves it, and 404 again once a version without it is installed.
 */
const BASE = "http://127.0.0.1:3900";
const install = (v) => fetch(`${BASE}/_next-zones/images/blog/${v}/install`, { method: "POST" });
const status = async (p) => { const r = await fetch(BASE + p); await r.arrayBuffer(); return r.status; };
/* /blog/new is v2's own page; under v1, /blog/[id] answers it as the item "new". */
const which = async (p) => { const r = await fetch(BASE + p); const t = await r.text(); return r.status !== 200 ? r.status : t.includes("zone blog new in v2") ? "v2 page" : t.includes("zone blog item") ? "item page" : "other"; };
const steps = {};
const read = async (label) => { steps[label] = { "/blog/42": await status("/blog/42"), "/blog/new": await which("/blog/new"), "/post/3": await status("/post/3") }; };
await read("before any install");
await read("again, from the caches");
await install(1); await read("blog v1");
await install(2); await read("blog v2 (adds /blog/new)");
await install(1); await read("rolled back to v1");
const expected = {
  "before any install": { "/blog/42": 404, "/blog/new": 404, "/post/3": 404 },
  "again, from the caches": { "/blog/42": 404, "/blog/new": 404, "/post/3": 404 },
  "blog v1": { "/blog/42": 200, "/blog/new": "item page", "/post/3": 200 },
  "blog v2 (adds /blog/new)": { "/blog/42": 200, "/blog/new": "v2 page", "/post/3": 200 },
  "rolled back to v1": { "/blog/42": 200, "/blog/new": "item page", "/post/3": 200 },
};
const wrong = Object.fromEntries(Object.entries(steps).flatMap(([k, v]) => Object.entries(v).filter(([p, s]) => s !== expected[k][p]).map(([p, s]) => [`${k} ${p}`, s])));
console.log(JSON.stringify({ steps, wrong }, null, 2));
