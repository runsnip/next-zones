/*
 * A zone run alone (next build / next start), as it is deployed on its own: it answers its pages, its aliases (which
 * zoneConfig adds to its own rewrites when it is not built for Zones) and its own 404s.
 */
import { createRequire } from "node:module";
import { spawn, execFileSync } from "node:child_process";

const require = createRequire(import.meta.url);
const ALONE = "http://127.0.0.1:3902";
const next = require.resolve("next/dist/bin/next");
const env = { ...process.env };
delete env.NEXT_ZONES_BUILD;
execFileSync(process.execPath, [next, "build"], { cwd: "fixtures/blog", env, stdio: "ignore" });
const server = spawn(process.execPath, [next, "start", "-p", "3902", "-H", "127.0.0.1"], { cwd: "fixtures/blog", env, stdio: "ignore" });
try {
  for (let i = 0; i < 60; i++) { try { await fetch(`${ALONE}/blog`); break; } catch { await new Promise((r) => setTimeout(r, 250)); } }
  const status = async (p) => { const r = await fetch(ALONE + p); return { status: r.status, text: await r.text() }; };
  const page = await status("/blog/42"), alias = await status("/post/42"), missing = await status("/blog/x/y/z");
  const wrong = {};
  if (page.status !== 200) wrong.page = page.status;
  if (alias.status !== 200 || !/zone blog item/.test(alias.text)) wrong.alias = alias.status;
  if (missing.status !== 404) wrong.missing = missing.status;
  console.log(JSON.stringify({ page: page.status, alias: alias.status, missing: missing.status, wrong }, null, 2));
} finally {
  server.kill();
}
