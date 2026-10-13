/*
 * A zone's public files over HTTP (zones/send.cjs, zones/assets.cjs): precompressed siblings by Accept-Encoding, a
 * range, and immutable caching for a URL that names the file by its content (the minimum; see docs/assets.md).
 */
import { test, before, after } from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import http from "node:http";
import zlib from "node:zlib";
import { createRequire } from "node:module";

const require = createRequire(import.meta.url);
const { createAssets } = require("../src/zones/assets.cjs");
const { sendAsset, chooseEncoding, contentAddressed } = require("../src/zones/send.cjs");
const { checkZone } = await import("../src/config.mjs");

const BODY = Buffer.from("font bytes ".repeat(400));          // 4400 bytes, compressible
let dir, server, base, zone;

before(async () => {
  dir = fs.mkdtempSync(path.join(os.tmpdir(), "nz-send-"));
  const pub = path.join(dir, "public", "docx", "fonts");
  fs.mkdirSync(pub, { recursive: true });
  fs.writeFileSync(path.join(pub, "a.ttf"), BODY);
  fs.writeFileSync(path.join(pub, "a.ttf.br"), zlib.brotliCompressSync(BODY));
  fs.writeFileSync(path.join(pub, "a.ttf.gz"), zlib.gzipSync(BODY));
  fs.writeFileSync(path.join(pub, "orphan.ttf.br"), zlib.brotliCompressSync(BODY));   // its original is missing
  zone = { name: "docx", mount: "/docx", publicDir: path.join(dir, "public") };
  const ctx = { shell: path.join(dir, "shell"), store: path.join(dir, "store"), zones: new Map(), stopped: new Map(),
    zoneOfRoute: (p) => (p === "/docx" || p.startsWith("/docx/") ? zone : null) };
  const assets = createAssets(ctx);
  server = http.createServer((req, res) => {
    const url = new URL(req.url, "http://x");
    const asset = assets.zoneAsset(url.pathname, url.searchParams);
    if (!asset) { res.writeHead(404, { "x-from": "next" }); return res.end(); }
    return sendAsset(req, res, asset);
  });
  await new Promise((r) => server.listen(0, "127.0.0.1", r));
  base = `http://127.0.0.1:${server.address().port}`;
});
after(() => { server?.close(); fs.rmSync(dir, { recursive: true, force: true }); });

/** A raw request (no automatic decompression), the body as bytes. */
function get(p, headers = {}, method = "GET") {
  return new Promise((resolve, reject) => {
    const req = http.request(`${base}${p}`, { method, headers }, (res) => {
      const chunks = [];
      res.on("data", (c) => chunks.push(c));
      res.on("end", () => resolve({ status: res.statusCode, headers: res.headers, body: Buffer.concat(chunks) }));
    });
    req.on("error", reject);
    req.end();
  });
}

test("Accept-Encoding negotiation", () => {
  const both = ["br", "gzip"];
  assert.equal(chooseEncoding(undefined, both), null);
  assert.equal(chooseEncoding("gzip, deflate, br, zstd", both), "br");
  assert.equal(chooseEncoding("gzip, deflate", both), "gzip");
  assert.equal(chooseEncoding("br;q=0, gzip", both), "gzip");
  assert.equal(chooseEncoding("br", ["gzip"]), null);
});

test("br sibling when accepted, with the original's type, Vary, its own length", async () => {
  const r = await get("/docx/fonts/a.ttf", { "accept-encoding": "gzip, deflate, br" });
  assert.equal(r.status, 200);
  assert.equal(r.headers["content-encoding"], "br");
  assert.equal(r.headers["content-type"], "font/ttf");
  assert.equal(r.headers.vary, "Accept-Encoding");
  assert.equal(Number(r.headers["content-length"]), r.body.length);
  assert.ok(r.body.length < BODY.length);
  assert.deepEqual(zlib.brotliDecompressSync(r.body), BODY);
  assert.equal(r.headers["accept-ranges"], undefined);
});

test("a sibling whose original is missing is never chosen; asked by name it is an ordinary file", async () => {
  const missing = await get("/docx/fonts/orphan.ttf", { "accept-encoding": "br" });
  assert.equal(missing.status, 404);
  assert.equal(missing.headers["x-from"], "next");
  const byName = await get("/docx/fonts/a.ttf.br", { "accept-encoding": "br" });
  assert.equal(byName.headers["content-encoding"], undefined);
  assert.equal(byName.headers["content-type"], "application/octet-stream");
});

test("a range gets the identity bytes, even when br is accepted", async () => {
  const r = await get("/docx/fonts/a.ttf", { "accept-encoding": "br", range: "bytes=10-19" });
  assert.equal(r.status, 206);
  assert.equal(r.headers["content-encoding"], undefined);
  assert.equal(r.headers["content-range"], `bytes 10-19/${BODY.length}`);
  assert.deepEqual(r.body, BODY.subarray(10, 20));
});

test("immutable for a hash-shaped ?h= or ?v=; public, max-age=0 without one", async () => {
  const IMMUTABLE = "public, max-age=31536000, immutable";
  for (const q of ["?h=0123456789abcdef", "?v=3F2A9C01", "?h=Zm9udC1ieXRlcy1hYmNk", "?x=1&h=deadbeefcafe"]) {
    const r = await get(`/docx/fonts/a.ttf${q}`, { "accept-encoding": "br" });
    assert.equal(r.headers["cache-control"], IMMUTABLE, q);
    assert.equal(r.headers["content-encoding"], "br");
  }
  for (const q of ["", "?h=", "?v=1.2.3", "?h=abc", "?x=0123456789abcdef", "?v=not-a-hash"]) {
    const r = await get(`/docx/fonts/a.ttf${q}`);
    assert.equal(r.headers["cache-control"], "public, max-age=0", q);
  }
  /* The zone's own names. */
  zone.hashQuery = ["rev"];
  try {
    assert.equal((await get("/docx/fonts/a.ttf?rev=0123456789abcdef")).headers["cache-control"], IMMUTABLE);
    assert.equal((await get("/docx/fonts/a.ttf?h=0123456789abcdef")).headers["cache-control"], "public, max-age=0");
    zone.hashQuery = [];
    assert.equal((await get("/docx/fonts/a.ttf?h=0123456789abcdef")).headers["cache-control"], "public, max-age=0");
  } finally { delete zone.hashQuery; }
  assert.equal(contentAddressed(new URLSearchParams("h=0123456789abcdef"), undefined), true);
});

test("hashQuery in zoneConfig: a list of names or false, recorded only when declared", () => {
  assert.equal(checkZone({ mount: "/docx" }).hashQuery, undefined);
  assert.deepEqual(checkZone({ mount: "/docx", hashQuery: ["rev", "h"] }).hashQuery, ["rev", "h"]);
  assert.deepEqual(checkZone({ mount: "/docx", hashQuery: false }).hashQuery, []);
  assert.throws(() => checkZone({ mount: "/docx", hashQuery: "h" }), /hashQuery must be/);
  assert.throws(() => checkZone({ mount: "/docx", hashQuery: ["a b"] }), /hashQuery must be/);
});
