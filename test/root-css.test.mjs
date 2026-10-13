/*
 * client-manifest.cjs rootCssBelow: the root layout's stylesheets named by the entries below it, so a soft navigation
 * between the shell and a zone (each with a root layout of its own at "") brings each one's stylesheet.
 */
import { test } from "node:test";
import assert from "node:assert/strict";
import { createRequire } from "node:module";

const require = createRequire(import.meta.url);
const { rootCssBelow, clientManifestForZone } = require("../src/zones/client-manifest.cjs");

const css = (p) => ({ path: `static/chunks/${p}.css`, inlined: false });
/* As Turbopack writes it: each entry lists its layouts' stylesheets, the root's first. */
const manifest = () => ({
  clientModules: {},
  entryCSSFiles: {
    "[project]/media/app/layout": [css("root")],
    "[project]/media/app/media/layout": [css("root")],
    "[project]/media/app/media/page": [css("root"), css("page")],
    "[project]/media/app/media/app/layout": [css("root"), css("nested")],
    "[project]/node_modules/next/dist/client/components/builtin/not-found": [],
  },
  entryJSFiles: {},
});

test("the root layout keeps no stylesheet; every other entry names the root's, first", () => {
  const out = rootCssBelow(manifest()).entryCSSFiles;
  assert.deepEqual(out["[project]/media/app/layout"], []);
  assert.deepEqual(out["[project]/media/app/media/layout"], [css("root")]);
  assert.deepEqual(out["[project]/media/app/media/page"], [css("root"), css("page")]);
  /* A route segment named "app" is not the root: the shortest …/app/layout is. */
  assert.deepEqual(out["[project]/media/app/media/app/layout"], [css("root"), css("nested")]);
  assert.deepEqual(out["[project]/node_modules/next/dist/client/components/builtin/not-found"], [css("root")]);
  /* Once moved, moved: a second pass changes nothing. */
  assert.deepEqual(rootCssBelow({ entryCSSFiles: out }).entryCSSFiles, out);
});

test("a zone's manifest made for the shell's document moves them too; one without a root stylesheet is as it was", () => {
  const zone = clientManifestForZone(manifest(), { mainChunks: ["/_next/static/chunks/zone-main.js"] });
  assert.deepEqual(zone.entryCSSFiles["[project]/media/app/layout"], []);
  assert.deepEqual(zone.entryCSSFiles["[project]/media/app/media/layout"], [css("root")]);
  const plain = { entryCSSFiles: { "[project]/app/app/layout": [], "[project]/app/app/page": [css("p")] } };
  assert.equal(rootCssBelow(plain), plain);
});

/* payload.cjs withRootCss: the same, done to a page prerendered before (its flight data and its segments). */
const { withRootCss } = require("../src/zones/payload.cjs");
const link = (href) => ["$", "link", "0", { rel: "stylesheet", href, precedence: "next", crossOrigin: "$undefined", nonce: "$undefined" }];
const script = ["$", "script", "script-0", { src: "/_next/static/chunks/a.js", async: true }];
const fullTree = () => {
  const root = ["$", "$1", "c", { children: [[link("/_next/static/chunks/root.css"), script], ["$", "html", null, { children: "$L2" }]] }];
  const layout = ["$", "$1", "c", { children: [null, ["$", "$L3", null, {}]] }];
  const tree = ["", { children: ["wide", { children: ["__PAGE__", {}] }] }];
  return Buffer.from(`1:"$Sreact.fragment"\n0:${JSON.stringify({ c: ["", "wide"], f: [[tree, [root, { children: [layout, {}, null, false] }, null, false], null, false]], b: "x" })}\n2:"tail"\n`);
};
const row0 = (buffer) => JSON.parse(buffer.toString("utf8").split("\n").find((l) => l.startsWith("0:")).slice(2));

test("a prerendered page: the segment below the root names the root's stylesheet; its segments too; the rest as it was", () => {
  const page = ["$", "$1", "c", { children: [["$", "section", null, {}], [script], "$L4"] }];
  const segments = new Map([
    ["/_tree", Buffer.from(`0:{"tree":{},"buildId":"x"}\n`)],
    ["/wide/__PAGE__", Buffer.from(`0:${JSON.stringify({ buildId: "x", data: [{ rsc: page }] })}\n`)],
  ]);
  const before = fullTree();
  const { rscData, segmentData } = withRootCss(before, segments);
  const f = row0(rscData).f[0];
  assert.deepEqual(f[1][1].children[0][3].children[0], [link("/_next/static/chunks/root.css")]);
  assert.deepEqual(f[1][0], row0(before).f[0][1][0], "the root as it was");
  assert.ok(rscData.toString().startsWith(`1:"$Sreact.fragment"\n0:`) && rscData.toString().endsWith(`\n2:"tail"\n`), "the other rows as they were");
  /* A page's own assets are its second child: the stylesheet goes first among them. */
  assert.deepEqual(row0(segmentData.get("/wide/__PAGE__")).data[0].rsc[3].children[1], [link("/_next/static/chunks/root.css"), script]);
  assert.equal(segmentData.get("/_tree"), segments.get("/_tree"));
  /* Once named, named: a second pass changes nothing. */
  assert.equal(withRootCss(rscData, null).rscData, rscData);
  /* A root sent as a row of its own is left as it is. */
  const lazy = Buffer.from(`0:{"f":"$L1"}\n`);
  assert.equal(withRootCss(lazy, null).rscData, lazy);
});

test("from Next 16.4: the tree's root names its children by a Map row; the segment there names the root's stylesheet", () => {
  const root = { s: "", h: 528, d: { r: ["$", "$1", "c", { children: [[link("/_next/static/chunks/root.css"), script], ["$", "html", null, {}]] }], p: false, v: null }, c: "$Q9" };
  const layout = { s: "wide", h: 512, d: { r: ["$", "$1", "c", { children: [null, ["$", "$L7", null, {}]] }], p: false, v: null }, c: "$Qb" };
  const stream = Buffer.from(`1:"$Sreact.fragment"\n0:${JSON.stringify({ c: ["", "wide"], t: { t: root }, b: "x" })}\n9:${JSON.stringify([["children", layout]])}\nb:[]\n`);
  const { rscData } = withRootCss(stream, null);
  const row = (id) => JSON.parse(rscData.toString("utf8").split("\n").find((l) => l.startsWith(`${id}:`)).slice(id.length + 1));
  assert.deepEqual(row("9")[0][1].d.r[3].children[0], [link("/_next/static/chunks/root.css")]);
  assert.deepEqual(row("0").t.t, root, "the root as it was");
  assert.equal(withRootCss(rscData, null).rscData, rscData);
});
