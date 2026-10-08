/*
 * Swaps under load: concurrent clients request a zone's dynamic page, its prerendered page and its route handler,
 * and a shell page, while the zone is swapped v1 ⇄ v2 every 150 ms, then rolled back to v1. Reports, per phase
 * (before, during, after), the latency percentiles and every wrong answer: a status other than 200, a page that is
 * not the one asked for, or a version that is neither v1 nor v2.
 *
 *   node swapload.mjs [concurrency=64] [seconds per phase=4]
 */
const BASE = "http://127.0.0.1:3900";
/* 64 clients: a race between two versions' renders shows under pressure (it did at 96, not always at 32). */
const [concurrency = 64, seconds = 4] = process.argv.slice(2).map(Number);
const install = (v) => fetch(`${BASE}/_next-zones/images/blog/${v}/install`, { method: "POST" }).then((r) => r.json());
await install(1);
await fetch(`${BASE}/_next-zones/images/shop/1/install`, { method: "POST" });

const targets = [
  ["/blog/42", /zone blog item (<!-- -->)?42/], ["/blog", /zone blog v(<!-- -->)?[12]</], ["/blog/api/x", /"version":"[12]"/], ["/about", /shell about/],
];
let phase = "before";
const samples = { before: [], during: [], after: [] };
const wrong = { before: {}, during: {}, after: {} };
let stop = false, n = 0;
const clients = Array.from({ length: concurrency }, async () => {
  while (!stop) {
    const [path, expect] = targets[n++ % targets.length];
    const p = phase, s = performance.now();
    try {
      const res = await fetch(BASE + path);
      const body = await res.text();
      samples[p].push(performance.now() - s);
      if (res.status !== 200 || !expect.test(body)) { const k = `${path} ${res.status}`; wrong[p][k] = (wrong[p][k] ?? 0) + 1; }
    } catch (e) { wrong[p][`${path} ${e.code ?? e.message}`] = (wrong[p][`${path} ${e.code ?? e.message}`] ?? 0) + 1; }
  }
});
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
await sleep(seconds * 1000);
phase = "during";
let swaps = 0;
const swapTimes = [];
const end = Date.now() + seconds * 1000;
while (Date.now() < end) { const r = await install(swaps % 2 ? 1 : 2); swapTimes.push(r.t?.activate ?? null); swaps++; await sleep(150); }
const rollback = await install(1);
phase = "after";
await sleep(seconds * 1000);
stop = true;
await Promise.all(clients);

const pct = (a, q) => { const s = [...a].sort((x, y) => x - y); return +s[Math.min(s.length - 1, Math.floor(s.length * q))].toFixed(2); };
const report = Object.fromEntries(Object.entries(samples).map(([k, a]) => [k, { requests: a.length, p50: pct(a, 0.5), p95: pct(a, 0.95), p99: pct(a, 0.99), wrong: wrong[k] }]));
console.log(JSON.stringify({ concurrency, swaps, switchMs: { p50: pct(swapTimes, 0.5), max: Math.max(...swapTimes).toFixed(3) }, rollbackOk: rollback.name === "blog", ...report }, null, 2));
