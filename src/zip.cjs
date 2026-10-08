"use strict";
/*
 * Zip, for zone images held where zip is the format: service-connector's store keeps an image as one .zip, and an
 * image a product keeps in its own repository arrives as the repository's archive of a tag.
 *
 * - readZip(file, into): every entry written under `into`, streamed (one file's data at a time through inflateRaw),
 *   each checked against its CRC-32. Read from the central directory, the only reliable list: an archive written as
 *   a stream (git archive does so for large files) leaves sizes out of its local headers. Paths must stay inside
 *   `into`, nothing is written through a link, and Zip64 archives (over 4 GB, or over 65535 entries) are refused.
 * - writeZip(dir, outFile): a folder as a .zip (deflate, Unix modes and links kept), streamed.
 */
const fs = require("node:fs");
const path = require("node:path");
const zlib = require("node:zlib");
const { pipeline } = require("node:stream/promises");
const { Readable, Transform } = require("node:stream");

const LOCAL = 0x04034b50, CENTRAL = 0x02014b50, END = 0x06054b50, ZIP64_END_LOCATOR = 0x07064b50;
const S_IFMT = 0o170000, S_IFLNK = 0o120000, S_IFDIR = 0o040000;

/** The central directory's entries: { name, method, crc, compressedSize, size, offset, mode, isDir, isLink }. */
async function centralDirectory(handle, fileSize) {
  const tail = Math.min(fileSize, 65557);                     // the end record (22 bytes) and a comment of up to 64 KB
  const buf = Buffer.alloc(tail);
  await handle.read(buf, 0, tail, fileSize - tail);
  let at = -1;
  for (let i = tail - 22; i >= 0; i--) if (buf.readUInt32LE(i) === END) { at = i; break; }
  if (at < 0) throw new Error("not a zip archive (no end of central directory)");
  if (at >= 20 && buf.readUInt32LE(at - 20) === ZIP64_END_LOCATOR) throw new Error("Zip64 archives are not supported: pack the zone image as .tgz");
  const count = buf.readUInt16LE(at + 10), cdSize = buf.readUInt32LE(at + 12), cdOffset = buf.readUInt32LE(at + 16);
  if (count === 0xffff || cdSize === 0xffffffff || cdOffset === 0xffffffff) throw new Error("Zip64 archives are not supported: pack the zone image as .tgz");
  const cd = Buffer.alloc(cdSize);
  await handle.read(cd, 0, cdSize, cdOffset);
  const entries = [];
  for (let p = 0, n = 0; n < count; n++) {
    if (cd.readUInt32LE(p) !== CENTRAL) throw new Error("a corrupt zip archive (central directory)");
    const flags = cd.readUInt16LE(p + 8), method = cd.readUInt16LE(p + 10), crc = cd.readUInt32LE(p + 16);
    const compressedSize = cd.readUInt32LE(p + 20), size = cd.readUInt32LE(p + 24);
    const nameLen = cd.readUInt16LE(p + 28), extraLen = cd.readUInt16LE(p + 30), commentLen = cd.readUInt16LE(p + 32);
    const madeBy = cd.readUInt16LE(p + 4) >> 8, external = cd.readUInt32LE(p + 38), offset = cd.readUInt32LE(p + 42);
    if (compressedSize === 0xffffffff || size === 0xffffffff || offset === 0xffffffff) throw new Error("Zip64 archives are not supported: pack the zone image as .tgz");
    if (flags & 0x1) throw new Error("encrypted zip archives are not supported");
    const name = cd.toString(flags & 0x800 ? "utf8" : "latin1", p + 46, p + 46 + nameLen);
    const mode = madeBy === 3 ? external >>> 16 : 0;          // 3: Unix, the mode in the high 16 bits
    entries.push({ name, method, crc, compressedSize, size, offset, mode, isDir: name.endsWith("/") || (mode & S_IFMT) === S_IFDIR, isLink: (mode & S_IFMT) === S_IFLNK });
    p += 46 + nameLen + extraLen + commentLen;
  }
  return entries;
}

/** A transform computing the CRC-32 of what passes through. */
function crcCheck(expected, name) {
  let crc = 0;
  return new Transform({
    transform(chunk, _, done) { crc = zlib.crc32(chunk, crc); done(null, chunk); },
    flush(done) { done((crc >>> 0) === expected ? null : new Error(`the zip entry ${JSON.stringify(name)} is corrupt (CRC-32)`)); },
  });
}

