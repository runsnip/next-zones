/*
 * How long a first install of a zone image (seeding included) holds up requests: a client keeps requesting a shell
 * page back to back; the longest request while the install runs is compared with the longest one without it.
 */
const BASE = "http://127.0.0.1:3900";
const probe = async (ms) => {
  const end = performance.now() + ms; let worst = 0, n = 0;
  while (performance.now() < end) { const s = performance.now(); await (await fetch(`${BASE}/about`)).arrayBuffer(); worst = Math.max(worst, performance.now() - s); n++; }
  return { requests: n, worstMs: +worst.toFixed(1) };
};
await probe(500);                                          // warm-up
const idle = await probe(1000);
const during = [];
for (const v of [1, 2]) {
  const p = probe(400);
  const r = await (await fetch(`${BASE}/_next-zones/images/blog/${v}/install`, { method: "POST" })).json();
  during.push({ version: v, stageMs: +r.t.stage.toFixed(1), probe: await p });
}
console.log(JSON.stringify({ idle, firstInstalls: during }, null, 2));
