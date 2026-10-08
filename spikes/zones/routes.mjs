/*
 * A zone's route handlers and metadata routes: GET and POST on a dynamic route.ts, the zone's sitemap and its Open
 * Graph image (a generated PNG, linked from the page), and the handler of the version swapped in.
 */
const BASE = "http://127.0.0.1:3900";
const install = (v) => fetch(`${BASE}/_next-zones/images/blog/${v}/install`, { method: "POST" });

await install(1);
const get = await (await fetch(`${BASE}/blog/api/hello`)).json();
const post = await (await fetch(`${BASE}/blog/api/echo`, { method: "POST", headers: { "content-type": "application/json" }, body: '{"a":1}' })).json();
const sitemap = await fetch(`${BASE}/blog/sitemap.xml`);
const sitemapBody = await sitemap.text();
const page = await (await fetch(`${BASE}/blog`)).text();
const og = /property="og:image" content="https?:\/\/[^/]+([^"]+)"/.exec(page)?.[1];
const image = og && await fetch(BASE + og);
const png = image && new Uint8Array(await image.arrayBuffer());
await install(2);
const afterSwap = await (await fetch(`${BASE}/blog/api/hello`)).json();
await install(1);

console.log(JSON.stringify({
  get, post,
  sitemap: { status: sitemap.status, type: sitemap.headers.get("content-type"), urls: (sitemapBody.match(/<loc>/g) ?? []).length },
  ogImage: { linked: og, status: image?.status, type: image?.headers.get("content-type"), png: png ? png[1] === 0x50 && png[2] === 0x4e : false },
  afterSwap,
}, null, 2));
