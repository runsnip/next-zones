"use strict";
/*
 * Zone images: what `next-zones build` writes into a store (<store>/<zone>/<version>/, with zone.json), and the sources
 * they are pulled from. A pull (zones/pull.cjs) is the only way an image enters a store; nothing is uploaded to Zones.
 *
 *   createZones({ store, sources: [fromHttp("https://images.example.com/{zone}/{version}.tgz"), mySource] })
 *
 * A source is { name, fetch({ zone, version, into, signal }) }: it writes the zone image's files into `into` (an empty
 * folder) and resolves true, or resolves false when it does not have that version. It should stream (an image weighs up
 * to hundreds of MB) and pass `signal` on: Zones aborts a pull when the disk fills. Zones then checks the image (it must
 * name that zone and version, and match the integrity recorded at build time) before moving it into the store in one
 * rename. Anything else is refused and the store is unchanged.
 *
 * packZoneImage() and unpackZoneImage() carry a zone image as one .tgz file (`next-zones pack`): a POSIX tar (ustar, with
 * PAX records for long paths), gzipped, read and written as streams, so memory does not grow with the image. Two sources
 * come with the package: fromDirectory() and fromHttp().
 */
const fs = require("node:fs");
const path = require("node:path");
const zlib = require("node:zlib");
const { Readable } = require("node:stream");
const { pipeline } = require("node:stream/promises");
const { readZip, readZipStream, writeZip } = require("./zip.cjs");

const BLOCK = 512;

/* ── tar ─────────────────────────────────────────────────────────────────────────────────────────────────────────── */

function octal(value, length) {
  return value.toString(8).padStart(length - 1, "0") + "\0";
}

function header({ name, size = 0, type = "0", mode = 0o644, linkname = "" }) {
  const block = Buffer.alloc(BLOCK);
  block.write(name, 0, 100, "utf8");
  block.write(octal(mode, 8), 100, "ascii");
  block.write(octal(0, 8), 108, "ascii");
  block.write(octal(0, 8), 116, "ascii");
  block.write(octal(size, 12), 124, "ascii");
  block.write(octal(0, 12), 136, "ascii");                 // mtime 0: the same zone image packs to the same bytes
  block.write("        ", 148, "ascii");                    // checksum placeholder
  block.write(type, 156, "ascii");
  block.write(linkname, 157, 100, "utf8");
  block.write("ustar\0", 257, "ascii");
  block.write("00", 263, "ascii");
  let sum = 0;
  for (const byte of block) sum += byte;
  block.write(octal(sum, 7) + " ", 148, "ascii");
  return block;
}

const pad = (size) => Buffer.alloc((BLOCK - (size % BLOCK)) % BLOCK);

/* A PAX record "<length> <key>=<value>\n", where the length counts itself. */
function paxRecord(key, value) {
  const body = ` ${key}=${value}\n`;
  let length = Buffer.byteLength(body);
  while (Buffer.byteLength(body) + String(length).length !== length) length = Buffer.byteLength(body) + String(length).length;
  return `${length}${body}`;
}

function entry(blocks, { name, type, size = 0, linkname = "", mode }) {
  const needsPax = Buffer.byteLength(name) > 100 || Buffer.byteLength(linkname) > 100 || /[^\x20-\x7e]/.test(name + linkname);
  if (needsPax) {
    const pax = Buffer.from(paxRecord("path", name) + (linkname ? paxRecord("linkpath", linkname) : ""));
    blocks.push(header({ name: "PaxHeader", size: pax.length, type: "x" }), pax, pad(pax.length));
  }
  blocks.push(header({ name: needsPax ? name.slice(0, 99) : name, size, type, mode, linkname: needsPax ? "" : linkname }));
}

/**
 * Packs a zone image folder into a .tgz (its files, folders and links, in a stable order), streamed: one file is read at
 * a time, so memory does not grow with the image. Resolves the file path.
 */
