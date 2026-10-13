"use strict";
/*
 * Sends one of a zone's files (assets.cjs found it) as HTTP: the same answer behind any front proxy.
 *
 * - Precompressed siblings: a public file with a `.br` (or `.gz`) next to it is sent as that sibling, with
 *   Content-Encoding, the original's Content-Type and the sibling's own Content-Length, when the request's
 *   Accept-Encoding allows it (q-values read; no Accept-Encoding: the file as it is). A response that could have been
 *   another encoding says Vary: Accept-Encoding, the identity one included.
 * - Validators: a strong ETag per representation (the encoded one differs from the identity one) and Last-Modified;
 *   If-None-Match, else If-Modified-Since, answer 304.
 * - Ranges: a single byte range of the identity representation (206, If-Range honoured; unsatisfiable: 416). A Range
 *   request is never answered from a sibling: a range of brotli bytes is of no use to a client that asked for a part of
 *   the file, and RFC 9110 lets a server pick the representation, so the request gets the identity one, ranged. Several
 *   ranges: the whole file (a server may ignore Range).
 * - HEAD: the same headers as GET, no body.
 */
const fs = require("node:fs");

const CODINGS = [["br", ".br"], ["gzip", ".gz"]];   // preference order on equal q

/** The q-value of each coding the Accept-Encoding header names (lower-cased; "x-gzip" read as "gzip"). */
function acceptedCodings(header) {
  const q = new Map();
  for (const part of String(header ?? "").split(",")) {
    const [name, ...params] = part.split(";").map((s) => s.trim());
    if (!name) continue;
    let value = 1;
    for (const p of params) {
      const m = /^q\s*=\s*([0-9.]+)$/i.exec(p);
      if (m) value = Math.min(1, Math.max(0, Number(m[1]) || 0));
    }
    const coding = name.toLowerCase() === "x-gzip" ? "gzip" : name.toLowerCase();
    q.set(coding, Math.max(q.get(coding) ?? 0, value));
  }
  return q;
}

/** The coding to send among `available` (["br", "gzip"]) for an Accept-Encoding header, or null for identity. */
function chooseEncoding(header, available) {
  if (header === undefined || !available.length) return null;
  const q = acceptedCodings(header);
  const of = (coding) => (q.has(coding) ? q.get(coding) : q.has("*") ? q.get("*") : 0);
  /* Identity is acceptable unless excluded (RFC 9110 §12.5.3), and least preferred unless it is named with a q-value:
     "br;q=0.5" still gets brotli, "br;q=0.5, identity" the file as it is. */
  const identity = q.has("identity") ? q.get("identity") : 0;
  let best = null, bestQ = 0;
  for (const [coding] of CODINGS) {
    if (!available.includes(coding)) continue;
    const value = of(coding);
    if (value > bestQ) { best = coding; bestQ = value; }
  }
  return best && bestQ > 0 && bestQ >= identity ? best : null;
}

/** The siblings of `file` that exist, as [[coding, path]], from a set of the folder's files (URL paths) or the disk. */
function siblingsOf(file, has = (p) => fs.existsSync(p)) {
  return CODINGS.filter(([, ext]) => has(file + ext)).map(([coding, ext]) => [coding, file + ext]);
}

