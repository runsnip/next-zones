/* Zone images as .zip (zip.cjs) and over a shared link (fromHttp: stalls, dropped connections, Range; fromConnector). */
import { test } from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import http from "node:http";
import crypto from "node:crypto";
import { execFileSync } from "node:child_process";
import { Readable } from "node:stream";
import { createRequire } from "node:module";

const require = createRequire(import.meta.url);
const { packZoneImage, unpackZoneImage, fromHttp, fromConnector } = require("../src/sources.cjs");
const { digestBuild } = require("../src/zones/describe.cjs");
const temp = () => fs.mkdtempSync(path.join(os.tmpdir(), "nz-transfer-"));

function zoneImage() {
  const dir = temp();
  fs.writeFileSync(path.join(dir, "zone.json"), JSON.stringify({ name: "blog", version: "1" }));
  fs.mkdirSync(path.join(dir, "server", "chunks"), { recursive: true });
  fs.writeFileSync(path.join(dir, "server", "chunks", "a.js"), "module.exports = 1;\n");
  fs.writeFileSync(path.join(dir, "server", "big.bin"), crypto.randomBytes(3 * 1048576 + 77));
  fs.writeFileSync(path.join(dir, "server", "é-name.js"), "x");
  fs.symlinkSync("../server/chunks/a.js", path.join(dir, "server", "link"));
  return dir;
}

test("a .zip packs and unpacks to the same image: files, non-ASCII names, links", async () => {
  const dir = zoneImage(), out = temp(), into = path.join(temp(), "x");
  try {
    const file = await packZoneImage(dir, path.join(out, "a.zip"));
    assert.equal(fs.readFileSync(file).readUInt32LE(0), 0x04034b50);
    await unpackZoneImage(fs.createReadStream(file), into);
    assert.equal(digestBuild(into).digest, digestBuild(dir).digest);
    assert.equal(fs.readlinkSync(path.join(into, "server", "link")), "../server/chunks/a.js");
    assert.equal(fs.existsSync(`${into}.zip`), false, "the spooled archive is removed");
  } finally { for (const d of [dir, out, path.dirname(into)]) fs.rmSync(d, { recursive: true, force: true }); }
});

test("a repository's archive of a tag (git archive, one top-level folder) unpacks as the image", async (t) => {
  try { execFileSync("git", ["--version"], { stdio: "ignore" }); } catch { return t.skip("git is not installed"); }
  const dir = zoneImage(), out = temp(), into = path.join(temp(), "x");
  const expected = digestBuild(dir).digest;                            // before git adds its own folder
  try {
    const git = (...args) => execFileSync("git", ["-C", dir, ...args], { stdio: "ignore" });
    git("init", "-q"); git("add", "-A"); git("-c", "user.email=t@t", "-c", "user.name=t", "commit", "-qm", "image"); git("tag", "v1");
    execFileSync("git", ["-C", dir, "archive", "--format=zip", "--prefix=blog-v1/", "-o", path.join(out, "repo.zip"), "v1"]);
    await unpackZoneImage(path.join(out, "repo.zip"), into);
    assert.ok(fs.existsSync(path.join(into, "zone.json")), "unwrapped from blog-v1/");
    assert.equal(digestBuild(into).digest, expected);
  } finally { for (const d of [dir, out, path.dirname(into)]) fs.rmSync(d, { recursive: true, force: true }); }
});

test("a .zip entry that leaves its folder is refused", async () => {
  const dir = temp(), out = temp(), into = path.join(temp(), "x");
  try {
    fs.writeFileSync(path.join(dir, "zone.json"), "{}");
    fs.writeFileSync(path.join(dir, "aaaaaaaa"), "x");
    const file = await packZoneImage(dir, path.join(out, "a.zip"));
    const bytes = fs.readFileSync(file);
    fs.writeFileSync(file, Buffer.from(bytes.toString("latin1").replaceAll("aaaaaaaa", "../xxxxx"), "latin1"));
    await assert.rejects(unpackZoneImage(file, into), /leaves its folder/);
  } finally { for (const d of [dir, out, path.dirname(into)]) fs.rmSync(d, { recursive: true, force: true }); }
});

