/*
 * Several installs at once: rounds of concurrent installs (blog v1/v2 and shop, in parallel) while clients keep
 * requesting. After each round Zones must serve exactly the versions installed last, with every zone route and
 * no wrong answer during the rounds.
 */
const BASE = "http://127.0.0.1:3900";
const install = (name, v) => fetch(`${BASE}/_next-zones/images/${name}/${v}/install`, { method: "POST" }).then((r) => r.json());
await install("blog", 1); await install("shop", 1);

let stop = false;
const wrong = {};
const note = (k) => { wrong[k] = (wrong[k] ?? 0) + 1; };
const clients = Array.from({ length: 16 }, async (_, i) => {
  const paths = [["/blog/42", /zone blog item/], ["/shop", /zone shop/], ["/blog/api/x", /"zone":"blog"/], ["/about", /shell about/]];
  let n = i;
  while (!stop) {
    const [p, re] = paths[n++ % paths.length];
    try { const r = await fetch(BASE + p); const t = await r.text(); if (r.status !== 200 || !re.test(t)) note(`${p} ${r.status}`); }
    catch (e) { note(`${p} ${e.message}`); }
  }
});

const rounds = [];
for (let round = 0; round < 20; round++) {
  const blogVersion = round % 2 ? 1 : 2;
  const results = await Promise.all([install("blog", blogVersion), install("shop", 1), install("blog", blogVersion)]);
  const failed = results.filter((r) => !r.name);
  const api = await (await fetch(`${BASE}/blog/api/x`)).json();
  rounds.push({ round, expected: String(blogVersion), served: api.version, failed: failed.length });
}
stop = true;
await Promise.all(clients);
const mismatched = rounds.filter((r) => r.served !== r.expected || r.failed);
console.log(JSON.stringify({ rounds: rounds.length, mismatched, wrong }, null, 2));
