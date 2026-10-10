#!/usr/bin/env node
/*
 * The upgrade guard: runs every Zones check against a given Next version, before that version is allowed.
 *
 *   node tools/upgrade-guard.mjs <next version> [check …] [--react <version>] [--keep]
 *
 * It copies spikes/zones to a temporary folder (no node_modules, builds, stores or caches), sets Next (and React, if
 * given), installs, builds the shells, the fixtures and the zone images, and runs check-all.mjs.
 * Zones runs only on the Next versions in src/zones/next-contract.cjs SUPPORTED; the guard lets it run on the one
 * being checked. Zones still refuses a Next whose internals it does not recognise (a hooked module moved, a function
 * gone, an unknown Turbopack runtime layout), so a check either passes or says what moved. Once every check passes,
 * add the version to SUPPORTED. --keep leaves the folder for a closer look; checks named after the version run alone
 * (all by default).
 */
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { execFileSync } from "node:child_process";
import { fileURLToPath } from "node:url";

const args = process.argv.slice(2);
const opt = (name) => { const i = args.indexOf(`--${name}`); return i >= 0 ? args.splice(i, i + 1 < args.length && !args[i + 1].startsWith("--") ? 2 : 1)[1] ?? true : undefined; };
const keep = opt("keep");
const react = opt("react");
const [nextVersion, ...checks] = args;
if (!nextVersion) { console.error("usage: upgrade-guard.mjs <next version> [check …] [--react <version>] [--keep]"); process.exit(2); }

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const spike = path.join(root, "spikes", "zones");
const work = fs.mkdtempSync(path.join(os.tmpdir(), `next-zones-guard-${nextVersion}-`));
const skip = /[\\/](node_modules|\.next|\.zones-store[^\\/]*|\.zones-cache|[^\\/]+@\d+|package-lock\.json)$|\.log$/;
fs.cpSync(spike, work, { recursive: true, filter: (src) => !skip.test(src) });

/* The spike's Zones requires the package's src by a relative path: point it at this repository's. */
/* The checks reach the package by "../../" (src/, tools/, package.json): in the copy, that is the package's absolute path. */
for (const file of fs.readdirSync(work).filter((f) => /\.(mjs|cjs|sh)$/.test(f))) {
  const text = fs.readFileSync(path.join(work, file), "utf8");
  const fixed = text.replaceAll("../../src/", `${root}/src/`).replaceAll("../../dist/", `${root}/dist/`).replaceAll("../../tools/", `${root}/tools/`).replaceAll("../../package.json", `${root}/package.json`).replaceAll("../../skills", `${root}/skills`);
  if (fixed !== text) fs.writeFileSync(path.join(work, file), fixed);
  /* Any other way back to the package would reach nothing from the copy: refuse before building, not after. */
  const left = fixed.split("\n").map((line, i) => [i + 1, line]).filter(([, line]) => /\.\.\/\.\.\/|"\.\.",\s*"\.\."/.test(line));
  if (left.length) { console.error(`${file}: reaches the package by a path the guard does not rewrite (use "../../src/", "../../dist/", "../../tools/", "../../skills" or "../../package.json"):\n${left.map(([n, l]) => `  ${n}: ${l.trim()}`).join("\n")}`); fs.rmSync(work, { recursive: true, force: true }); process.exit(1); }
}
const pkgFile = path.join(work, "package.json");
const pkg = JSON.parse(fs.readFileSync(pkgFile, "utf8"));
/* @runsnip/jwks, next-zones' dependency: the checkout next-zones resolves it from (a link to the package's folder in
   the monorepo), else the registry's. */
