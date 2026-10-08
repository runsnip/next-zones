"use strict";
/*
 * A zone's prerendered payloads (HTML with inline flight data, RSC), made to run in the shell's document: what Zones
 * does to a zone image's prerendered pages when it seeds its cache (zone-seed.cjs), and what the links do to a zone's
 * pages (../link.mjs, ../link-app.mjs).
 * - The shell's build id in place of the zone's: the client router loads a page of another build id as a new document.
 * - The zone's main chunk first in every client reference: the shell's document never loads the zone's own main chunks.
 * - Remapped module ids in client references, and chunks written again under new URLs (zone-client.cjs).
 *
 * Flight data is edited row by row, as React's flight client reads it: a row is `<hex id>:` then either a tag whose
 * rows carry a byte length (`T<hex length>,<text>`, or binary data: typed arrays, buffers) or a line ending in "\n".
 * Lines and text rows are edited, and a text row's length is written again; binary rows are passed through untouched.
 * So the two build ids need not be the same length (a generateBuildId may return anything).
 * In HTML, the flight data is inline: Next writes each chunk of the stream as `self.__next_f.push([1,"<text>"])`, or
 * `[3,"<base64>"]` for bytes that are not UTF-8 (use-flight-response.js). The chunks are joined into the one stream the
 * client reads, edited, and each edit put back into the chunk it starts in; the chunks no edit touches stay as they were.
 */

/* Row tags whose rows carry a byte length (React's flight client, processBinaryChunk). "T" is text; the others binary. */
const LENGTH_TAGS = new Set([..."TAOobUSsLlGgMmV"].map((c) => c.charCodeAt(0)));
const T = 0x54, COLON = 0x3a, COMMA = 0x2c, NEWLINE = 0x0a;

/**
 * The edits to a flight stream (a Buffer): [{ start, end, bytes }], in order, each replacing [start, end).
 * `editLine(text)` and `editText(text)` return the row's new text (lines include their tag; text rows their content).
 * `needles`: the strings an edit replaces. A row is decoded only when one of them is in it, or when it is a line
 * `editLine` always looks at (`always(tag, next)`, on its first two bytes); the rest are never turned into strings.
 */
function flightEdits(stream, { editLine, editText, needles = null, always = () => true }) {
  const edits = [];
  /* Where each needle starts in the stream, in order; `hit(start, end)`: one starts in the row. */
  const hits = needles ? needles.filter(Boolean).flatMap((n) => {
    const at = [], bytes = Buffer.from(n, "utf8");
    for (let k = stream.indexOf(bytes); k >= 0; k = stream.indexOf(bytes, k + 1)) at.push(k);
    return at;
  }).sort((a, b) => a - b) : null;
  let h = 0;
  const hit = (start, end) => {
    if (!hits) return true;
    while (h < hits.length && hits[h] < start) h++;
    return h < hits.length && hits[h] < end;
  };
  let i = 0;
  while (i < stream.length) {
    const colon = stream.indexOf(COLON, i);
    if (colon < 0) break;                                   // an incomplete row: left as it is
    const tag = stream[colon + 1];
    if (LENGTH_TAGS.has(tag)) {
      const comma = stream.indexOf(COMMA, colon + 2);
      if (comma < 0) break;
      const length = parseInt(stream.toString("latin1", colon + 2, comma), 16);
      const end = comma + 1 + length;
      if (tag === T && hit(comma + 1, end)) {
        const text = stream.toString("utf8", comma + 1, end);
        const edited = editText(text);
        if (edited !== text) {
          const body = Buffer.from(edited, "utf8");
          edits.push({ start: i, end, bytes: Buffer.concat([stream.subarray(i, colon + 2), Buffer.from(`${body.length.toString(16)},`, "latin1"), body]) });
        }
      }
      i = end;
      continue;
    }
    const newline = stream.indexOf(NEWLINE, colon + 1);
    const end = newline < 0 ? stream.length : newline;
    if (always(stream[colon + 1], stream[colon + 2]) || hit(colon + 1, end)) {
      const line = stream.toString("utf8", colon + 1, end);
      const edited = editLine(line);
      if (edited !== line) edits.push({ start: colon + 1, end, bytes: Buffer.from(edited, "utf8") });
    }
    i = newline < 0 ? stream.length : newline + 1;
  }
  return edits;
}

/** Applies `edits` to a stream cut in `chunks` (Buffers, joined in order): each edit goes in the chunk it starts in. */
function applyEdits(chunks, edits) {
  const starts = [];
  let total = 0;
  for (const c of chunks) { starts.push(total); total += c.length; }
  /* The chunk a position is in (the last one, for the end of the stream). */
  const chunkOf = (pos) => { let k = chunks.length - 1; while (k > 0 && (starts[k] > pos || (pos === starts[k] + chunks[k].length && pos < total))) k--; return k; };
  const out = chunks.map(() => []);
  const changed = chunks.map(() => false);
  const copy = (from, to) => {
    for (let k = 0; k < chunks.length; k++) {
      const a = Math.max(from, starts[k]), b = Math.min(to, starts[k] + chunks[k].length);
      if (a < b) out[k].push(chunks[k].subarray(a - starts[k], b - starts[k]));
    }
  };
  let pos = 0;
  for (const edit of edits) {
    copy(pos, edit.start);
    const first = chunkOf(edit.start);
    out[first].push(edit.bytes);
    for (let k = first; k < chunks.length && starts[k] < Math.max(edit.end, edit.start + 1); k++) changed[k] = true;
    pos = edit.end;
  }
  copy(pos, total);
  return chunks.map((c, k) => (changed[k] ? Buffer.concat(out[k]) : c));
}

