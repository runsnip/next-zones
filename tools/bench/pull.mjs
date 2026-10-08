#!/usr/bin/env node
/*
 * Memory and time of pulling a large zone image over HTTP: peak RSS and wall time of one pull (fromHttp into an empty
 * folder), each run in a fresh process, for the sources.cjs of this tree and, with --against <git ref>, of that ref.
 *
 *   node tools/bench/pull.mjs [--mb 300] [--runs 3] [--against <git ref>] [--format tgz|zip]
 *
 * The image is synthetic, shaped like a build: --mb of files of 4 KB to 2 MB, 60% random bytes (images, fonts, already
 * compressed) and 40% repetitive JavaScript-like text, packed once with packZoneImage and served by a local HTTP server
 * from its file. Peak RSS is the child's maxRSS (process.resourceUsage), which includes Node's own ~45 MB.
 */
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import http from "node:http";
import crypto from "node:crypto";
import { execFile, execFileSync } from "node:child_process";
import { promisify } from "node:util";
import { fileURLToPath } from "node:url";

const opt = (name, fallback) => { const i = process.argv.indexOf(`--${name}`); return i >= 0 ? process.argv[i + 1] : fallback; };
const sizeMB = Number(opt("mb", "300")), runs = Number(opt("runs", "3")), against = opt("against"), format = opt("format", "tgz");
const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..", "..");
const work = fs.mkdtempSync(path.join(os.tmpdir(), "nz-bench-pull-"));

/* A build-shaped folder of sizeMB. */
const image = path.join(work, "image");
fs.mkdirSync(path.join(image, "server", "chunks"), { recursive: true });
fs.mkdirSync(path.join(image, "static", "media"), { recursive: true });
const text = Buffer.from("export function component(props){return jsx(\"div\",{className:props.className,children:props.children})}\n".repeat(20000));
let left = sizeMB * 1048576, n = 0;
while (left > 0) {
  const size = Math.min(left, 4096 + crypto.randomInt(2 * 1048576));
  const random = n % 5 < 3;
  const data = random ? crypto.randomBytes(size) : Buffer.concat(Array(Math.ceil(size / text.length)).fill(text)).subarray(0, size);
  fs.writeFileSync(path.join(image, random ? "static/media" : "server/chunks", `f${n++}.${random ? "bin" : "js"}`), data);
  left -= size;
}
fs.writeFileSync(path.join(image, "zone.json"), JSON.stringify({ name: "bench", version: "1" }));
const { packZoneImage } = (await import("node:module")).createRequire(import.meta.url)(path.join(root, "src", "sources.cjs"));
const tgz = await packZoneImage(image, path.join(work, `image.${format}`));
const packed = fs.statSync(tgz).size;

const server = http.createServer((req, res) => { res.writeHead(200, { "content-length": packed }); fs.createReadStream(tgz).pipe(res); });
await new Promise((r) => server.listen(0, "127.0.0.1", r));
const url = `http://127.0.0.1:${server.address().port}/{zone}/{version}.tgz`;

/* The sources.cjs under test: this tree's, or a ref's (written beside the tree's, so its relative requires resolve). */
const variants = [["this tree", path.join(root, "src", "sources.cjs")]];
if (against) {
  const file = path.join(root, "src", `.bench-sources-${process.pid}.cjs`);
  fs.writeFileSync(file, execFileSync("git", ["show", `${against}:src/sources.cjs`], { cwd: root }));
  variants.push([against, file]);
}
const child = `
  const { fromHttp } = require(process.argv[1]);
  const into = require("fs").mkdtempSync(process.argv[3]);
  const s = performance.now();
  fromHttp(process.argv[2]).fetch({ zone: "bench", version: "1", into }).then(() => {
    const ms = performance.now() - s;
    require("fs").rmSync(into, { recursive: true, force: true });
    console.log(JSON.stringify({ ms, maxRssMB: process.resourceUsage().maxRSS / 1024 }));
  });`;
const results = [];
try {
  for (const [label, file] of variants) {
    const samples = [];
    for (let i = 0; i < runs; i++) {
      /* Asynchronous: the server answering it runs in this process. */
      const { stdout } = await promisify(execFile)(process.execPath, ["-e", child, file, url, path.join(work, "into-")], { encoding: "utf8", maxBuffer: 1 << 20 });
      samples.push(JSON.parse(stdout));
    }
    const med = (k) => samples.map((s) => s[k]).sort((a, b) => a - b)[Math.floor(samples.length / 2)];
    results.push({ label, maxRssMB: med("maxRssMB"), s: med("ms") / 1000 });
  }
} finally {
  server.close();
  for (const [, file] of variants.slice(1)) fs.rmSync(file, { force: true });
  fs.rmSync(work, { recursive: true, force: true });
}
console.log(`Pull of one zone image over HTTP (fromHttp), Node ${process.version}, ${os.cpus()[0]?.model ?? ""}: ${sizeMB} MB in ${n} files, ${(packed / 1048576).toFixed(0)} MB packed as .${format}; median of ${runs} runs, each in a fresh process.\n`);
console.log("| sources.cjs | peak RSS | time |\n|---|---|---|");
for (const r of results) console.log(`| ${r.label} | ${r.maxRssMB.toFixed(0)} MB | ${r.s.toFixed(1)} s |`);