async function packZoneImage(dir, outFile) {
  if (!fs.existsSync(path.join(dir, "zone.json"))) throw new Error(`${dir} is not a zone image (no zone.json)`);
  /* A .zip, the format of service-connector's store, when the file is named so. */
  if (outFile.endsWith(".zip")) return writeZip(dir, outFile);
  async function* tar() {
    async function* walk(rel) {
      const items = (await fs.promises.readdir(path.join(dir, rel), { withFileTypes: true })).sort((a, b) => (a.name < b.name ? -1 : 1));
      for (const item of items) {
        const name = rel ? `${rel}/${item.name}` : item.name;
        const full = path.join(dir, name);
        const blocks = [];
        if (item.isSymbolicLink()) { entry(blocks, { name, type: "2", linkname: await fs.promises.readlink(full), mode: 0o777 }); yield* blocks; }
        else if (item.isDirectory()) { entry(blocks, { name: `${name}/`, type: "5", mode: 0o755 }); yield* blocks; yield* walk(name); }
        else if (item.isFile()) {
          const { size } = await fs.promises.stat(full);
          entry(blocks, { name, type: "0", size, mode: 0o644 });
          yield* blocks;
          let read = 0;
          for await (const chunk of fs.createReadStream(full)) { read += chunk.length; yield chunk; }
          if (read !== size) throw new Error(`${full} changed while it was packed`);
          yield pad(size);
        }
      }
    }
    yield* walk("");
    yield Buffer.alloc(BLOCK * 2);
  }
  await pipeline(Readable.from(tar()), zlib.createGzip({ level: 9 }), fs.createWriteStream(outFile));
  return outFile;
}

/**
 * Unpacks a .tgz zone image into `into`, streamed: `input` is a readable stream, a file path or a Buffer. Every path must
 * stay inside `into`, and nothing is written through a link: an archive that tries is refused. A hard link, a device
 * or any other entry type is refused too. `signal` stops it (the caller removes `into`). Resolves the bytes written.
 */
async function unpackTgz(source, into, { signal } = {}) {
  const root = path.resolve(into);
  await fs.promises.mkdir(root, { recursive: true });
  const inside = (target) => target === root || target.startsWith(root + path.sep);
  const throughLink = (target) => {
    for (let dir = path.dirname(target); dir !== root && inside(dir); dir = path.dirname(dir)) {
      if (fs.existsSync(dir) && fs.lstatSync(dir).isSymbolicLink()) return true;
    }
    return false;
  };
  let written = 0;
  async function untar(tar) {
    let pending = Buffer.alloc(0), pax = {}, ended = false;
    /* The entry being read: its data goes to `sink`, then `skip` bytes of padding. */
    let data = null, skip = 0, open = null;
    try {
    for await (const chunk of tar) {
      pending = pending.length ? Buffer.concat([pending, chunk]) : chunk;
      let offset = 0;
      while (offset < pending.length) {
        if (skip) { const n = Math.min(skip, pending.length - offset); skip -= n; offset += n; continue; }
        if (data) {
          const n = Math.min(data.remaining, pending.length - offset);
          if (n) await data.sink(pending.subarray(offset, offset + n));
          data.remaining -= n; offset += n;
          if (data.remaining === 0) { await data.done(); skip = data.pad; data = null; }
          continue;
        }
        if (ended) { offset = pending.length; break; }
        if (pending.length - offset < BLOCK) break;
        const block = pending.subarray(offset, offset + BLOCK);
        offset += BLOCK;
        if (block.every((b) => b === 0)) { ended = true; continue; }
        const field = (start, length) => block.subarray(start, start + length).toString("utf8").replace(/\0.*$/s, "");
        const size = Number(pax.size ?? parseInt(field(124, 12).trim() || "0", 8));
        const type = field(156, 1) || "0";
        const padding = (BLOCK - (size % BLOCK)) % BLOCK;
        if (type === "x" || type === "g") {
          if (size > 1 << 20) throw new Error("the zone image's archive has an oversized PAX header");
          const parts = [];
          data = { remaining: size, pad: padding, sink: (b) => { parts.push(Buffer.from(b)); }, done: () => {
            if (type === "g") return;
            for (const line of Buffer.concat(parts).toString("utf8").split("\n").filter(Boolean)) {
              const [, key, value] = /^\d+ ([^=]+)=(.*)$/s.exec(line) ?? [];
              if (key) pax[key] = value;
            }
          } };
          if (size === 0) { data.done(); data = null; skip = padding; }
          continue;
        }
        const prefix = field(345, 155);
        const name = pax.path ?? (prefix ? `${prefix}/${field(0, 100)}` : field(0, 100));
        const linkname = pax.linkpath ?? field(157, 100);
        pax = {};
        const target = path.resolve(root, name);
        if (!inside(target) || throughLink(target)) throw new Error(`the zone image's entry ${JSON.stringify(name)} leaves its folder`);
        if (type === "5") { await fs.promises.mkdir(target, { recursive: true }); skip = size + padding; }
        else if (type === "2") { await fs.promises.mkdir(path.dirname(target), { recursive: true }); await fs.promises.symlink(linkname, target); skip = size + padding; }
        else if (type === "0") {
          await fs.promises.mkdir(path.dirname(target), { recursive: true });
          const handle = open = await fs.promises.open(target, "wx");
          data = {
            remaining: size, pad: padding,
            sink: async (b) => { await handle.write(b); written += b.length; },
            done: async () => { open = null; await handle.close(); },
          };
          if (size === 0) { await data.done(); data = null; skip = padding; }
        } else throw new Error(`the zone image's entry ${JSON.stringify(name)} is of a type a zone image never holds (${type})`);
      }
      pending = offset < pending.length ? pending.subarray(offset) : Buffer.alloc(0);
    }
    if (data) throw new Error("the zone image's archive ends inside a file");
    if (!ended) throw new Error("the zone image's archive ends before its end marker");
    } finally {
      /* A file left open by an archive cut short, or by a stop. */
      if (open) await open.close().catch(() => {});
    }
  }
  await pipeline(source, zlib.createGunzip({ chunkSize: 1 << 20 }), untar, { signal });
  return written;
}

