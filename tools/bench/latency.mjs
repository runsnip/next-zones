#!/usr/bin/env node
/*
 * Request latency through a running Zones service: sequential requests per path after a warm-up, p50 / p95 / p99 in ms.
 * Run it twice with a Zones service setting changed (for example NEXT_ZONES_REGISTRY=off) to compare.
 *
 *   node tools/bench/latency.mjs [--url http://127.0.0.1:3900] [--paths /,/blog/42] [--n 2000] [--warmup 200]
 */
const opt = (name, fallback) => { const i = process.argv.indexOf(`--${name}`); return i >= 0 ? process.argv[i + 1] : fallback; };
const url = opt("url", "http://127.0.0.1:3900");
const paths = opt("paths", "/").split(",");
const n = Number(opt("n", "2000"));
const warmup = Number(opt("warmup", "200"));

const out = {};
for (const p of paths) {
  for (let i = 0; i < warmup; i++) await fetch(url + p).then((r) => r.arrayBuffer());
  const t = [];
  for (let i = 0; i < n; i++) {
    const s = performance.now();
    await fetch(url + p).then((r) => r.arrayBuffer());
    t.push(performance.now() - s);
  }
  t.sort((a, b) => a - b);
  const at = (q) => +t[Math.min(t.length - 1, Math.floor(t.length * q))].toFixed(3);
  out[p] = { p50: at(0.5), p95: at(0.95), p99: at(0.99) };
}
console.log(`Latency — ${n} sequential requests per path after ${warmup} warm-up, Node ${process.version}. Unit: ms.\n`);
console.log("| path | p50 | p95 | p99 |\n|---|---|---|---|");
for (const [p, s] of Object.entries(out)) console.log(`| ${p} | ${s.p50} | ${s.p95} | ${s.p99} |`);
