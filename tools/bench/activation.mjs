#!/usr/bin/env node
/*
 * Activation benchmark: how long a zone install takes, phase by phase, on a running Zones service. Zones swaps between two
 * builds of one zone <runs> times, at the size of a real app (<pad> extra routes, <dynamic> of them dynamic) with
 * <lru> cached misses refilled before each run, and reports p50 / p95 / max per phase, in µs.
 *
 *   node tools/bench/activation.mjs [--url http://127.0.0.1:3900] [--runs 300] [--pad 212] [--dynamic 75] [--lru 2000]
 *
 * Run it against a freshly started Zones: the padding stays in the process afterwards.
 */
import os from "node:os";
import { createRequire } from "node:module";

const opt = (name, fallback) => { const i = process.argv.indexOf(`--${name}`); return i >= 0 ? process.argv[i + 1] : fallback; };
const url = opt("url", "http://127.0.0.1:3900");
const params = { strategy: "v1", runs: opt("runs", "300"), pad: opt("pad", "212"), dynamic: opt("dynamic", "75"), lru: opt("lru", "2000") };

const response = await fetch(`${url}/_next-zones/bench?${new URLSearchParams(params)}`, { method: "POST" });
if (!response.ok) throw new Error(`Zones answered ${response.status}: ${await response.text()}`);
const result = await response.json();

let nextVersion = "?";
try { nextVersion = createRequire(`${process.cwd()}/package.json`)("next/package.json").version; } catch {}
console.log(`Activation benchmark — ${new Date().toISOString().slice(0, 10)}`);
console.log(`Machine: ${os.cpus()[0]?.model ?? "?"} (${os.cpus().length} cores), ${Math.round(os.totalmem() / 2 ** 30)} GB; Node ${process.version}; Next ${nextVersion}`);
console.log(`Method: ${result.runs} alternating swaps of one zone; ${result.routes} app routes (${params.dynamic} dynamic in the padding); ${result.lruFill} cached misses refilled per run. Unit: ${result.unit}.\n`);
console.log("| phase | p50 | p95 | max |\n|---|---|---|---|");
for (const [phase, s] of Object.entries(result.phases)) console.log(`| ${phase} | ${s.p50} | ${s.p95} | ${s.max} |`);