/**
 * Unpacks a zone image into `into`: a .tgz (`next-zones pack`) or a .zip (service-connector's store, or a repository's
 * archive of a tag), told apart by their first bytes. `input` is a readable stream, a file path or a Buffer. Both are
 * unpacked as they are read, neither held in memory nor spooled to disk (a .zip's central directory, at its end, is
 * checked against what was written). An archive whose files sit in one top-level folder (a repository's
 * archive: <repo>-<ref>/zone.json) is unwrapped. Every path must stay inside `into`, nothing is written through a link.
 * Resolves the bytes written.
 */
async function unpackZoneImage(input, into, { signal } = {}) {
  const source = Buffer.isBuffer(input) ? Readable.from([input]) : typeof input === "string" ? fs.createReadStream(input) : input;
  await fs.promises.mkdir(into, { recursive: true });
  /* The first bytes say which format: gzip (1f 8b) or zip (PK 03 04). */
  const iterator = source[Symbol.asyncIterator]();
  let first = Buffer.alloc(0), done = false;
  while (first.length < 4 && !done) {
    const next = await iterator.next();
    if (next.done) done = true; else first = Buffer.concat([first, Buffer.from(next.value)]);
  }
  const rest = Readable.from((async function* () { if (first.length) yield first; if (!done) for (let n = await iterator.next(); !n.done; n = await iterator.next()) yield n.value; })());
  let written;
  if (first[0] === 0x1f && first[1] === 0x8b) written = await unpackTgz(rest, into, { signal });
  else if (first.readUInt32LE?.(0) === 0x04034b50 || (first[0] === 0x50 && first[1] === 0x4b)) {
    written = await readZipStream(rest, into, { signal });
  } else {
    rest.destroy();
    throw new Error("the zone image is neither a .tgz nor a .zip");
  }
  await unwrap(into);
  return written;
}

/* An archive of a repository puts everything under one folder (<repo>-<ref>/): a zone image's files move up from it. */
async function unwrap(into) {
  if (fs.existsSync(path.join(into, "zone.json"))) return;
  const entries = await fs.promises.readdir(into, { withFileTypes: true });
  if (entries.length !== 1 || !entries[0].isDirectory()) return;
  const inner = path.join(into, entries[0].name);
  if (!fs.existsSync(path.join(inner, "zone.json"))) return;
  for (const name of await fs.promises.readdir(inner)) await fs.promises.rename(path.join(inner, name), path.join(into, name));
  await fs.promises.rmdir(inner);
}

/* ── sources ─────────────────────────────────────────────────────────────────────────────────────────────────────── */

/**
 * Zone images in another folder (a mounted volume, a shared disk): <root>/<zone>/<version>/, or
 * <root>/<zone>/<version>.tgz or .zip, unpacked as it is read.
 */
function fromDirectory(root) {
  return {
    name: `directory ${root}`,
    async fetch({ zone, version, into, signal }) {
      const dir = path.join(root, zone, version);
      if (fs.existsSync(path.join(dir, "zone.json"))) { await fs.promises.cp(dir, into, { recursive: true, verbatimSymlinks: true }); return true; }
      for (const archive of [`${dir}.tgz`, `${dir}.zip`]) if (fs.existsSync(archive)) { await unpackZoneImage(archive, into, { signal }); return true; }
      return false;
    },
  };
}

/**
 * Zone images over HTTP, as .tgz or .zip files: `template` has {zone} and {version}, such as
 * "https://zones.example.com/{zone}/{version}.tgz". A 404 means the source does not have it. The response is unpacked
 * as it arrives (a .zip is spooled to disk first), never held whole in memory.
 *
 * A pull of hundreds of MB over a shared link must survive the link:
 * - **stallMs** (30 s): a response that sends nothing for that long is dropped;
 * - **retries** (3): a dropped or stalled response is asked again from the byte reached, with `Range` (and `If-Range`
 *   on its ETag or Last-Modified, so a changed file is never spliced): the unpacking sees one stream. A server that
 *   cannot resume (no 206) fails the pull, and the store is unchanged;
 * - `headers`: an object, or a function of { zone, version } (a short-lived token).
 */
