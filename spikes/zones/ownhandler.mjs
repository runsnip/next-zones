/*
 * D6: a shell with its own cacheHandler. A copy of this spike's shell (in .handler) declares one, an in-memory handler
 * that records what it is asked; Zones keeps it for every key but the zones':
 * - the shell's /stamp (its page and its unstable_cache data) is stored by the shell's handler, cached across requests;
 * - blog's /blog/stamp goes to Zones' per-version cache, never to the shell's handler;
 * - revalidateTag("stamp") reaches both: each page renders new data.
 */
import fs from "node:fs";
import path from "node:path";
import { spawn, execFileSync } from "node:child_process";

const dir = path.resolve(".handler");
const PORT = 3909, BASE = `http://127.0.0.1:${PORT}`;
const wrong = {}, seen = {};
fs.rmSync(dir, { recursive: true, force: true });
fs.cpSync("shell", path.join(dir, "shell"), { recursive: true, filter: (src) => !/[\\/](\.next|node_modules|next-env\.d\.ts|tsconfig\.tsbuildinfo)$/.test(src) });
/* The shell's own node_modules, when the workspace did not hoist everything. */
if (fs.existsSync(path.resolve("shell", "node_modules"))) fs.symlinkSync(path.resolve("shell", "node_modules"), path.join(dir, "shell", "node_modules"), "dir");
fs.writeFileSync(path.join(dir, "shell", "package.json"), JSON.stringify({ ...JSON.parse(fs.readFileSync("shell/package.json", "utf8")), name: "handler-shell" }, null, 2));
fs.writeFileSync(path.join(dir, "shell", "cache-handler.cjs"), `/* The shell's own cache: in memory, recording what it is asked (read back at /own-cache). */
const store = new Map();
const log = (globalThis.__ownCache ??= { get: [], set: [], tags: [] });
module.exports = class OwnCache {
  async get(key) { log.get.push(key); return store.get(key) ?? null; }
  async set(key, data) { log.set.push(key); if (data) store.set(key, { value: data, lastModified: Date.now() }); else store.delete(key); }
  async revalidateTag(tags) { log.tags.push(...[].concat(tags)); store.clear(); }
  resetRequestCache() {}
};
`);
fs.writeFileSync(path.join(dir, "shell", "next.config.mjs"), `import { zoneConfig } from "@runsnip/next-zones/config";
export default zoneConfig({ mount: "/", endpoints: { events: true, health: true, admin: true } }, { cacheHandler: new URL("./cache-handler.cjs", import.meta.url).pathname });
`);
fs.mkdirSync(path.join(dir, "shell", "app", "own-cache"), { recursive: true });
fs.writeFileSync(path.join(dir, "shell", "app", "own-cache", "route.ts"), `export const dynamic = "force-dynamic";\nexport function GET() { return Response.json((globalThis as { __ownCache?: unknown }).__ownCache ?? null); }\n`);
execFileSync(process.execPath, [path.resolve("node_modules/next/dist/bin/next"), "build"], { cwd: path.join(dir, "shell"), stdio: "ignore", env: { ...process.env, NEXT_ZONES_BUILD: "zones" } });

const env = { ...process.env, NEXT_ZONES_SHELL: ".handler/shell", NEXT_ZONES_CACHE: ".handler/cache", PORT: String(PORT) };
const zones = spawn(process.execPath, ["zones.cjs"], { env, stdio: ["ignore", "pipe", "pipe"] });
let log = "";
zones.stdout.on("data", (d) => { log += d; });
zones.stderr.on("data", (d) => { log += d; });
try {
  for (let i = 0; i < 120 && !/Zones on/.test(log); i++) await new Promise((r) => setTimeout(r, 250));
  const text = async (p) => (await (await fetch(BASE + p, { signal: AbortSignal.timeout(30_000) })).text());
  const data = async (p) => /id="data">([^<]*)</.exec(await text(p))?.[1];
  const install = await fetch(`${BASE}/_next-zones/images/blog/1/install`, { method: "POST" });
  if (install.status !== 200) wrong.install = await install.text();
  const shell1 = await data("/stamp"), shell2 = await data("/stamp");
  const blog1 = await data("/blog/stamp"), blog2 = await data("/blog/stamp");
  if (!shell1 || shell1 !== shell2) wrong.shellCached = [shell1, shell2];
  if (!blog1 || blog1 !== blog2) wrong.blogCached = [blog1, blog2];
  const own = JSON.parse(await text("/own-cache"));
  seen.ownSet = own?.set;
  /* A key's page path: "/stamp", or from Next 16.3.8 "/route-cache/APP_PAGE/<hash>/$/stamp". */
  const pathOf = (k) => (k.startsWith("/route-cache/") && k.includes("/$/") ? k.slice(k.indexOf("/$/") + 2) : k);
  if (!own?.set?.some((k) => pathOf(k) === "/stamp")) wrong.shellPageNotInOwn = own;
  if ([...(own?.set ?? []), ...(own?.get ?? [])].some((k) => pathOf(k).startsWith("/blog"))) wrong.blogInOwn = own;
  const zoneFiles = fs.readdirSync(path.join(dir, "cache", "blog"), { recursive: true }).filter((f) => /blog[\\/]stamp\.html$/.test(f));
  if (!zoneFiles.length) wrong.blogNotInZoneCache = true;
  /* A tag revalidated: both caches let go of it (stale once, then fresh). */
  await fetch(`${BASE}/api/revalidate?tag=stamp`, { method: "POST" });
  let shell3 = shell1, blog3 = blog1;
  for (let i = 0; i < 10 && (shell3 === shell1 || blog3 === blog1); i++) {
    await new Promise((r) => setTimeout(r, 300));
    shell3 = await data("/stamp"); blog3 = await data("/blog/stamp");
  }
  if (shell3 === shell1) wrong.shellNotRevalidated = shell3;
  if (blog3 === blog1) wrong.blogNotRevalidated = blog3;
  const after = JSON.parse(await text("/own-cache"));
  if (!after?.tags?.includes("stamp")) wrong.tagNotInOwn = after?.tags;
  seen.revalidated = { shell: [shell1, shell3], blog: [blog1, blog3], ownTags: after?.tags };
} catch (error) {
  wrong.error = String(error.stack ?? error);
} finally {
  const exited = new Promise((r) => zones.once("exit", r)); zones.kill(); await exited;
  fs.rmSync(dir, { recursive: true, force: true });
}
if (Object.keys(wrong).length) seen.log = log.slice(-1500);
console.log(JSON.stringify({ ...seen, wrong }, null, 2));
process.exit(Object.keys(wrong).length ? 1 : 0);
