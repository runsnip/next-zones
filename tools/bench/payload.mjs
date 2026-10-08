#!/usr/bin/env node
/*
 * The payload rewrite (src/zones/payload.cjs): what seeding a zone's prerendered pages, and both links, spend per file.
 * Against the plain-text rewrite it replaced (one replaceAll over the file, then the client-reference patterns), which
 * only held when the two build ids had the same length.
 *
 *   node tools/bench/payload.mjs [--dir <zone image>/server/app] [--runs 200]
 *
 * Inputs: every .html and .rsc in --dir (a real build's prerendered pages), and two synthetic streams of 1 MB (an HTML
 * page with its flight data in 64 KB chunks, and an RSC payload), each with 2000 client references and the build id
 * every 4 KB. Reported: median and p95 per file, in ms, and MB/s.
 */
import fs from "node:fs";
import path from "node:path";
import { createRequire } from "node:module";

const require = createRequire(import.meta.url);
const { payloadTransform, payloadKind } = require("../../src/zones/payload.cjs");
const opt = (name, fallback) => { const i = process.argv.indexOf(`--${name}`); return i >= 0 ? process.argv[i + 1] : fallback; };
const runs = Number(opt("runs", "200"));
const dir = opt("dir");

const ZONE = "zoneBuildId_21chars_x", SHELL = "shellBuildId_21char_y";
const change = { mainChunks: ["/_next/static/chunks/zone-main.js"], idMap: { 12: 912 }, chunkUrls: { "/_next/static/chunks/a.js": "/_next/static/chunks/a-z1.js" } };

/* The plain-text rewrite it replaced. */
function plainTransform({ buildId, shellBuildId, mainChunks, idMap, chunkUrls }) {
  const raw = mainChunks.map((c) => `"${c}"`).join(","), escaped = mainChunks.map((c) => `\\"${c}\\"`).join(",");
  return (bytes, kind) => {
    let next = bytes.toString("utf8").replaceAll(buildId, shellBuildId);
    if (kind === "plain") return Buffer.from(next);
    next = next.replace(/I\[(\d+),\[\]/g, `I[$1,[${raw}]`).replace(/I\[(\d+),\["/g, `I[$1,[${raw},"`).replace(/I\[(\d+),\[\\"/g, `I[$1,[${escaped},\\"`);
    next = next.replace(/I\[(\d+),/g, (all, id) => (idMap[id] !== undefined ? `I[${idMap[id]},` : all));
    for (const [from, to] of Object.entries(chunkUrls)) next = next.replaceAll(from, to);
    return Buffer.from(next);
  };
}

function synthetic() {
  let flight = "", n = 0;
  while (flight.length < 1 << 20) {
    const text = `${"lorem ipsum ".repeat(300)}${ZONE}`;
    flight += `${(n++).toString(16)}:I[12,["/_next/static/chunks/a.js"],"default"]\n${(n++).toString(16)}:T${Buffer.byteLength(text).toString(16)},${text}${(n++).toString(16)}:["$","p",null,{"b":"${ZONE}"}]\n`;
  }
  const chunks = [];
  for (let i = 0; i < flight.length; i += 65536) chunks.push(flight.slice(i, i + 65536));
  const html = `<!DOCTYPE html><html><body>${chunks.map((c) => `<script>self.__next_f.push(${JSON.stringify([1, c]).replace(/</g, "\\u003c")})</script>`).join("")}</body></html>`;
  return [["synthetic page (1 MB)", Buffer.from(html), "html"], ["synthetic RSC (1 MB)", Buffer.from(flight), "flight"]];
}

const inputs = [];
if (dir) {
  for (const f of fs.readdirSync(dir, { recursive: true })) {
    if (/\.(html|rsc)$/.test(f)) inputs.push([f, fs.readFileSync(path.join(dir, f)), payloadKind(f)]);
  }
}
inputs.push(...synthetic());

const time = (fn) => {
  const ms = [];
  for (let i = 0; i < runs; i++) { const t = performance.now(); fn(); ms.push(performance.now() - t); }
  ms.sort((a, b) => a - b);
  return { p50: ms[Math.floor(runs / 2)], p95: ms[Math.floor(runs * 0.95)] };
};
const rows = [];
const rowAware = payloadTransform({ buildId: ZONE, shellBuildId: SHELL, ...change });
const plain = plainTransform({ buildId: ZONE, shellBuildId: SHELL, ...change });
let total = { bytes: 0, rowAware: 0, plain: 0 };
for (const [name, bytes, kind] of inputs) {
  for (let i = 0; i < 20; i++) { rowAware(bytes, kind); plain(bytes, kind); }   // warm up
  const a = time(() => rowAware(bytes, kind)), b = time(() => plain(bytes, kind));
  rows.push({ file: name, KB: +(bytes.length / 1024).toFixed(1), "row-aware p50 ms": +a.p50.toFixed(3), "p95": +a.p95.toFixed(3), "plain p50 ms": +b.p50.toFixed(3), "plain p95": +b.p95.toFixed(3), "MB/s": +((bytes.length / 1048576) / (a.p50 / 1000)).toFixed(0) });
  if (!name.startsWith("synthetic")) { total.bytes += bytes.length; total.rowAware += a.p50; total.plain += b.p50; }
}
console.table(rows);
if (total.bytes) console.log(`real pages: ${(total.bytes / 1024).toFixed(1)} KB in ${inputs.length - 2} files, ${total.rowAware.toFixed(3)} ms row-aware against ${total.plain.toFixed(3)} ms plain (p50 sums)`);
console.log(`node ${process.version}, ${runs} runs per file, median and p95`);