function fromHttp(template, { headers = {}, stallMs = 30_000, retries = 3, retryDelayMs = 1000, name } = {}) {
  return {
    name: name ?? `http ${template}`,
    async fetch({ zone, version, into, signal }) {
      const url = template.replaceAll("{zone}", encodeURIComponent(zone)).replaceAll("{version}", encodeURIComponent(version));
      const headersFor = async () => ({ ...(typeof headers === "function" ? await headers({ zone, version }) : headers) });
      /* One request, with its own stop: the caller's signal, or a stall. */
      const request = async (extra) => {
        const stop = new AbortController();
        const onAbort = () => stop.abort(signal.reason);
        signal?.addEventListener("abort", onAbort, { once: true });
        try {
          const res = await fetch(url, { signal: stop.signal, headers: { ...(await headersFor()), ...extra } });
          return { res, stop, release: () => signal?.removeEventListener("abort", onAbort) };
        } catch (error) { signal?.removeEventListener("abort", onAbort); throw error; }
      };
      let { res, stop, release } = await request({});
      if (res.status === 404) { release(); await res.body?.cancel(); return false; }
      if (!res.ok || !res.body) { release(); throw await refusal(url, res); }
      /* If-Range takes a strong ETag or a date: a weak ETag cannot guard a resumed range. */
      const etag = res.headers.get("etag");
      const validator = (etag && !etag.startsWith("W/") ? etag : null) ?? res.headers.get("last-modified");
      const resumable = res.headers.get("accept-ranges") === "bytes" && validator;
      /* The archive as one stream, fed by the first response and any resumed ones. */
      let received = 0;
      const body = Readable.from((async function* () {
        for (let attempt = 0; ; ) {
          let stalled = false, timer = null;
          const arm = () => { clearTimeout(timer); timer = setTimeout(() => { stalled = true; stop.abort(new Error(`no data for ${stallMs / 1000} s`)); }, stallMs); };
          try {
            arm();
            /* Only the wait for the network counts: not the time the unpacking takes over a chunk (backpressure). */
            for await (const chunk of Readable.fromWeb(res.body)) { clearTimeout(timer); received += chunk.length; yield chunk; arm(); }
            clearTimeout(timer); release();
            return;
          } catch (error) {
            clearTimeout(timer); release();
            if (signal?.aborted) throw signal.reason ?? error;
            if (!resumable || ++attempt > retries) throw new Error(`${url}: ${stalled ? `stalled (no data for ${stallMs / 1000} s)` : error.message} after ${received} bytes${resumable ? `, ${retries} retries` : ", and it cannot resume (no Range)"}`);
            await new Promise((r) => setTimeout(r, retryDelayMs * attempt));
            ({ res, stop, release } = await request({ range: `bytes=${received}-`, "if-range": validator }));
            if (res.status !== 206) { release(); await res.body?.cancel(); throw new Error(`${url}: could not resume at byte ${received} (answered ${res.status})`); }
          }
        }
      })());
      await unpackZoneImage(body, into, { signal });
      return true;
    },
  };
}

/* A refused response, with the reason the server gives (a JSON { error, message } or text). */
async function refusal(url, res) {
  let detail = "";
  try { const text = (await res.text()).slice(0, 500); try { const j = JSON.parse(text); detail = j.message ?? j.error ?? text; } catch { detail = text; } } catch {}
  const error = new Error(`${url} answered ${res.status}${detail ? `: ${detail}` : ""}`);
  error.status = res.status;
  return error;
}

/**
 * Zone images from service-connector, an image gateway (hub "zones",
 * GET /api/connector/images/zones/<owner>/<zone>@<version>, every byte through the service, Range honoured). The
 * connector decides access; a refusal (401 sign_in_required, 403 plan_limit) fails the pull with its reason.
 * `token`: a string, or a function of { zone, version } resolving one (sent as a bearer token).
 */
function fromConnector({ origin, owner, hub = "zones", token, ...options }) {
  if (!origin || !owner) throw new Error("fromConnector needs { origin, owner }");
  const template = `${origin.replace(/\/$/, "")}/api/connector/images/${encodeURIComponent(hub)}/${encodeURIComponent(owner)}/{zone}@{version}`;
  return fromHttp(template, {
    ...options,
    name: `connector ${origin} ${hub}/${owner}`,
    headers: async (request) => {
      const value = typeof token === "function" ? await token(request) : token;
      return value ? { authorization: `Bearer ${value}` } : {};
    },
  });
}

module.exports = { packZoneImage, unpackZoneImage, fromDirectory, fromHttp, fromConnector };