/** The bytes of `file` as a stream of `size`-byte pieces, so every boundary falls somewhere new. */
const pieces = (file, size) => Readable.from((function* () { const b = fs.readFileSync(file); for (let i = 0; i < b.length; i += size) yield b.subarray(i, i + size); })());

test("a .zip arriving in small pieces unpacks as it arrives, nothing spooled beside the folder", async () => {
  const dir = zoneImage(), small = temp(), out = temp(), parent = temp();
  try {
    /* Pieces of 7 bytes on a small image (every boundary: headers, deflate streams, data descriptors), larger on the big one. */
    fs.writeFileSync(path.join(small, "zone.json"), "{}");
    fs.mkdirSync(path.join(small, "server"));
    fs.writeFileSync(path.join(small, "server", "a.js"), "module.exports = 1;\n".repeat(400));
    fs.writeFileSync(path.join(small, "server", "b.bin"), crypto.randomBytes(3000));
    fs.symlinkSync("a.js", path.join(small, "server", "link"));
    const smallFile = await packZoneImage(small, path.join(out, "small.zip")), file = await packZoneImage(dir, path.join(out, "a.zip"));
    for (const [from, image, size] of [[smallFile, small, 7], [file, dir, 4096], [file, dir, 1 << 20]]) {
      const into = path.join(parent, `x${size}`);
      await unpackZoneImage(pieces(from, size), into);
      assert.equal(digestBuild(into).digest, digestBuild(image).digest, `pieces of ${size}`);
      assert.ok(fs.lstatSync(path.join(into, "server", "link")).isSymbolicLink());
    }
    assert.deepEqual(fs.readdirSync(parent).filter((f) => f.endsWith(".zip")), []);
  } finally { for (const d of [dir, small, out, parent]) fs.rmSync(d, { recursive: true, force: true }); }
});

test("a .zip whose central directory disagrees with its entries, or that is cut short, is refused", async () => {
  const dir = temp(), out = temp(), parent = temp();
  try {
    fs.writeFileSync(path.join(dir, "zone.json"), "{}");
    fs.writeFileSync(path.join(dir, "a.js"), "x".repeat(5000));
    const file = await packZoneImage(dir, path.join(out, "a.zip"));
    const bytes = fs.readFileSync(file);
    /* The central directory's CRC-32 of the first entry (at offset 16 of its record) changed. */
    const cd = bytes.lastIndexOf(Buffer.from([0x50, 0x4b, 0x01, 0x02]), bytes.length - 1);
    const first = bytes.indexOf(Buffer.from([0x50, 0x4b, 0x01, 0x02]));
    const bad = Buffer.from(bytes); bad[first + 16] ^= 0xff;
    await assert.rejects(unpackZoneImage(bad, path.join(parent, "a")), /central directory disagrees/);
    assert.ok(cd > 0);
    await assert.rejects(unpackZoneImage(bytes.subarray(0, Math.floor(bytes.length / 2)), path.join(parent, "b")), /corrupt/);
  } finally { for (const d of [dir, out, parent]) fs.rmSync(d, { recursive: true, force: true }); }
});

/** A server for one archive: `misbehave(req, res, body)` may drop or stall a response; Range and ETag as asked. */
async function serve(file, { ranges = true, misbehave } = {}) {
  const body = fs.readFileSync(file), seen = [];
  const server = http.createServer((req, res) => {
    seen.push({ range: req.headers.range ?? null, ifRange: req.headers["if-range"] ?? null, auth: req.headers.authorization ?? null });
    let start = 0;
    const m = ranges && /^bytes=(\d+)-$/.exec(req.headers.range ?? "");
    if (m && req.headers["if-range"] === '"v1"') start = Number(m[1]);
    const headers = { "content-length": body.length - start, ...(ranges ? { "accept-ranges": "bytes", etag: '"v1"' } : {}) };
    if (start) res.writeHead(206, { ...headers, "content-range": `bytes ${start}-${body.length - 1}/${body.length}` });
    else res.writeHead(200, headers);
    if (misbehave?.(seen.length, req, res, body.subarray(start))) return;
    res.end(body.subarray(start));
  });
  await new Promise((r) => server.listen(0, "127.0.0.1", r));
  return { url: `http://127.0.0.1:${server.address().port}`, seen, close: () => new Promise((r) => { server.closeAllConnections(); server.close(r); }) };
}

