/*
 * D3: the memory of the LRUs Zones keeps (kept-lru.cjs) under traffic. Ten rounds of 1000 requests to distinct URLs
 * that miss (under blog's and shop's mounts, and at the root), each round followed by a swap of blog: every LRU holds
 * no more generations than entries, stays within its bound, and the heap does not grow with the traffic.
 */
const BASE = "http://127.0.0.1:3900";
const post = (p) => fetch(BASE + p, { method: "POST" }).then((r) => r.json());
const debug = (gc) => fetch(`${BASE}/_next-zones/debug${gc ? "?gc=1" : ""}`).then((r) => r.json());
const wrong = {}, heap = [];
await post("/_next-zones/images/blog/1/install");
await post("/_next-zones/images/shop/1/install");
for (let round = 0; round < 10; round++) {
  const urls = Array.from({ length: 1000 }, (_, i) => [`/blog/x/${round}-${i}/deep`, `/shop/none-${round}-${i}`, `/nowhere-${round}-${i}`][i % 3]);
  for (let i = 0; i < urls.length; i += 16) await Promise.all(urls.slice(i, i + 16).map((u) => fetch(BASE + u).then((r) => r.arrayBuffer())));
  await post(`/_next-zones/images/blog/${round % 2 ? 1 : 2}/install`);
  if (round === 1 || round === 9) heap.push((await debug(true)).heapUsedMB);
}
const { lrus } = await debug(false);
for (const [i, l] of lrus.entries()) {
  if (l.born > l.entries) wrong[`lru ${i} remembers more than it holds`] = l;
  if (l.totalSize !== null && l.totalSize > l.maxSize) wrong[`lru ${i} over its bound`] = l;
}
const growth = +(heap[1] - heap[0]).toFixed(1);
if (growth > 15) wrong.heapGrowth = heap;
console.log(JSON.stringify({ lrus: lrus.filter((l) => l.entries), heapMB: heap, growthMB: growth, wrong }, null, 2));
process.exit(Object.keys(wrong).length ? 1 : 0);
