/*
 * generateStaticParams in a zone: generated params are prerendered (a cache HIT at once), others are rendered on
 * their first request and cached (dynamicParams, the default), and with dynamicParams = false they answer 404.
 * The page generated on demand is written to the zone image's cache, never to the shell's .next.
 */
import fs from "node:fs";

const BASE = "http://127.0.0.1:3900";
await fetch(`${BASE}/_next-zones/images/blog/1/install`, { method: "POST" });
const hit = async (p) => { const r = await fetch(BASE + p); await r.text(); return `${r.status} ${r.headers.get("x-nextjs-cache")}`; };
const result = {
  "/blog/tags/a (generated)": await hit("/blog/tags/a"),
  "/blog/tags/z (first)": await hit("/blog/tags/z"),
  "/blog/tags/z (second)": await hit("/blog/tags/z"),
  "/blog/fixed/one (generated)": await hit("/blog/fixed/one"),
  "/blog/fixed/two (dynamicParams false)": await hit("/blog/fixed/two"),
};
const written = fs.readdirSync(".zones-cache/blog").flatMap((d) => { try { return fs.readdirSync(`.zones-cache/blog/${d}/app/blog/tags`); } catch { return []; } });
result.writtenToZoneCache = written.includes("z.html");
result.shellUntouched = !fs.existsSync("shell/.next/server/app/blog");
console.log(JSON.stringify(result, null, 2));
