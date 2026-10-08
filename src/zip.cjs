"use strict";
/*
 * Zip, for zone images held where zip is the format: service-connector's store keeps an image as one .zip, and an
 * image a product keeps in its own repository arrives as the repository's archive of a tag.
 *
 * - readZip(file, into): every entry written under `into`, streamed (one file's data at a time through inflateRaw),
 *   each checked against its CRC-32. Read from the central directory, the only reliable list: an archive written as
 *   a stream (git archive does so for large files) leaves sizes out of its local headers. Paths must stay inside
 *   `into`, nothing is written through a link, and Zip64 archives (over 4 GB, or over 65535 entries) are refused.
 * - readZipStream(source, into): the same from a stream, as it arrives, with nothing spooled to disk: entries are read
 *   from their local headers in order (an entry whose sizes come after its data is inflated until its deflate stream
 *   ends), and the central directory at the end must then agree with what was written (names, CRC-32, sizes), or the
 *   unpack fails. Unix modes are only in the central directory, so links are made from it, last.
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
  return parseCentral(cd, count);
}

/** The entries of a central directory of `count` entries, read from the buffer `cd`. */
function parseCentral(cd, count) {
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

/** The end of central directory record in `tail`: { count } (Zip64 refused). */
function endRecord(tail) {
  let at = -1;
  for (let i = tail.length - 22; i >= 0; i--) if (tail.readUInt32LE(i) === END) { at = i; break; }
  if (at < 0) throw new Error("a corrupt zip archive (no end of central directory)");
  if (at >= 20 && tail.readUInt32LE(at - 20) === ZIP64_END_LOCATOR) throw new Error("Zip64 archives are not supported: pack the zone image as .tgz");
  const count = tail.readUInt16LE(at + 10);
  if (count === 0xffff) throw new Error("Zip64 archives are not supported: pack the zone image as .tgz");
  return { count, at };
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
  /* Written at positions: each entry's sizes and CRC-32 go back into its local header once its data is out, so a
     reader knows them before the data (readZipStream reads such entries in parallel), with no data descriptor. */
  const out = await fs.promises.open(outFile, "w");
  let offset = 0;
  const central = [];
  const write = async (buf) => { const at = offset; offset += buf.length; await out.write(buf, 0, buf.length, at); };
  const { time, date } = dosTime();
  async function add(name, { mode, data, stream }) {
    const nameBuf = Buffer.from(name, "utf8");
    const header = Buffer.alloc(30);
    header.writeUInt32LE(LOCAL, 0); header.writeUInt16LE(20, 4); header.writeUInt16LE(0x800, 6);   // UTF-8 names
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
    const sizes = Buffer.alloc(12);
    sizes.writeUInt32LE(crc >>> 0, 0); sizes.writeUInt32LE(compressed, 4); sizes.writeUInt32LE(size, 8);
    await out.write(sizes, 0, 12, at + 14);
    if (offset > 0xffffffff) throw new Error("the zone image is over 4 GB: pack it as .tgz");
    central.push({ nameBuf, method: data === null ? 0 : 8, crc: crc >>> 0, compressed, size, at, mode });
  }
  try {
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
      h.writeUInt32LE(CENTRAL, 0); h.writeUInt16LE(3 << 8 | 20, 4); h.writeUInt16LE(20, 6); h.writeUInt16LE(0x800, 8);
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
  } finally {
    await out.close();
  }
  return outFile;
}

/* ── reading as it arrives ─────────────────────────────────────────────────────────────────────────────────────── */

const PARALLEL = 4, PARALLEL_MAX = 2 * 1048576, IN_FLIGHT = 16 * 1048576;
const inflateRaw = require("node:util").promisify(zlib.inflateRaw);

/** Bytes from an async iterable, taken by count: read(n) waits for n bytes (fewer at the end), unread() puts some back. */
function byteReader(source) {
  const iterator = source[Symbol.asyncIterator]();
  /* What has arrived, kept as pieces and joined only when taken: pieces of a few bytes cost no copying per piece. */
  let pieces = [], length = 0, ended = false;
  const more = async () => {
    if (ended) return false;
    const next = await iterator.next();
    if (next.done) { ended = true; return false; }
    const b = Buffer.from(next.value);
    pieces.push(b); length += b.length;
    return true;
  };
  const take = (n) => {
    const all = pieces.length === 1 ? pieces[0] : Buffer.concat(pieces, length);
    const out = all.subarray(0, Math.min(n, all.length)), rest = all.subarray(out.length);
    pieces = rest.length ? [rest] : []; length = rest.length;
    return out;
  };
  return {
    async read(n) { while (length < n && await more()); return take(n); },
    /** Up to `max` bytes, gathered to 64 KB when the source gives less (fewer only at its end): one write each. */
    async chunk(max = Infinity) { while (length < Math.min(max, 65536) && await more()); return take(max); },
    unread(bytes) { if (bytes.length) { pieces.unshift(bytes); length += bytes.length; } },
    async rest() { while (await more()); return take(Infinity); },
  };
}

/**
 * Writes a zip arriving on `source` (a stream or async iterable of bytes) under `into`, as it arrives; resolves the
 * bytes written. The same checks as readZip: paths inside `into`, nothing through a link, CRC-32 of every entry, no
 * Zip64; and the central directory must agree with the entries read.
 */
async function readZipStream(source, into, { signal } = {}) {
  const root = path.resolve(into);
  const inside = (target) => target === root || target.startsWith(root + path.sep);
  const reader = byteReader(source);
  const seen = [];                                              // { name, crc, size, target }
  let written = 0;
  /* Entries whose sizes come before their data, up to PARALLEL_MAX compressed: read whole, then inflated and written
     while the next ones arrive, PARALLEL at once (zlib and fs work on libuv's thread pool) and IN_FLIGHT bytes at most. */
  const tasks = new Set();
  let inFlight = 0, failed = null;
  const room = async (bytes) => {
    while (tasks.size && (tasks.size >= PARALLEL || inFlight + bytes > IN_FLIGHT)) await Promise.race(tasks);
    if (failed) throw failed;
  };
  const spawn = (bytes, work) => {
    inFlight += bytes;
    const task = work().catch((error) => { failed ??= error; }).finally(() => { inFlight -= bytes; tasks.delete(task); });
    tasks.add(task);
  };
  try {
    for (;;) {
      signal?.throwIfAborted();
      const sig = await reader.read(4);
      if (sig.length < 4) throw new Error("a corrupt zip archive (it ends before its central directory)");
      const kind = sig.readUInt32LE(0);
      if (kind === CENTRAL || kind === END) { reader.unread(sig); break; }
      if (kind !== LOCAL) throw new Error("a corrupt zip archive (expected a local header)");
      const h = await reader.read(26);
      if (h.length < 26) throw new Error("a corrupt zip archive (a local header is cut short)");
      const flags = h.readUInt16LE(2), method = h.readUInt16LE(4);
      let crc = h.readUInt32LE(10), compressedSize = h.readUInt32LE(14), size = h.readUInt32LE(18);
      const nameBuf = await reader.read(h.readUInt16LE(22));
      await reader.read(h.readUInt16LE(24));                      // extra field
      const name = nameBuf.toString(flags & 0x800 ? "utf8" : "latin1");
      const later = Boolean(flags & 0x8);                         // sizes and CRC-32 in a data descriptor after the data
      if (flags & 0x1) throw new Error("encrypted zip archives are not supported");
      if (compressedSize === 0xffffffff || size === 0xffffffff) throw new Error("Zip64 archives are not supported: pack the zone image as .tgz");
      if (method !== 0 && method !== 8) throw new Error(`the zip entry ${JSON.stringify(name)} uses compression method ${method} (stored and deflate are read)`);
      const target = path.resolve(root, name);
      if (path.isAbsolute(name) || !inside(target)) throw new Error(`the zone image's entry ${JSON.stringify(name)} leaves its folder`);
      const isDir = name.endsWith("/");
      if (method === 0 && later && !isDir) throw new Error(`the zip entry ${JSON.stringify(name)} is stored with its size after its data, which cannot be read as it arrives`);
      if (isDir) await fs.promises.mkdir(target, { recursive: true });
      else await fs.promises.mkdir(path.dirname(target), { recursive: true });
      if (!isDir && compressedSize > 0 && compressedSize <= PARALLEL_MAX && size <= PARALLEL_MAX * 64) {
        const packed = await reader.read(compressedSize);
        if (packed.length < compressedSize) throw new Error(`a corrupt zip archive (${JSON.stringify(name)} is cut short)`);
        if (later) {
          let d = await reader.read(4);
          if (d.length === 4 && d.readUInt32LE(0) === 0x08074b50) d = await reader.read(12); else d = Buffer.concat([d, await reader.read(8)]);
          if (d.length < 12) throw new Error(`a corrupt zip archive (the data descriptor of ${JSON.stringify(name)})`);
          crc = d.readUInt32LE(0); size = d.readUInt32LE(8);
        }
        await room(compressedSize + size);
        const expected = { crc, size };
        spawn(compressedSize + size, async () => {
          const data = method === 8 ? await inflateRaw(packed) : packed;
          if (data.length !== expected.size || (zlib.crc32(data) >>> 0) !== expected.crc) throw new Error(`the zip entry ${JSON.stringify(name)} is corrupt (CRC-32)`);
          await fs.promises.writeFile(target, data, { flag: "wx" });
        });
        written += size;
        seen.push({ name, crc, size, target, isDir });
        continue;
      }
      /* The data: through inflateRaw (which stops where its stream ends, when the size is not known) or as stored. */
      let crcNow = 0, out = 0;
      const counted = new Transform({ transform(c, _, done) { crcNow = zlib.crc32(c, crcNow); out += c.length; done(null, c); } });
      const inflate = method === 8 ? zlib.createInflateRaw() : null;
      const head = inflate ?? counted;
      const sink = isDir ? new (require("node:stream").Writable)({ write(c, _, done) { done(); } }) : fs.createWriteStream(target, { flags: "wx" });
      const flowing = inflate ? pipeline(inflate, counted, sink, { signal }) : pipeline(counted, sink, { signal });
      let ended = false;
      if (inflate) inflate.once("end", () => { ended = true; });
      /* A stored folder has no data, whatever its header says of its sizes. */
      const known = !later || compressedSize > 0 || (isDir && method === 0);
      let left = known ? compressedSize : Infinity, fed = 0;
      while (left > 0 && !ended) {
        const piece = await reader.chunk(left);
        if (!piece.length) throw new Error(`a corrupt zip archive (${JSON.stringify(name)} is cut short)`);
        const before = fed;
        fed += piece.length;
        await new Promise((resolve, reject) => head.write(piece, (error) => (error ? reject(error) : resolve())));
        if (inflate) await new Promise((resolve) => setImmediate(resolve));
        if (!known && inflate && (ended || inflate.bytesWritten < fed)) {
          /* The deflate stream ended inside this piece: what follows it is the data descriptor and the next entry. */
          reader.unread(piece.subarray(inflate.bytesWritten - before));
          fed = inflate.bytesWritten;
          break;
        }
        if (known) left -= piece.length;
      }
      head.end();
      await flowing;
      if (later) {
        let d = await reader.read(4);
        if (d.length === 4 && d.readUInt32LE(0) === 0x08074b50) d = await reader.read(12); else d = Buffer.concat([d, await reader.read(8)]);
        if (d.length < 12) throw new Error(`a corrupt zip archive (the data descriptor of ${JSON.stringify(name)})`);
        crc = d.readUInt32LE(0); compressedSize = d.readUInt32LE(4); size = d.readUInt32LE(8);
        if (compressedSize !== fed) throw new Error(`the zip entry ${JSON.stringify(name)} is corrupt (its size)`);
      }
      if ((crcNow >>> 0) !== crc || out !== size) throw new Error(`the zip entry ${JSON.stringify(name)} is corrupt (CRC-32)`);
      if (!isDir) written += size;
      seen.push({ name, crc, size, target, isDir });
    }
  } catch (error) {
    /* Nothing may still be writing once the caller cleans up after the error. */
    await Promise.allSettled(tasks);
    throw error;
  }
  await Promise.all(tasks);
  if (failed) throw failed;
  /* The central directory: the only list of Unix modes, and a second record of every entry, which must agree. */
  const tail = await reader.rest();
  const { count, at } = endRecord(tail);
  if (count !== seen.length) throw new Error(`a corrupt zip archive (its central directory lists ${count} entries, ${seen.length} were read)`);
  const entries = parseCentral(tail.subarray(0, at), count);
  for (let i = 0; i < count; i++) {
    const e = entries[i], s = seen[i];
    if (e.name !== s.name || e.crc !== s.crc || e.size !== s.size) throw new Error(`a corrupt zip archive (the central directory disagrees about ${JSON.stringify(e.name)})`);
  }
  /* Links last, from the files their entries were written as: nothing was written through them. */
  for (let i = 0; i < count; i++) {
    if (!entries[i].isLink) continue;
    const { target } = seen[i];
    const link = await fs.promises.readFile(target, "utf8");
    await fs.promises.rm(target);
    await fs.promises.symlink(link, target);
    written -= seen[i].size;
  }
  return written;
}

module.exports = { readZip, readZipStream, writeZip };
