/* route-order.cjs against Next's own getSortedRoutes (from the spike's install), on generated route sets. */
import { test } from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import { createRequire } from "node:module";

const require = createRequire(import.meta.url);
const { compareRoutes, mergeSorted } = require("../src/zones/route-order.cjs");
const SORTED = new URL("../spikes/zones/node_modules/next/dist/shared/lib/router/utils/sorted-routes.js", import.meta.url);
const skip = fs.existsSync(SORTED) ? false : "needs spikes/zones installed (npm install there): the reference is Next's";
const getSortedRoutes = skip ? null : require(SORTED.pathname).getSortedRoutes;

/* A seeded generator, so a failure can be replayed. */
function rng(seed) { return () => { seed = (seed * 1103515245 + 12345) % 2147483648; return seed / 2147483648; }; }
const STATIC = ["a", "b", "blog", "A", "_x", "(.)photo", "Z", "a-b", "b2", "~", "é"];
function routeSet(random, size) {
  const out = new Set(["/"]);
  while (out.size < size) {
    const depth = 1 + Math.floor(random() * 4), segs = [];
    for (let d = 0; d < depth; d++) {
      const r = random(), last = d === depth - 1;
      /* One slug name per depth: Next refuses two names at one place. Catch-alls only last. */
      segs.push(r < 0.55 ? STATIC[Math.floor(random() * STATIC.length)] : r < 0.8 || !last ? `[p${d}]` : r < 0.9 ? `[...r${d}]` : `[[...o${d}]]`);
    }
    out.add(`/${segs.join("/")}`);
  }
  return [...out];
}

test("the comparator orders routes as getSortedRoutes does", { skip }, () => {
  const random = rng(42);
  let checked = 0;
  for (let n = 0; n < 6000; n++) {
    const routes = routeSet(random, 2 + Math.floor(random() * 40));
    let expected;
    try { expected = getSortedRoutes(routes); } catch { continue; }      // a set Next refuses (both catch-alls at one level…)
    assert.deepEqual([...routes].sort(compareRoutes), expected, JSON.stringify(routes));
    checked++;
  }
  assert.ok(checked > 1500, `only ${checked} sets were valid`);
});

test("merging a zone's sorted routes into the sorted rest gives getSortedRoutes of all", { skip }, () => {
  const random = rng(7);
  let checked = 0;
  for (let n = 0; n < 6000; n++) {
    const routes = routeSet(random, 4 + Math.floor(random() * 60));
    let all;
    try { all = getSortedRoutes(routes); } catch { continue; }
    const added = routes.filter(() => random() < 0.3), base = routes.filter((r) => !added.includes(r));
    assert.deepEqual(mergeSorted(getSortedRoutes(base), getSortedRoutes(added), (r) => r), all);
    checked++;
  }
  assert.ok(checked > 1500, `only ${checked} sets were valid`);
});

test("a few orders, by hand", () => {
  const sorted = ["/", "/a", "/a/b", "/a/[p1]", "/a/[...r1]", "/b", "/[p0]", "/[p0]/x", "/[...r0]"];
  assert.deepEqual([...sorted].reverse().sort(compareRoutes), sorted);
});
