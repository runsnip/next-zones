#!/usr/bin/env node
/*
 * Boot cost and first requests: a fresh Zones on the spike's shell with zones pinned at boot, `warm` set as given; the
 * time from the process's start to listening, then one request per path in sequence, the first each path gets, and a
 * second one (warm, the reference). One Zones per run, on 127.0.0.1.
 *
 *   node tools/bench/warm.mjs [--warm false|true|<json>] [--port 3961] [--pins blog=1,docs=1,shop=1,wide=1,wiki=1]
 *                             [--paths /,/about,/blog,…] [--install blog=2 [--after /blog,/blog/42]]
 *
 * --install then installs a version on it (a live install) and requests --after once each: the switch, how long the
 * install held the event loop, and the first requests to the new version.
 */
import { spawn } from "node:child_process";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";

const opt = (name, fallback) => { const i = process.argv.indexOf(`--${name}`); return i >= 0 ? process.argv[i + 1] : fallback; };
const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..", "..");
const spike = path.join(root, "spikes", "zones");

if (process.argv.includes("--child")) {
  /* The Zones under measurement: performance.now() counts from the process's start. */
  const { createRequire } = await import("node:module");
  const { createZones } = createRequire(import.meta.url)(path.join(root, "src", "zones", "index.cjs"));
  const zones = createZones({
    shell: path.join(spike, "shell"), store: path.join(spike, ".zones-store"), cacheDir: process.env.BENCH_CACHE,
    pins: JSON.parse(process.env.BENCH_PINS), persist: false, prune: false, warm: JSON.parse(process.env.BENCH_WARM),
  });
  await zones.listen(Number(process.env.BENCH_PORT), "127.0.0.1");
  process.send({ listening: performance.now(), warm: zones.warmed?.() ?? null });
} else {
  const port = opt("port", "3961"), warm = opt("warm", "true");
  const pins = Object.fromEntries(opt("pins", "blog=1,docs=1,shop=1,wide=1,wiki=1").split(",").map((p) => p.split("=")));
  const paths = opt("paths", "/,/about,/stamp,/blog,/blog/42,/blog/gallery,/blog/api/x,/shop,/shop/live,/wide,/docs,/docs/ssr,/docs/a,/wiki").split(",");
  const cache = fs.mkdtempSync(path.join(os.tmpdir(), "nz-warm-cache-"));
  const t0 = performance.now();
  const child = spawn(process.execPath, [fileURLToPath(import.meta.url), "--child"], {
    stdio: ["ignore", "ignore", "inherit", "ipc"],
    env: { ...process.env, BENCH_PORT: port, BENCH_PINS: JSON.stringify(pins), BENCH_WARM: JSON.stringify(JSON.parse(warm)), BENCH_CACHE: cache },
  });
  const ready = await new Promise((resolve, reject) => { child.once("message", resolve); child.once("exit", (code) => reject(new Error(`Zones exited ${code}`))); });
  const wall = performance.now() - t0;
  const time = async (p) => { const s = performance.now(); const r = await fetch(`http://127.0.0.1:${port}${p}`); await r.arrayBuffer(); return { status: r.status, ms: +(performance.now() - s).toFixed(1) }; };
  const rows = [];
  for (const p of paths) rows.push({ path: p, first: await time(p) });
  for (const row of rows) row.second = await time(row.path);
  let installed = null;
  const install = opt("install");
  if (install) {
    const [zone, version] = install.split("=");
    const r = await fetch(`http://127.0.0.1:${port}/_next-zones/images/${zone}/${version}/install`, { method: "POST" });
    const body = await r.json();
    if (!r.ok) throw new Error(`install: ${JSON.stringify(body)}`);
    const after = [];
    for (const p of opt("after", `/${zone},/${zone}/42`).split(",")) after.push({ path: p, ...(await time(p)) });
    installed = { zone, version, body, after };
  }
  child.kill("SIGINT");
  await new Promise((resolve) => child.once("exit", resolve));
  fs.rmSync(cache, { recursive: true, force: true });
  const sum = (k) => +rows.reduce((n, r) => n + r[k].ms, 0).toFixed(1);
  console.log(`Boot and first requests — warm ${warm}, zones ${Object.entries(pins).map(([z, v]) => `${z}@${v}`).join(" ")}, Node ${process.version}, ${os.cpus()[0].model}, load ${os.loadavg().map((l) => l.toFixed(1)).join(" ")}. Unit: ms.\n`);
  console.log(`listening at ${ready.listening.toFixed(0)} ms in the process (${wall.toFixed(0)} ms from spawn)${ready.warm ? `; warm-up ${ready.warm.ms} ms: ${ready.warm.modules} modules, ${ready.warm.routes.length} routes` : ""}\n`);
  if (ready.warm?.failed.length) console.log(`not warmed: ${ready.warm.failed.map((f) => `${f.zone ?? "shell"} ${f.page}: ${f.error}`).join("; ")}\n`);
  if (ready.warm?.routes.length) console.log(`rendered: ${ready.warm.routes.map((r) => `${r.path}${r.rsc ? " (rsc)" : ""} ${r.status} ${r.ms} ms${r.error ? ` ${r.error}` : ""}`).join(", ")}\n`);
  console.log("| path | status | first | second |\n|---|---|---|---|");
  for (const r of rows) console.log(`| ${r.path} | ${r.first.status} | ${r.first.ms} | ${r.second.ms} |`);
  console.log(`| all | | ${sum("first")} | ${sum("second")} |`);
  if (installed) {
    const { t, blockedMs } = installed.body;
    console.log(`\ninstall ${installed.zone} ${installed.version}: switch ${(t.activate * 1000).toFixed(1)} µs, warm ${t.warm ?? "-"} ms, stage ${t.stage.toFixed(1)} ms, event loop held at most ${blockedMs} ms`);
    console.log(`first requests after it: ${installed.after.map((a) => `${a.path} ${a.status} ${a.ms} ms`).join(", ")}`);
  }
}
