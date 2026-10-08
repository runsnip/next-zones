/*
 * D14: memory handed back once old versions are collected (reclaim.cjs). Twelve versions of blog are installed and
 * collected one after another, then Zones is left idle: it runs V8's last-resort collection once, and the heap it
 * keeps (V8's compilation cache of the collected versions' chunks, its grown pages) goes back.
 */
import fs from "node:fs";
import path from "node:path";

const BASE = "http://127.0.0.1:3900", store = ".zones-store/blog", N = 12;
const debug = async () => (await fetch(`${BASE}/_next-zones/debug`)).json();
for (let v = 300; v < 300 + N; v++) {
  const dir = path.join(store, String(v));
  fs.rmSync(dir, { recursive: true, force: true });
  fs.cpSync(path.join(store, "1"), dir, { recursive: true, verbatimSymlinks: true });
  const z = JSON.parse(fs.readFileSync(path.join(dir, "zone.json"), "utf8"));
  fs.writeFileSync(path.join(dir, "zone.json"), JSON.stringify({ ...z, version: String(v) }));
}
const wrong = {};
try {
  for (let v = 300; v < 300 + N; v++) {
    const r = await fetch(`${BASE}/_next-zones/images/blog/${v}/install`, { method: "POST" });
    if (r.status !== 200) wrong[`install ${v}`] = await r.text();
    for (const p of ["/blog/42", "/blog/api/x"]) await (await fetch(BASE + p)).arrayBuffer();
    await fetch(`${BASE}/_next-zones/collect?keep=2`, { method: "POST" });
  }
  const busy = await debug();
  await new Promise((r) => setTimeout(r, 3000));                     // idle: Zones reclaims
  const idle = await debug();
  const served = (await (await fetch(`${BASE}/blog/api/x`)).json()).version;
  if (busy.reclaimed.runs !== 0 && busy.reclaimed.runs === idle.reclaimed.runs) wrong.ranWhileBusy = busy.reclaimed;
  if (idle.reclaimed.runs < 1) wrong.notReclaimed = idle.reclaimed;
  if (!(idle.heapUsedMB < busy.heapUsedMB)) wrong.heap = { busy: busy.heapUsedMB, idle: idle.heapUsedMB };
  if (served !== "1") wrong.served = served;
  console.log(JSON.stringify({ busy: { heapUsedMB: busy.heapUsedMB, rssMB: busy.rssMB }, idle: { heapUsedMB: idle.heapUsedMB, rssMB: idle.rssMB, reclaimed: idle.reclaimed }, wrong }, null, 2));
} finally {
  for (let v = 300; v < 300 + N; v++) fs.rmSync(path.join(store, String(v)), { recursive: true, force: true });
}
process.exit(Object.keys(wrong).length ? 1 : 0);