let jwks = pkg.dependencies["@runsnip/jwks"];
try {
  const { createRequire } = await import("node:module");
  const dir = path.dirname(fs.realpathSync(createRequire(path.join(root, "package.json")).resolve("@runsnip/jwks/package.json")));
  jwks = dir.includes(`${path.sep}node_modules${path.sep}`) ? "^0.1.0" : `file:${dir}`;
} catch { jwks = "^0.1.0"; }
pkg.dependencies = { ...pkg.dependencies, next: nextVersion, "@runsnip/next-zones": `file:${root}`, "@runsnip/jwks": jwks, "@spike/ext": `file:${path.join(root, "spikes", "ext-package")}` };
if (react) Object.assign(pkg.dependencies, { react, "react-dom": react });
fs.writeFileSync(pkgFile, JSON.stringify(pkg, null, 2));

const run = (cmd, argv, cwd = work) => execFileSync(cmd, argv, { cwd, stdio: ["ignore", "pipe", "pipe"], encoding: "utf8", maxBuffer: 64 << 20 });
const runWith = (cmd, argv, cwd, env) => execFileSync(cmd, argv, { cwd, env, stdio: ["ignore", "pipe", "pipe"], encoding: "utf8", maxBuffer: 64 << 20 });
const step = (label, fn) => {
  const s = Date.now();
  try { fn(); console.log(`✓ ${label} (${((Date.now() - s) / 1000).toFixed(0)} s)`); }
  catch (error) { console.log(`✗ ${label}\n${String(error.stdout ?? "").slice(-1500)}${String(error.stderr ?? "").slice(-1500)}`); finish(1); }
};
function finish(code) {
  if (!keep) fs.rmSync(work, { recursive: true, force: true });
  else console.log(`kept: ${work}`);
  process.exit(code);
}

console.log(`next-zones upgrade guard — Next ${nextVersion}${react ? `, React ${react}` : ""}, Node ${process.version}, ${os.cpus()[0]?.model ?? ""}`);
const npm = path.join(path.dirname(process.execPath), "npm");
/* The package's peer range names the Next versions already checked; the one being checked is not among them yet:
   --force accepts that conflict and still installs every peer (--legacy-peer-deps would leave peers out, and
   typescript-eslint would then find the spike's TypeScript 7, which it does not support). */
step("install", () => run(npm, ["install", "--no-audit", "--no-fund", "--force"]));
const nextBin = path.join(work, "node_modules", ".bin", "next");
const installed = JSON.parse(fs.readFileSync(path.join(work, "node_modules", "next", "package.json"), "utf8")).version;
console.log(`  next ${installed} installed`);
/* The shells are built for Zones (NEXT_ZONES_BUILD: zoneConfig fills in the build options Zones needs). */
const forZones = { ...process.env, NEXT_ZONES_BUILD: "zones" };
step("build the shell", () => runWith(nextBin, ["build"], path.join(work, "shell"), forZones));
step("build the Cache Components shell", () => runWith(nextBin, ["build"], path.join(work, "fixtures-cc", "shell"), forZones));
const build = (dir, zone, version, store) => run(process.execPath, [path.join(root, "tools", "build-zone.mjs"), dir, zone, version, "--store", store]);
step("build the zone images", () => {
  build("fixtures", "blog", "1", ".zones-store"); build("fixtures", "blog", "2", ".zones-store"); build("fixtures", "shop", "1", ".zones-store"); build("fixtures", "shop", "2", ".zones-store"); build("fixtures", "wide", "1", ".zones-store");
  build("fixtures", "docs", "1", ".zones-store"); build("fixtures", "docs", "2", ".zones-store"); build("fixtures", "wiki", "1", ".zones-store");
  build("fixtures-cc", "notes", "1", ".zones-store-cc");
});
let report = "";
/* Zones refuses a Next not yet in next-contract.cjs SUPPORTED: the guard is what admits it. */
process.env.NEXT_ZONES_UNSUPPORTED_NEXT = "1";
try { report = run(process.execPath, ["check-all.mjs", ...checks]); } catch (error) { report = `${error.stdout ?? ""}${error.stderr ?? ""}`; }
console.log(report.trim());
finish(/all \d+ passed/.test(report) ? 0 : 1);