/** Writes the zip `file` under `into`; resolves the bytes written. */
async function readZip(file, into, { signal } = {}) {
  const root = path.resolve(into);
  const inside = (target) => target === root || target.startsWith(root + path.sep);
  const throughLink = (target) => {
    for (let dir = path.dirname(target); dir !== root && inside(dir); dir = path.dirname(dir)) {
      if (fs.existsSync(dir) && fs.lstatSync(dir).isSymbolicLink()) return true;
    }
    return false;
  };
  const handle = await fs.promises.open(file, "r");
  let written = 0;
  try {
    const entries = await centralDirectory(handle, (await handle.stat()).size);
    for (const e of entries) {
      signal?.throwIfAborted();
      const target = path.resolve(root, e.name);
      if (path.isAbsolute(e.name) || !inside(target) || throughLink(target)) throw new Error(`the zone image's entry ${JSON.stringify(e.name)} leaves its folder`);
      if (e.isDir) { await fs.promises.mkdir(target, { recursive: true }); continue; }
      if (e.method !== 0 && e.method !== 8) throw new Error(`the zip entry ${JSON.stringify(e.name)} uses compression method ${e.method} (stored and deflate are read)`);
      /* Where its data starts: after its local header, whose name and extra lengths may differ from the central one's. */
      const local = Buffer.alloc(30);
      await handle.read(local, 0, 30, e.offset);
      if (local.readUInt32LE(0) !== LOCAL) throw new Error(`a corrupt zip archive (local header of ${JSON.stringify(e.name)})`);
      const start = e.offset + 30 + local.readUInt16LE(26) + local.readUInt16LE(28);
      await fs.promises.mkdir(path.dirname(target), { recursive: true });
      const data = e.compressedSize ? fs.createReadStream(null, { fd: handle.fd, autoClose: false, start, end: start + e.compressedSize - 1 }) : Readable.from([]);
      const stages = [data, ...(e.method === 8 ? [zlib.createInflateRaw()] : []), crcCheck(e.crc, e.name)];
      if (e.isLink) {
        const parts = [];
        await pipeline(...stages, async function* (src) { for await (const c of src) parts.push(c); }, { signal });
        await fs.promises.symlink(Buffer.concat(parts).toString("utf8"), target);
      } else {
        await pipeline(...stages, fs.createWriteStream(target, { flags: "wx" }), { signal });
        written += e.size;
      }
    }
  } finally {
    await handle.close();
  }
  return written;
}

/* ── writing ──────────────────────────────────────────────────────────────────────────────────────────────────── */

function dosTime() { return { time: 0, date: (1980 - 1980) << 9 | 1 << 5 | 1 }; }   // fixed: one folder zips to the same bytes

/** Packs `dir` into the zip `outFile` (deflate, streamed, entries in a stable order). Resolves the file path. */
async function writeZip(dir, outFile) {
  const out = fs.createWriteStream(outFile);
  let offset = 0;
  const central = [];
  const write = (buf) => new Promise((resolve, reject) => { offset += buf.length; out.write(buf, (error) => (error ? reject(error) : resolve())); });
  const { time, date } = dosTime();
  async function add(name, { mode, data, stream }) {
    const nameBuf = Buffer.from(name, "utf8");
    const header = Buffer.alloc(30);
    header.writeUInt32LE(LOCAL, 0); header.writeUInt16LE(20, 4); header.writeUInt16LE(0x808, 6);   // UTF-8 names, sizes after the data
    header.writeUInt16LE(data === null ? 0 : 8, 8); header.writeUInt16LE(time, 10); header.writeUInt16LE(date, 12);
    header.writeUInt16LE(nameBuf.length, 26);
    const at = offset;
    await write(header); await write(nameBuf);
    let crc = 0, size = 0, compressed = 0;
    if (data !== null) {
      const deflate = zlib.createDeflateRaw({ level: 9 });
      const source = stream ?? Readable.from([data]);
      const counted = new Transform({ transform(c, _, done) { crc = zlib.crc32(c, crc); size += c.length; done(null, c); } });
      await pipeline(source, counted, deflate, async function* (src) { for await (const c of src) { compressed += c.length; await write(c); } });
    }
    const descriptor = Buffer.alloc(16);
    descriptor.writeUInt32LE(0x08074b50, 0); descriptor.writeUInt32LE(crc >>> 0, 4); descriptor.writeUInt32LE(compressed, 8); descriptor.writeUInt32LE(size, 12);
    await write(descriptor);
    if (offset > 0xffffffff) throw new Error("the zone image is over 4 GB: pack it as .tgz");
    central.push({ nameBuf, method: data === null ? 0 : 8, crc: crc >>> 0, compressed, size, at, mode });
  }
  const walk = async (rel) => {
    const items = (await fs.promises.readdir(path.join(dir, rel), { withFileTypes: true })).sort((a, b) => (a.name < b.name ? -1 : 1));
    for (const item of items) {
      const name = rel ? `${rel}/${item.name}` : item.name, full = path.join(dir, name);
      if (item.isSymbolicLink()) await add(name, { mode: S_IFLNK | 0o777, data: Buffer.from(await fs.promises.readlink(full)) });
      else if (item.isDirectory()) { await add(`${name}/`, { mode: S_IFDIR | 0o755, data: null }); await walk(name); }
      else if (item.isFile()) await add(name, { mode: 0o100644, data: Buffer.alloc(0), stream: fs.createReadStream(full) });
    }
  };
  await walk("");
  const cdStart = offset;
  for (const e of central) {
    const h = Buffer.alloc(46);
    h.writeUInt32LE(CENTRAL, 0); h.writeUInt16LE(3 << 8 | 20, 4); h.writeUInt16LE(20, 6); h.writeUInt16LE(0x808, 8);
    h.writeUInt16LE(e.method, 10); h.writeUInt16LE(time, 12); h.writeUInt16LE(date, 14); h.writeUInt32LE(e.crc, 16);
    h.writeUInt32LE(e.compressed, 20); h.writeUInt32LE(e.size, 24); h.writeUInt16LE(e.nameBuf.length, 28);
    h.writeUInt32LE((e.mode << 16) >>> 0, 38); h.writeUInt32LE(e.at, 42);
    await write(h); await write(e.nameBuf);
  }
  if (central.length > 0xfffe) throw new Error("the zone image has over 65534 files: pack it as .tgz");
  const end = Buffer.alloc(22);
  end.writeUInt32LE(END, 0); end.writeUInt16LE(central.length, 8); end.writeUInt16LE(central.length, 10);
  end.writeUInt32LE(offset - cdStart, 12); end.writeUInt32LE(cdStart, 16);
  await write(end);
  await new Promise((resolve, reject) => out.end((error) => (error ? reject(error) : resolve())));
  return outFile;
}

module.exports = { readZip, writeZip };
