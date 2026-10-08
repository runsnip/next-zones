/*
 * A zone's page rendered again under one version is never served under another. /blog is prerendered; under v1 it is
 * revalidated and rendered again, which writes a cache entry (from Next 16.3.8 under a "/route-cache/…/$/blog" key).
 * After a swap to v2, then back to v1, the page is each version's own: the entry v1 wrote lives in v1's cache.
 */
const BASE = "http://127.0.0.1:3900";
const install = (v) => fetch(`${BASE}/_next-zones/images/blog/${v}/install`, { method: "POST" }).then((r) => r.json());
/* The page's title, as text (React separates "v" and the version with a comment). */
const title = async () => /id="title">(.*?)<\/h1>/.exec(await (await fetch(`${BASE}/blog`)).text())?.[1].replace(/<!-- -->/g, "");
/* Renders /blog again under the active version: revalidate, then read until the fresh page is served. */
async function rerender() {
  await fetch(`${BASE}/blog/api/revalidate?path=/blog`, { method: "POST" });
  for (let i = 0; i < 5; i++) { await title(); await new Promise((r) => setTimeout(r, 200)); }
}
const wrong = {}, seen = {};
await install(1);
seen.v1 = await title();
await rerender();
seen.v1Again = await title();
await install(2);
seen.v2 = await title();
await rerender();
await install(1);
seen.backToV1 = await title();
if (seen.v1 !== "zone blog v1" || seen.v1Again !== "zone blog v1") wrong.v1 = seen;
if (seen.v2 !== "zone blog v2") wrong.v2 = seen.v2;
if (seen.backToV1 !== "zone blog v1") wrong.backToV1 = seen.backToV1;
console.log(JSON.stringify({ ...seen, wrong }, null, 2));
process.exit(Object.keys(wrong).length ? 1 : 0);
