/*
 * Revalidation across zones: the shell's /stamp and the blog zone's /blog/stamp both cache data tagged "stamp".
 * revalidateTag from the zone must refresh the shell's page and its own; revalidateTag from the shell must refresh
 * the zone's; revalidatePath from the zone on a shell path refreshes that page. With the "max" profile a revalidated
 * page is served stale once while it regenerates, so each page is read until its data changes.
 */
const BASE = "http://127.0.0.1:3900";
const post = (p) => fetch(BASE + p, { method: "POST" }).then((r) => r.json());
const data = async (p) => /id="data">([^<]+)</.exec(await (await fetch(BASE + p)).text())?.[1];
const settle = async (p, before) => {
  for (let i = 0; i < 20; i++) { const now = await data(p); if (now !== before) return { changed: true, reads: i + 1 }; await new Promise((r) => setTimeout(r, 100)); }
  return { changed: false };
};
await post("/_next-zones/images/blog/1/install");
const pages = ["/stamp", "/blog/stamp"];
const snapshot = async () => Object.fromEntries(await Promise.all(pages.map(async (p) => [p, await data(p)])));
const stable = await snapshot(); await new Promise((r) => setTimeout(r, 200));
const cachedStays = JSON.stringify(stable) === JSON.stringify(await snapshot());

const results = {};
for (const [label, call] of [["tag from the zone", "/blog/api/revalidate?tag=stamp"], ["tag from the shell", "/api/revalidate?tag=stamp"]]) {
  const before = await snapshot();
  await post(call);
  results[label] = Object.fromEntries(await Promise.all(pages.map(async (p) => [p, await settle(p, before[p])])));
}
const before = await data("/stamp");
await post("/blog/api/revalidate?path=/stamp");
results["path /stamp from the zone"] = { "/stamp": await settle("/stamp", before) };
console.log(JSON.stringify({ cachedStays, ...results }, null, 2));