const etagOf = (stat, coding) => `"${stat.size.toString(36)}-${Math.floor(stat.mtimeMs).toString(36)}${coding ? `-${coding}` : ""}"`;
const opaque = (tag) => tag.trim().replace(/^W\//, "");

function notModified(req, etag, mtime) {
  const inm = req.headers["if-none-match"];
  if (inm !== undefined) {
    if (inm.trim() === "*") return true;
    return inm.split(",").some((t) => opaque(t) === etag);          // weak comparison
  }
  const ims = Date.parse(req.headers["if-modified-since"] ?? "");
  return Number.isFinite(ims) && Math.floor(mtime / 1000) * 1000 <= ims;
}

/** The single range of a Range header over `size` bytes: { start, end }, "unsatisfiable", or null (ignore it). */
function parseRange(header, size) {
  const m = /^bytes=\s*([^,]*)$/i.exec(String(header).trim());
  if (!m) return null;                                                 // not bytes, or several ranges: the whole file
  const r = /^(\d*)\s*-\s*(\d*)$/.exec(m[1].trim());
  if (!r || (r[1] === "" && r[2] === "")) return null;
  if (r[1] === "") {                                                   // the last n bytes
    const n = Number(r[2]);
    if (n === 0 || size === 0) return "unsatisfiable";
    return { start: Math.max(0, size - n), end: size - 1 };
  }
  const start = Number(r[1]);
  const end = r[2] === "" ? size - 1 : Math.min(Number(r[2]), size - 1);
  if (r[2] !== "" && Number(r[2]) < start) return null;               // invalid: ignored
  if (start >= size) return "unsatisfiable";
  return { start, end };
}

function ifRangeHolds(req, etag, lastModified) {
  const value = req.headers["if-range"];
  if (value === undefined) return true;
  const v = value.trim();
  if (v.startsWith('"') || v.startsWith("W/")) return v === etag;      // strong comparison only
  return v === lastModified;
}

/**
 * Answers a GET or HEAD for `asset` ({ file, contentType, cacheControl, encodings? }): `encodings` lists the
 * precompressed siblings that exist, [[coding, path]]. Resolves once the response is sent (or failed).
 */
async function sendAsset(req, res, asset) {
  const ranged = req.headers.range !== undefined;
  const available = asset.encodings ?? [];
  let coding = ranged ? null : chooseEncoding(req.headers["accept-encoding"], available.map(([c]) => c));
  let file = coding ? available.find(([c]) => c === coding)[1] : asset.file;
  let stat;
  try { stat = await fs.promises.stat(file); } catch { stat = null; }
  if (!stat && coding) { coding = null; file = asset.file; try { stat = await fs.promises.stat(file); } catch { stat = null; } }
  if (!stat?.isFile()) { res.writeHead(404, { "content-type": "text/plain" }); res.end("Not Found"); return; }
  const etag = etagOf(stat, coding);
  const lastModified = new Date(Math.floor(stat.mtimeMs / 1000) * 1000).toUTCString();
  const headers = { "cache-control": asset.cacheControl, etag, "last-modified": lastModified };
  if (available.length) headers.vary = "Accept-Encoding";
  if (notModified(req, etag, stat.mtimeMs)) { res.writeHead(304, headers); res.end(); return; }
  headers["content-type"] = asset.contentType;
  if (coding) headers["content-encoding"] = coding;
  else headers["accept-ranges"] = "bytes";
  let status = 200, start = 0, end = stat.size - 1;
  if (ranged && !coding && ifRangeHolds(req, etag, lastModified)) {
    const range = parseRange(req.headers.range, stat.size);
    if (range === "unsatisfiable") {
      res.writeHead(416, { ...headers, "content-range": `bytes */${stat.size}`, "content-length": 0 });
      res.end();
      return;
    }
    if (range) { status = 206; ({ start, end } = range); headers["content-range"] = `bytes ${start}-${end}/${stat.size}`; }
  }
  headers["content-length"] = stat.size === 0 ? 0 : end - start + 1;
  res.writeHead(status, headers);
  if (req.method === "HEAD" || stat.size === 0) { res.end(); return; }
  await new Promise((resolve) => {
    const stream = fs.createReadStream(file, { start, end });
    stream.on("error", () => { res.destroy(); resolve(); });
    res.on("close", resolve);
    stream.pipe(res);
  });
}

/* A query parameter's value that looks like a content hash: hex of 8 or more characters, or base64url of 16 or more
   (a sha's prefix, a digest); a version such as "1.2.3" does not. */
const HASH_VALUE = /^(?:[0-9a-fA-F]{8,128}|[A-Za-z0-9_-]{16,128})$/;
const DEFAULT_HASH_QUERY = ["h", "v"];

/** Whether a URL's query names its file by content: one of `names` with a hash-shaped value. */
function contentAddressed(searchParams, names = DEFAULT_HASH_QUERY) {
  if (!searchParams || !names?.length) return false;
  return names.some((name) => searchParams.getAll(name).some((value) => HASH_VALUE.test(value)));
}

module.exports = { sendAsset, chooseEncoding, siblingsOf, parseRange, contentAddressed, DEFAULT_HASH_QUERY, HASH_VALUE };
