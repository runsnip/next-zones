#!/usr/bin/env node
/*
 * Stopping and resuming a zone on a running Zones service (the spike's, with blog in its store):
 * - the switch: the synchronous step a stop or a resume takes (what POST <base>/zones/<zone>/stop|resume reports, in
 *   ms), over --cycles stop/resume pairs, p50 / p99 in µs; and, as the reference measured the same way at the same
 *   time, an install's switch (t.activate), over --swaps installs alternating --version and --other;
 * - its cost on the other requests: sequential GETs of --path (a page of another zone) while nothing is stopped, then
 *   while blog is stopped (every request then asks whether its URL is a stopped zone's), alternating rounds, p50 in ms.
 *
 *   node tools/bench/stop.mjs [--url http://127.0.0.1:3900] [--zone blog] [--version 1] [--other 2] [--path /shop] [--cycles 200]
 *                             [--swaps 40] [--n 2000] [--rounds 2]
 */
const opt = (name, fallback) => { const i = process.argv.indexOf(`--${name}`); return i >= 0 ? process.argv[i + 1] : fallback; };
const url = opt("url", "http://127.0.0.1:3900");
const zone = opt("zone", "blog"), version = opt("version", "1"), other = opt("other", "2"), path = opt("path", "/shop");
const swaps = Number(opt("swaps", "40"));
const cycles = Number(opt("cycles", "200")), n = Number(opt("n", "2000")), rounds = Number(opt("rounds", "2"));

const post = async (p) => { const r = await fetch(url + p, { method: "POST" }); const body = await r.json(); if (!r.ok) throw new Error(`${p}: ${JSON.stringify(body)}`); return body; };
const quantile = (list, q) => { const s = [...list].sort((a, b) => a - b); return s[Math.min(s.length - 1, Math.floor(s.length * q))]; };

await post(`/_next-zones/images/${zone}/${version}/install`);
const before = await (await fetch(`${url}/_next-zones/zones`)).json();

/* The switch, as Zones measures it around the synchronous step. */
const stops = [], resumes = [];
for (let i = 0; i < 20; i++) { await post(`/_next-zones/zones/${zone}/stop`); await post(`/_next-zones/zones/${zone}/resume`); }
for (let i = 0; i < cycles; i++) {
  stops.push((await post(`/_next-zones/zones/${zone}/stop`)).ms * 1000);
  resumes.push((await post(`/_next-zones/zones/${zone}/resume`)).ms * 1000);
}

/* The reference: an install's switch, version and other alternating (the build already loaded, after the first two). */
const installs = [];
for (let i = 0; i < swaps + 2; i++) {
  const r = await post(`/_next-zones/images/${zone}/${i % 2 ? other : version}/install`);
  if (i >= 2) installs.push(r.t.activate * 1000);
}
if (swaps % 2 === 1) await post(`/_next-zones/images/${zone}/${version}/install`);

/* The other requests, with and without a stopped zone. */
async function latency() {
  for (let i = 0; i < 200; i++) await fetch(url + path).then((r) => r.arrayBuffer());
  const t = [];
  for (let i = 0; i < n; i++) { const s = performance.now(); await fetch(url + path).then((r) => r.arrayBuffer()); t.push(performance.now() - s); }
  return +quantile(t, 0.5).toFixed(3);
}
const serving = [], stopped = [];
for (let r = 0; r < rounds; r++) {
  serving.push(await latency());
  await post(`/_next-zones/zones/${zone}/stop`);
  stopped.push(await latency());
  await post(`/_next-zones/zones/${zone}/resume`);
}

const zones = Object.keys(before.zones).filter((name) => before.zones[name].state === "serving").length;
console.log(`Stop and resume — ${zone} ${version}, ${zones} zones serving, ${cycles} stop/resume pairs after 20, Node ${process.version}.\n`);
console.log("| | p50 | p99 |\n|---|---|---|");
console.log(`| stop: the switch | ${quantile(stops, 0.5).toFixed(1)} µs | ${quantile(stops, 0.99).toFixed(1)} µs |`);
console.log(`| resume: the switch | ${quantile(resumes, 0.5).toFixed(1)} µs | ${quantile(resumes, 0.99).toFixed(1)} µs |`);
console.log(`| install (reference, ${swaps} swaps ${version} ↔ ${other}): the switch | ${quantile(installs, 0.5).toFixed(1)} µs | ${quantile(installs, 0.99).toFixed(1)} µs |`);
console.log(`\nGET ${path}, ${n} sequential after 200, p50 in ms, ${rounds} alternating rounds:\n`);
console.log(`| nothing stopped | ${serving.join(", ")} |\n| ${zone} stopped | ${stopped.join(", ")} |`);
