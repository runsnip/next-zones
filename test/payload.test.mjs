/*
 * payload.cjs: a zone's flight data made to run in the shell's document. What it writes is read back with React's own
 * flight client (Next's compiled copy), so a row whose byte length went wrong fails here as it would in a browser.
 */
import { test } from "node:test";
import assert from "node:assert/strict";
import { createRequire } from "node:module";
import { Readable } from "node:stream";

const require = createRequire(import.meta.url);
const { payloadTransform } = require("../src/zones/payload.cjs");
/* Next is a peer dependency: the copy the spikes install. */
const fromSpikes = createRequire(new URL("../spikes/zones/package.json", import.meta.url));
let createFromNodeStream = null;
try { ({ createFromNodeStream } = fromSpikes("next/dist/compiled/react-server-dom-turbopack/client.node")); } catch {}
const withReact = { skip: createFromNodeStream ? false : "Next is not installed in spikes/zones" };

const ZONE = "zoneBuildId_21chars_x";                     // Next's default: a 21-character nanoid
const SHELL = "0123456789abcdef0123456789abcdef01234567";  // a generateBuildId's git SHA: 40 characters

/** What React's flight client reads from `bytes`. */
async function read(bytes) {
  const manifest = { moduleMap: {}, serverModuleMap: null, moduleLoading: { prefix: "", crossOrigin: null } };
  return createFromNodeStream(Readable.from([bytes]), manifest);
}

/** A flight stream: a text row (long text, sent by length) and a binary row, both holding the zone's id, then the root
    row that refers to them (React's server writes a referenced row first). */
function stream(text) {
  const body = Buffer.from(text, "utf8");
  const binary = Buffer.from(`raw ${ZONE}`, "latin1");
  return Buffer.concat([
    Buffer.from(`1:T${body.length.toString(16)},`),
    body,
    Buffer.from(`2:o${binary.length.toString(16)},`),
    binary,
    Buffer.from(`0:{"b":"${ZONE}","t":"$1","u":"$2"}\n`),
  ]);
}

test("a text row's length is written again when the build ids differ in length; binary rows are untouched", withReact, async () => {
  const text = `é ${ZONE} ü `.repeat(200);
  const out = payloadTransform({ buildId: ZONE, shellBuildId: SHELL })(stream(text), "flight");
  const root = await read(out);
  assert.equal(root.b, SHELL);
  assert.equal(root.t, text.replaceAll(ZONE, SHELL));
  assert.equal(Buffer.from(root.u).toString("latin1"), `raw ${ZONE}`);
});

test("inline flight data in HTML: chunks joined, edited, put back; a split id and a split row still read", withReact, async () => {
  const text = `${ZONE} `.repeat(100);
  const flight = stream(text);
  /* Cut inside the text row's length header and inside the root row's id, as a streamed render may. */
  const cuts = [flight.indexOf(":T") + 3, flight.indexOf(`"b":"${ZONE}`) + 10, flight.length - 3];
  const chunks = [flight.subarray(0, cuts[0]), flight.subarray(cuts[0], cuts[1]), flight.subarray(cuts[1], cuts[2]), flight.subarray(cuts[2])];
  const push = (c, k) => (k < 3
    ? `<script>self.__next_f.push(${JSON.stringify([1, c.toString("utf8")]).replace(/</g, "\\u003c")})</script>`
    : `<script>self.__next_f.push(${JSON.stringify([3, c.toString("base64")])})</script>`);
  const html = `<!DOCTYPE html><html><body><p>${ZONE}</p><script>(self.__next_f=self.__next_f||[]).push([0])</script>${chunks.map(push).join("<div></div>")}</body></html>`;
  const out = payloadTransform({ buildId: ZONE, shellBuildId: SHELL })(Buffer.from(html), "html").toString("utf8");
  assert.equal(out.match(/__next_f\.push\(\[[13],/g).length, 4, "as many chunks as before");
  assert.ok(out.includes(`<p>${SHELL}</p>`));
  const joined = Buffer.concat([...out.matchAll(/self\.__next_f\.push\((\[[13],"(?:[^"\\]|\\.)*"\])\)/g)].map((m) => {
    const [type, data] = JSON.parse(m[1]);
    return type === 1 ? Buffer.from(data, "utf8") : Buffer.from(data, "base64");
  }));
  const root = await read(joined);
  assert.equal(root.b, SHELL);
  assert.equal(root.t, text.replaceAll(ZONE, SHELL));
  assert.equal(Buffer.from(root.u).toString("latin1"), `raw ${ZONE}`);
});

test("client references: the zone's main chunk first, remapped ids, chunk URLs; other rows' text alone", () => {
  const flight = Buffer.from(`1:I[12,["/_next/static/chunks/a.js"],"default"]\n2:I[7,[],"x"]\n3:["$","p",null,{"children":"I[12,["}]\n`);
  const out = payloadTransform({
    buildId: ZONE, shellBuildId: SHELL, mainChunks: ["/_next/static/chunks/main.js"], idMap: { 12: 912 },
    chunkUrls: { "/_next/static/chunks/a.js": "/_next/static/chunks/zone-a.js" },
  })(flight, "flight").toString("utf8");
  assert.equal(out, `1:I[912,["/_next/static/chunks/main.js","/_next/static/chunks/zone-a.js"],"default"]\n2:I[7,["/_next/static/chunks/main.js"],"x"]\n3:["$","p",null,{"children":"I[12,["}]\n`);
});

test("nothing to change: the same bytes", () => {
  const flight = stream("no id here");
  const html = Buffer.from(`<script>self.__next_f.push([1,"0:\\"x\\"\\n"])</script>`);
  const t = payloadTransform({ buildId: "absent_id_zzzzzzzzzzz", shellBuildId: SHELL });
  assert.ok(t(flight, "flight").equals(flight));
  assert.ok(t(html, "html").equals(html));
});
