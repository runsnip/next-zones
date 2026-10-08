import { test } from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import zlib from "node:zlib";
import http from "node:http";
import crypto from "node:crypto";
import { PassThrough } from "node:stream";
import { createRequire } from "node:module";

const require = createRequire(import.meta.url);
const { packZoneImage, unpackZoneImage, fromDirectory, fromHttp } = require("../src/sources.cjs");
const { digestBuild } = require("../src/zones/describe.cjs");

const temp = () => fs.mkdtempSync(path.join(os.tmpdir(), "nz-zone-"));

function zoneVersion() {
  const dir = temp();
  fs.writeFileSync(path.join(dir, "zone.json"), JSON.stringify({ name: "blog", version: "1" }));
  fs.mkdirSync(path.join(dir, "server", "chunks"), { recursive: true });
  fs.writeFileSync(path.join(dir, "server", "chunks", "a.js"), "module.exports = 1;\n");
  const long = path.join(dir, "static", "x".repeat(60), "y".repeat(60));
  fs.mkdirSync(long, { recursive: true });
  fs.writeFileSync(path.join(long, "é-long-name.js"), Buffer.from([0, 1, 2, 255]));
  fs.symlinkSync("../../node_modules/pkg", path.join(dir, "server", "link"));
  return dir;
}

test("pack then unpack gives back the same zone image: files, long and non-ASCII paths, links", async () => {
  const dir = zoneVersion(), out = temp(), into = temp();
  try {
    const file = await packZoneImage(dir, path.join(out, "a.tgz"));
    await unpackZoneImage(fs.readFileSync(file), into);
    assert.equal(digestBuild(into).digest, digestBuild(dir).digest);
    assert.equal(fs.readlinkSync(path.join(into, "server", "link")), "../../node_modules/pkg");
    assert.deepEqual(JSON.parse(fs.readFileSync(path.join(into, "zone.json"), "utf8")), { name: "blog", version: "1" });
  } finally { for (const d of [dir, out, into]) fs.rmSync(d, { recursive: true, force: true }); }
});

test("one zone image packs to the same bytes twice", async () => {
  const dir = zoneVersion(), out = temp();
  try {
    const a = fs.readFileSync(await packZoneImage(dir, path.join(out, "a.tgz")));
    const b = fs.readFileSync(await packZoneImage(dir, path.join(out, "b.tgz")));
    assert.ok(zlib.gunzipSync(a).equals(zlib.gunzipSync(b)));
  } finally { for (const d of [dir, out]) fs.rmSync(d, { recursive: true, force: true }); }
});

/* A tar of one entry, written by hand, for the archives a source must never be able to write. */
function tarOf(entries) {
  const blocks = [];
  for (const { name, type = "0", data = Buffer.alloc(0), linkname = "" } of entries) {
    const h = Buffer.alloc(512);
    h.write(name, 0); h.write("0000644\0", 100); h.write(data.length.toString(8).padStart(11, "0") + "\0", 124);
    h.write("        ", 148); h.write(type, 156); h.write(linkname, 157); h.write("ustar\0", 257); h.write("00", 263);
    let sum = 0; for (const b of h) sum += b;
    h.write(sum.toString(8).padStart(6, "0") + "\0 ", 148);
    blocks.push(h, data, Buffer.alloc((512 - (data.length % 512)) % 512));
  }
  blocks.push(Buffer.alloc(1024));
  return zlib.gzipSync(Buffer.concat(blocks));
}

test("an archive that leaves its folder is refused: a ../ path, or a file written through a link", async () => {
  const into = temp();
  try {
    await assert.rejects(unpackZoneImage(tarOf([{ name: "../escape.js", data: Buffer.from("x") }]), into), /leaves its folder/);
    await assert.rejects(unpackZoneImage(tarOf([{ name: "out", type: "2", linkname: os.tmpdir() }, { name: "out/escape.js", data: Buffer.from("x") }]), path.join(into, "b")), /leaves its folder/);
  } finally { fs.rmSync(into, { recursive: true, force: true }); }
});