test("a dropped connection is resumed with Range from the byte reached", async () => {
  const dir = zoneImage(), out = temp(), into = path.join(temp(), "x");
  const file = await packZoneImage(dir, path.join(out, "a.tgz"));
  const s = await serve(file, { misbehave: (n, req, res, rest) => { if (n === 1) { res.write(rest.subarray(0, 600_000)); setTimeout(() => res.socket.destroy(), 50); return true; } } });
  try {
    assert.equal(await fromHttp(`${s.url}/{zone}/{version}.tgz`, { retryDelayMs: 10 }).fetch({ zone: "blog", version: "1", into }), true);
    assert.equal(digestBuild(into).digest, digestBuild(dir).digest);
    assert.equal(s.seen.length, 2);
    assert.match(s.seen[1].range, /^bytes=\d+-$/);
    assert.equal(s.seen[1].ifRange, '"v1"');
  } finally { await s.close(); for (const d of [dir, out, path.dirname(into)]) fs.rmSync(d, { recursive: true, force: true }); }
});

test("a stalled response is dropped and resumed", async () => {
  const dir = zoneImage(), out = temp(), into = path.join(temp(), "x");
  const file = await packZoneImage(dir, path.join(out, "a.tgz"));
  const s = await serve(file, { misbehave: (n, req, res, rest) => { if (n === 1) { res.write(rest.subarray(0, 300_000)); return true; } } });   // then silence
  try {
    assert.equal(await fromHttp(`${s.url}/{zone}/{version}.tgz`, { stallMs: 300, retryDelayMs: 10 }).fetch({ zone: "blog", version: "1", into }), true);
    assert.equal(digestBuild(into).digest, digestBuild(dir).digest);
    assert.ok(s.seen[1].range, "resumed");
  } finally { await s.close(); for (const d of [dir, out, path.dirname(into)]) fs.rmSync(d, { recursive: true, force: true }); }
});

test("a server that cannot resume fails the pull with the reason", async () => {
  const dir = zoneImage(), out = temp(), into = path.join(temp(), "x");
  const file = await packZoneImage(dir, path.join(out, "a.tgz"));
  const s = await serve(file, { ranges: false, misbehave: (n, req, res, rest) => { res.write(rest.subarray(0, 400_000)); setTimeout(() => res.socket.destroy(), 50); return true; } });
  try {
    await assert.rejects(fromHttp(`${s.url}/{zone}/{version}.tgz`, { retryDelayMs: 10 }).fetch({ zone: "blog", version: "1", into }), /cannot resume/);
    assert.equal(s.seen.length, 1);
  } finally { await s.close(); for (const d of [dir, out, path.dirname(into)]) fs.rmSync(d, { recursive: true, force: true }); }
});

test("fromConnector sends its token, reads a .zip, and passes a refusal's reason on", async () => {
  const dir = zoneImage(), out = temp(), into = path.join(temp(), "x");
  const file = await packZoneImage(dir, path.join(out, "a.zip"));
  const body = fs.readFileSync(file), paths = [];
  const server = http.createServer((req, res) => {
    paths.push([req.url, req.headers.authorization]);
    if (req.url.endsWith("@2")) return res.writeHead(403, { "content-type": "application/json" }).end(JSON.stringify({ error: "plan_limit", message: "Blog Pro is needed for this zone" }));
    res.writeHead(200, { "content-length": body.length }).end(body);
  });
  await new Promise((r) => server.listen(0, "127.0.0.1", r));
  try {
    const source = fromConnector({ origin: `http://127.0.0.1:${server.address().port}/`, owner: "acme", token: async () => "t0k" });
    assert.equal(await source.fetch({ zone: "blog", version: "1", into }), true);
    assert.equal(digestBuild(into).digest, digestBuild(dir).digest);
    assert.deepEqual(paths[0], ["/api/connector/images/zones/acme/blog@1", "Bearer t0k"]);
    await assert.rejects(source.fetch({ zone: "blog", version: "2", into: path.join(path.dirname(into), "y") }), /403: Blog Pro is needed/);
  } finally { server.close(); for (const d of [dir, out, path.dirname(into)]) fs.rmSync(d, { recursive: true, force: true }); }
});
