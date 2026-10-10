#!/usr/bin/env node
/*
 * What a stopped zone costs every other request: Zones asks each request's path whether a stopped zone owns it
 * (stoppedLookup, server.cjs), with Next's own path matcher for the zone's aliases. Time per call, in ns, for paths no
 * stopped zone owns, with nothing stopped, then with 1 and 10 stopped zones of 3 aliases each. Node's own timer around
 * batches of 100 000 calls, median of 15 batches.
 *
 *   node tools/bench/stopped-lookup.mjs
 */
import { createRequire } from "node:module";

const require = createRequire(import.meta.url);
const { stoppedLookup } = require("../../src/zones/server.cjs");
const { getPathMatch } = require(new URL("../../spikes/zones/node_modules/next/dist/shared/lib/router/utils/path-match.js", import.meta.url).pathname);
const paths = ["/", "/shop/cart", "/shop/items/42", "/_next/static/chunks/main.js", "/about", "/docs/a/b"];

function measure(stoppedCount) {
  const stopped = new Map();
  for (let i = 0; i < stoppedCount; i++) stopped.set(`z${i}`, { name: `z${i}`, mount: `/z${i}`, buildId: `id${i}`, aliases: [{ source: `/p${i}/:id` }, { source: `/q${i}/:a/:b` }, { source: `/r${i}/:path*` }] });
  const of = stoppedLookup(stopped, getPathMatch);
  for (let i = 0; i < 200_000; i++) of(paths[i % paths.length]);
  const batches = [];
  for (let b = 0; b < 15; b++) {
    const s = process.hrtime.bigint();
    for (let i = 0; i < 100_000; i++) of(paths[i % paths.length]);
    batches.push(Number(process.hrtime.bigint() - s) / 100_000);
  }
  return batches.sort((a, b) => a - b)[7].toFixed(1);
}
console.log(`The stopped-zone lookup per request, Node ${process.version}: median of 15 batches of 100 000 calls, ns per call.\n`);
console.log("| stopped zones | ns per request |\n|---|---|");
for (const n of [0, 1, 10]) console.log(`| ${n} | ${measure(n)} |`);