test("fromDirectory finds a folder or a .tgz, and says when it has neither", async () => {
  const root = temp(), dir = zoneVersion(), into1 = temp(), into2 = temp();
  try {
    fs.mkdirSync(path.join(root, "blog"));
    fs.cpSync(dir, path.join(root, "blog", "1"), { recursive: true, verbatimSymlinks: true });
    await packZoneImage(dir, path.join(root, "blog", "2.tgz"));
    const source = fromDirectory(root);
    assert.equal(await source.fetch({ zone: "blog", version: "1", into: into1 }), true);
    assert.equal(await source.fetch({ zone: "blog", version: "2", into: into2 }), true);
    assert.equal(digestBuild(into2).digest, digestBuild(dir).digest);
    assert.equal(await source.fetch({ zone: "blog", version: "3", into: temp() }), false);
  } finally { for (const d of [root, dir, into1, into2]) fs.rmSync(d, { recursive: true, force: true }); }
});

test("a large file streams across chunk boundaries, and the bytes written are counted", async () => {
  const dir = zoneVersion(), out = temp(), into = temp();
  try {
    /* 5 MB plus an odd tail: entries and padding straddle the gunzip stream's chunks. */
    fs.writeFileSync(path.join(dir, "server", "big.bin"), crypto.randomBytes(5 * 1048576 + 333));
    const file = await packZoneImage(dir, path.join(out, "a.tgz"));
    const written = await unpackZoneImage(fs.createReadStream(file), into);
    assert.equal(digestBuild(into).digest, digestBuild(dir).digest);
    assert.equal(written, digestBuild(dir).bytes + fs.statSync(path.join(dir, "zone.json")).size);
  } finally { for (const d of [dir, out, into]) fs.rmSync(d, { recursive: true, force: true }); }
});

test("a truncated archive, a hard link or a device entry is refused", async () => {
  const into = temp();
  try {
    const whole = zlib.gunzipSync(tarOf([{ name: "a.js", data: Buffer.alloc(4000, 1) }]));
    await assert.rejects(unpackZoneImage(zlib.gzipSync(whole.subarray(0, 2048)), path.join(into, "a")), /ends inside a file/);
    await assert.rejects(unpackZoneImage(tarOf([{ name: "h", type: "1", linkname: "/etc/passwd" }]), path.join(into, "b")), /type a zone image never holds/);
    await assert.rejects(unpackZoneImage(tarOf([{ name: "d", type: "3" }]), path.join(into, "c")), /type a zone image never holds/);
  } finally { fs.rmSync(into, { recursive: true, force: true }); }
});

test("a signal stops an unpack", async () => {
  const into = temp();
  try {
    const controller = new AbortController();
    const slow = new PassThrough();
    const done = unpackZoneImage(slow, into, { signal: controller.signal });
    slow.write(tarOf([{ name: "a.js", data: Buffer.alloc(10, 1) }]).subarray(0, 20));
    controller.abort(new Error("stopped"));
    await assert.rejects(done, /stopped|abort/i);
  } finally { fs.rmSync(into, { recursive: true, force: true }); }
});

test("fromHttp unpacks the response as it arrives, and a 404 is not having it", async () => {
  const dir = zoneVersion(), out = temp(), into = temp();
  const file = await packZoneImage(dir, path.join(out, "a.tgz"));
  const server = http.createServer((req, res) => {
    if (req.url !== "/blog/1.tgz") return res.writeHead(404).end();
    res.writeHead(200, { "content-type": "application/gzip" });
    fs.createReadStream(file).pipe(res);
  });
  await new Promise((r) => server.listen(0, "127.0.0.1", r));
  try {
    const source = fromHttp(`http://127.0.0.1:${server.address().port}/{zone}/{version}.tgz`);
    assert.equal(await source.fetch({ zone: "blog", version: "1", into }), true);
    assert.equal(digestBuild(into).digest, digestBuild(dir).digest);
    assert.equal(await source.fetch({ zone: "blog", version: "2", into: temp() }), false);
  } finally {
    server.close();
    for (const d of [dir, out, into]) fs.rmSync(d, { recursive: true, force: true });
  }
});
