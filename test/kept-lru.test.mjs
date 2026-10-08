/* kept-lru.cjs on Next's own LRUCache (from the spike's install). */
import { test } from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import { createRequire } from "node:module";

const require = createRequire(import.meta.url);
const { keptLRU } = require("../src/zones/kept-lru.cjs");
const LRU = new URL("../spikes/zones/node_modules/next/dist/server/lib/lru-cache.js", import.meta.url);
const skip = fs.existsSync(LRU) ? false : "needs spikes/zones installed (npm install there): the LRU is Next's";
const { LRUCache } = skip ? {} : require(LRU.pathname);

test("a swap makes a zone's cached entries read as absent, and only its own", { skip }, () => {
  const generations = new Map();
  const lru = new (keptLRU(LRUCache, generations))(100);
  lru.set("/blog/1", "a"); lru.set("/shop/1", "b"); lru.set("/blog/page:x", "c");
  generations.set("blog", 1);                                          // blog swapped
  assert.equal(lru.get("/blog/1"), undefined);
  assert.equal(lru.has("/blog/page:x"), false);
  assert.equal(lru.get("/shop/1"), "b");
  lru.set("/blog/1", "new");
  assert.equal(lru.get("/blog/1"), "new");
});

test("the generations it remembers never outgrow the LRU: evictions, removals, refused entries", { skip }, () => {
  const lru = new (keptLRU(LRUCache, new Map()))(10, (value) => value.length);
  const warn = console.warn; console.warn = () => {};
  try {
    for (let i = 0; i < 1000; i++) lru.set(`/blog/${i}`, "x".repeat(1 + (i % 3)));   // evictions
    for (let i = 0; i < 50; i++) lru.set(`/blog/huge${i}`, "x".repeat(11));            // larger than the bound: refused
    for (const [key] of [...lru]) if (Math.random() < 0.5) lru.remove(key);
  } finally { console.warn = warn; }
  assert.equal(lru.born.size, lru.size);
  for (const [key] of lru) assert.ok(lru.born.has(key));
});

test("a cache key's zone segment, in the key formats of Next 16.3.6 and 16.3.8", async () => {
  const { segmentOf, keyPath } = require("../src/zones/kept-lru.cjs");
  assert.equal(segmentOf("/blog/1"), "blog");
  assert.equal(segmentOf("/blog/page:x"), "blog");
  assert.equal(segmentOf("/blog.rsc"), "blog");
  assert.equal(segmentOf("/route-cache/APP_PAGE/0f3a9c/$/blog/stamp"), "blog");
  assert.equal(keyPath("/route-cache/APP_ROUTE/0f3a9c/$/shop/api/x"), "/shop/api/x");
  assert.equal(segmentOf("/route-cache/APP_PAGE/0f3a9c/$/index"), "index");
  assert.equal(segmentOf("e342b73f63beb329cde5eda486f92f6d"), "");
});