/* An inline flight chunk: `self.__next_f.push([1,"…"])` or `[3,"…"]`. Inside the string `<` is escaped and `"` too,
   so the first `"])</script>` after it ends it. Found with indexOf on the page's bytes, never a regular expression. */
const OPEN = Buffer.from("self.__next_f.push(["), CLOSE = Buffer.from('"])</script>');
const ESCAPES = { "&": "\\u0026", ">": "\\u003e", "<": "\\u003c", "\u2028": "\\u2028", "\u2029": "\\u2029" };
const htmlEscapeJson = (json) => json.replace(/[&><\u2028\u2029]/g, (c) => ESCAPES[c]);
function inlineChunks(page) {
  const found = [];
  for (let k = page.indexOf(OPEN); k >= 0; k = page.indexOf(OPEN, k + 1)) {
    const type = page[k + OPEN.length], quote = k + OPEN.length + 2;
    if ((type !== 0x31 && type !== 0x33) || page[k + OPEN.length + 1] !== COMMA || page[quote] !== 0x22) continue;
    const close = page.indexOf(CLOSE, quote + 1);
    if (close < 0) break;
    const data = JSON.parse(page.toString("utf8", quote, close + 1));
    found.push({ start: k, end: close + CLOSE.length, type: type - 0x30, bytes: type === 0x31 ? Buffer.from(data, "utf8") : Buffer.from(data, "base64") });
    k = close;
  }
  return found;
}

function payloadTransform({ buildId, shellBuildId, mainChunks = [], idMap = {}, chunkUrls = {} }) {
  const raw = mainChunks.map((c) => `"${c}"`).join(",");
  const remapped = Object.keys(idMap).length > 0;
  const urls = Object.entries(chunkUrls);
  const plain = (text) => {
    let next = text.replaceAll(buildId, shellBuildId);
    for (const [from, to] of urls) next = next.replaceAll(from, to);
    return next;
  };
  /* A client reference row: `I[<id>,[<chunks>],…]`. */
  const editLine = (line) => {
    let next = plain(line);
    if (!next.startsWith("I[")) return next;
    if (mainChunks.length) next = next.replace(/^I\[(\d+),\[(\]|")/, (all, id, after) => `I[${id},[${raw}${after === "]" ? "]" : ',"'}`);
    if (remapped) next = next.replace(/^I\[(\d+),/, (all, id) => (idMap[id] !== undefined ? `I[${idMap[id]},` : all));
    return next;
  };
  /* Only client reference rows (`I[`) are looked at whatever they hold, and only when they have something to change. */
  const I = 0x49, BRACKET = 0x5b;
  const edit = { editLine, editText: plain, needles: [buildId, ...urls.map(([from]) => from)], always: (tag, next) => (mainChunks.length > 0 || remapped) && tag === I && next === BRACKET };
  const flight = (stream) => applyEdits([stream], flightEdits(stream, edit))[0];
  /* The page outside its flight data: decoded only when something in it changes. */
  const needleBytes = [buildId, ...urls.map(([from]) => from)].filter(Boolean).map((n) => Buffer.from(n, "utf8"));
  const plainBytes = (bytes) => (needleBytes.some((n) => bytes.indexOf(n) >= 0) ? Buffer.from(plain(bytes.toString("utf8")), "utf8") : bytes);
  const html = (page) => {
    const found = inlineChunks(page);
    const chunks = found.map((f) => f.bytes);
    const edited = applyEdits(chunks, flightEdits(Buffer.concat(chunks), edit));
    const out = [];
    let last = 0;
    found.forEach((f, k) => {
      out.push(plainBytes(page.subarray(last, f.start)));
      if (edited[k] === chunks[k]) out.push(page.subarray(f.start, f.end));
      else out.push(Buffer.from(`self.__next_f.push(${htmlEscapeJson(JSON.stringify(f.type === 1 ? [1, edited[k].toString("utf8")] : [3, edited[k].toString("base64")]))})</script>`, "utf8"));
      last = f.end;
    });
    out.push(plainBytes(page.subarray(last)));
    return Buffer.concat(out);
  };
  /* `kind`: "html" (a page with inline flight data), "flight" (an RSC payload, an exported .txt), or "plain". */
  return function transform(bytes, kind) {
    if (kind === "html") return html(bytes);
    if (kind === "flight") return flight(bytes);
    return Buffer.from(plain(bytes.toString("utf8")), "utf8");
  };
}

/** The kind of a prerendered or exported file, for transform(): flight data, a page, or neither. */
const payloadKind = (file) => (/\.html$/.test(file) ? "html" : /\.(rsc|txt)$/.test(file) ? "flight" : "plain");

module.exports = { payloadTransform, payloadKind, flightEdits, applyEdits };
