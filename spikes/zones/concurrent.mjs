/*
 * Concurrent renders across zones: dynamic pages of the shell, blog and shop (each SSR-ing client components, so each
 * loads chunks through its own runtime) requested in parallel. Every response must be 200 with its own page's title.
 *
 *   node concurrent.mjs [total=3000] [concurrency=64]
 */
const BASE = "http://127.0.0.1:3900";
const [total = 3000, concurrency = 64] = process.argv.slice(2).map(Number);
await fetch(`${BASE}/_next-zones/images/blog/1/install`, { method: "POST" });
await fetch(`${BASE}/_next-zones/images/shop/1/install`, { method: "POST" });
const targets = [
  ["/about", "shell about"], ["/blog/42", "zone blog item"], ["/shop/live", "zone shop live"], ["/blog/api/x", '"zone":"blog"'],
];
let next = 0, ok = 0;
const wrong = {};
const started = performance.now();
await Promise.all(Array.from({ length: concurrency }, async () => {
  while (next < total) {
    const [path, expect] = targets[next++ % targets.length];
    const res = await fetch(BASE + path);
    const body = await res.text();
    if (res.status === 200 && body.includes(expect)) ok++;
    else { const key = `${path} → ${res.status}`; wrong[key] = (wrong[key] ?? 0) + 1; }
  }
}));
console.log(JSON.stringify({ total, concurrency, ok, wrong, seconds: +((performance.now() - started) / 1000).toFixed(2) }));
