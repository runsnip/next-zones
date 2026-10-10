/*
 * Next's output: "standalone", in mode "zones". Next makes a standalone folder of an app: its server.js, its .next and
 * the node_modules files its server traces need, nothing else. For a workspace of zones:
 *
 * - A zone image whose Next config says output: "standalone" carries the packages its server traces need
 *   (copyTracedPackages): so it runs where the workspace's node_modules is not. Next and React are the shell's: Zones
 *   resolves a zone's packages from the shell first, then from the image's own (zones/resolve.cjs).
 * - A shell whose Next config says output: "standalone" becomes the deploy (prepareStandaloneZones): its standalone
 *   folder gets what Next's docs say a deploy must copy in (.next/static, public/), next-zones itself, the shell's
 *   zone declaration (there is no next.config in a standalone folder), the images built and the pins, and zones.js,
 *   which starts Zones the way Next's server.js starts Next (the config the build recorded, no next.config).
 *   The folder alone is the deploy: copied anywhere, `node zones.js` serves every zone.
 */
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { createRequire } from "node:module";

const PACKAGE_DIR = path.resolve(fileURLToPath(new URL("..", import.meta.url)));
/* The folder this code runs from: dist/ in the published package (src/ in the repository), the package's exports'
   target. */
const CODE_DIR = path.dirname(fileURLToPath(import.meta.url));
/* Packages a zone never carries: the shell's single copy serves every zone. */
const SHELL_ONLY = /^(next|react|react-dom|scheduler|styled-jsx|@next\/[^/]+|@swc\/helpers|@runsnip\/next-zones)$/;

/** The package a node_modules path belongs to ("react", "@scope/name"), from what follows "node_modules/". */
const packageOf = (rest) => (rest.startsWith("@") ? rest.split("/").slice(0, 2).join("/") : rest.split("/")[0]);

/**
 * Copies into <image>/node_modules the files of the packages the image's server traces need (Next's .nft.json files,
 * read in `dotNext`, the build's own .next), the shell's own packages aside. Returns the packages copied.
 */
export function copyTracedPackages(dotNext, image) {
  const packages = new Set();
  const traces = [];
  const walk = (dir) => {
    for (const entry of fs.readdirSync(dir, { withFileTypes: true })) {
      const file = path.join(dir, entry.name);
      if (entry.isDirectory()) walk(file);
      else if (entry.name.endsWith(".nft.json")) traces.push(file);
    }
  };
  walk(path.join(dotNext, "server"));
  const copied = new Set();
  for (const trace of traces) {
    for (const entry of JSON.parse(fs.readFileSync(trace, "utf8")).files ?? []) {
      let real;
      try { real = fs.realpathSync(path.resolve(path.dirname(trace), entry)); } catch { continue; }
      const parts = real.split(path.sep);
      const first = parts.indexOf("node_modules");
      if (first < 0) continue;
      const rest = parts.slice(first + 1).join("/");
      if (SHELL_ONLY.test(packageOf(rest)) || copied.has(rest) || !fs.statSync(real).isFile()) continue;
      copied.add(rest);
      packages.add(packageOf(rest));
      const target = path.join(image, "node_modules", ...rest.split("/"));
      fs.mkdirSync(path.dirname(target), { recursive: true });
      fs.copyFileSync(real, target);
    }
  }
  return [...packages].sort();
}

/** Whether a build (its .next) was made with Next's output: "standalone". */
export function isStandalone(dotNext) {
  try { return JSON.parse(fs.readFileSync(path.join(dotNext, "required-server-files.json"), "utf8")).config.output === "standalone"; } catch { return false; }
}

/** The folder a standalone build's server.js is in. */
export function standaloneServerDir(appDir) {
  const { config, appDir: builtDir } = JSON.parse(fs.readFileSync(path.join(appDir, ".next", "required-server-files.json"), "utf8"));
  return path.join(appDir, ".next", "standalone", path.relative(config.outputFileTracingRoot ?? appDir, builtDir ?? appDir));
}

/**
 * Makes the shell's standalone folder the deploy of Zones (see above). `declaration` is the shell's zone declaration;
 * `store` and `pins` what next-zones build made. Returns { dir, entry } (entry: zones.js).
 */
export async function prepareStandaloneZones({ shellDir, declaration, store, pins, policy }) {
  const dir = standaloneServerDir(shellDir);
  const root = path.join(shellDir, ".next", "standalone");
  /* What Next leaves to the deploy. */
  fs.cpSync(path.join(shellDir, ".next", "static"), path.join(dir, ".next", "static"), { recursive: true });
  if (fs.existsSync(path.join(shellDir, "public"))) fs.cpSync(path.join(shellDir, "public"), path.join(dir, "public"), { recursive: true, dereference: true });
  /* next-zones, which the shell's server trace does not reach (the shell imports its client only). */
  const own = path.join(root, "node_modules", "@runsnip", "next-zones");
  fs.rmSync(own, { recursive: true, force: true });
  for (const entry of ["package.json", "tsconfig", "skills", "LICENSE", "NOTICE"]) {
    if (fs.existsSync(path.join(PACKAGE_DIR, entry))) fs.cpSync(path.join(PACKAGE_DIR, entry), path.join(own, entry), { recursive: true });
  }
  /* Its code, where its package.json's exports point (dist/), whichever folder it runs from. */
  fs.cpSync(CODE_DIR, path.join(own, "dist"), { recursive: true });
  /* Its optional peer, @runsnip/jwks, beside it when installed (Zones' MCP server checks OAuth tokens with it). */
  let jwksDir = null;
  try { jwksDir = path.dirname(fs.realpathSync(createRequire(path.join(PACKAGE_DIR, "package.json")).resolve("@runsnip/jwks/package.json"))); } catch {}
  if (jwksDir) {
    const jwks = path.join(root, "node_modules", "@runsnip", "jwks");
    fs.rmSync(jwks, { recursive: true, force: true });
    for (const entry of ["package.json", "dist", "LICENSE"]) if (fs.existsSync(path.join(jwksDir, entry))) fs.cpSync(path.join(jwksDir, entry), path.join(jwks, entry), { recursive: true });
  }
  /* What Zones' server needs that the shell's own trace did not reach (Next's modules it hooks or calls, its workers'),
     traced the way Next traces server.js (Next's own @vercel/nft) and copied in where missing. */
  await traceZonesRuntime({ shellDir, root });
  /* The shell's declaration, which Zones reads from next.config elsewhere. An MCP server's (Mcp(…)) holds code (its
     tools' handlers, a Bearer's verify), which no record keeps: the shell's next.config is copied in, with what it
     imports (traced as above), and Zones reads the MCP server from it; its skill folders are copied too. */
  const recorded = { ...declaration };
  if (declaration?.mcp) {
    const config = ["next.config.mjs", "next.config.js", "next.config.ts", "next.config.mts"].map((f) => path.join(shellDir, f)).find((f) => fs.existsSync(f));
    fs.copyFileSync(config, path.join(dir, path.basename(config)));
    await traceInto({ shellDir, root, entries: [fs.realpathSync(config)] });
    for (const skill of declaration.mcp.skills ?? []) {
      if (!skill.dir || skill.dir.startsWith("file:") || path.isAbsolute(skill.dir)) continue;
      fs.cpSync(path.resolve(shellDir, skill.dir), path.resolve(dir, skill.dir), { recursive: true, dereference: true });
    }
    recorded.mcp = { fromConfig: path.basename(config) };
  }
  fs.writeFileSync(path.join(dir, ".next", "zones-shell.json"), JSON.stringify(recorded, null, 2) + "\n");
  /* The images built and the pins: the folder is the whole deploy. */
  if (store && fs.existsSync(store)) {
    fs.cpSync(store, path.join(dir, ".zones-store"), { recursive: true, verbatimSymlinks: true });
    /* The packages the images' server code leaves external, with what they import (bringZoneExternals). */
    const images = [];
    for (const zone of fs.readdirSync(path.join(dir, ".zones-store"), { withFileTypes: true })) {
      if (!zone.isDirectory()) continue;
      for (const version of fs.readdirSync(path.join(dir, ".zones-store", zone.name), { withFileTypes: true })) if (version.isDirectory()) images.push(path.join(dir, ".zones-store", zone.name, version.name));
    }
    await bringZoneExternals({ shellDir, root, homes: images });
  }
  if (pins && fs.existsSync(pins)) fs.copyFileSync(pins, path.join(dir, "zones.json"));
  if (policy && fs.existsSync(policy)) fs.copyFileSync(policy, path.join(dir, "zones.config.json"));
  const entry = path.join(dir, "zones.js");
  fs.writeFileSync(entry, ZONES_ENTRY);
  return { dir, entry };
}

/**
 * Traces `entries` (absolute files) the way Next traces server.js (Next's own @vercel/nft, from the shell's tracing
 * root) and copies into the standalone folder `root` (which mirrors that root) every traced file it lacks. Files outside
 * the tracing root are left out (next-zones itself is copied whole beside it).
 */
export async function traceInto({ shellDir, root, entries }) {
  const { createRequire } = await import("node:module");
  const fromShell = createRequire(path.join(shellDir, "package.json"));
  const { config } = JSON.parse(fs.readFileSync(path.join(shellDir, ".next", "required-server-files.json"), "utf8"));
  const base = fs.realpathSync(config.outputFileTracingRoot ?? shellDir);
  const { nodeFileTrace } = fromShell("next/dist/compiled/@vercel/nft");
  const { fileList } = await nodeFileTrace(entries, { base, processCwd: shellDir });
  let copied = 0;
  for (const rel of fileList) {
    if (rel.startsWith("..")) continue;
    const from = path.join(base, rel), to = path.join(root, rel);
    if (fs.existsSync(to) || !fs.existsSync(from) || !fs.statSync(from).isFile()) continue;
    fs.mkdirSync(path.dirname(to), { recursive: true });
    fs.copyFileSync(from, to);
    copied++;
  }
  return copied;
}

/**
 * A zone's server externals in a standalone folder. Turbopack's server code names a package it leaves external
 * "<package>-<hash>" (a link in the build's node_modules) and loads it with its runtime's own require, which no tracer
 * follows: the shell's trace never brings them. Each one a zone image's server code loads is traced into the standalone
 * folder, and the image's link made to point at the copy there, so the folder holds everything and one copy of each
 * package (react among them).
 */
export async function bringZoneExternals({ shellDir, root, homes }) {
  const { createRequire } = await import("node:module");
  const fromShell = createRequire(path.join(shellDir, "package.json"));
  const HASHED = /["']((?:@[^/"']+\/)?[^/@"']+)-[0-9a-f]{16}((?:\/[^"']*)?)["']/g;
  const entries = new Set(), names = new Set();
  const scan = (dir) => {
    for (const e of fs.readdirSync(dir, { withFileTypes: true })) {
      const f = path.join(dir, e.name);
      if (e.isDirectory()) { if (e.name !== "node_modules") scan(f); continue; }
      if (!e.name.endsWith(".js")) continue;
      for (const [, name, sub] of fs.readFileSync(f, "utf8").matchAll(HASHED)) {
        names.add(name);
        try { entries.add(fs.realpathSync(fromShell.resolve(`${name}${sub}`))); } catch {}
      }
    }
  };
  for (const home of homes) if (fs.existsSync(path.join(home, "server"))) scan(path.join(home, "server"));
  if (entries.size) await traceInto({ shellDir, root, entries: [...entries] });
  /* Each package's package.json, which a package need not export: Node reads its exports to resolve a subpath. */
  for (const name of names) {
    let dir = null;
    for (const entry of entries) {
      for (let d = path.dirname(entry); d !== path.dirname(d); d = path.dirname(d)) {
        const file = path.join(d, "package.json");
        if (fs.existsSync(file)) { try { if (JSON.parse(fs.readFileSync(file, "utf8")).name === name) dir = d; } catch {} break; }
      }
      if (dir) break;
    }
    const to = path.join(root, "node_modules", name, "package.json");
    if (dir && !fs.existsSync(to)) { fs.mkdirSync(path.dirname(to), { recursive: true }); fs.copyFileSync(path.join(dir, "package.json"), to); }
  }
  /* The images' links, to the copies in the folder. */
  for (const home of homes) {
    const modules = path.join(home, "node_modules");
    if (!fs.existsSync(modules)) continue;
    const relink = (entry) => {
      const named = /^((?:@[^/]+\/)?[^/@]+)-[0-9a-f]{16}$/.exec(entry)?.[1];
      const target = named && path.join(root, "node_modules", named);
      if (!target || !fs.existsSync(target)) return;
      const at = path.join(modules, entry);
      fs.rmSync(at, { recursive: true, force: true });
      fs.symlinkSync(path.relative(path.dirname(at), target), at);
    };
    for (const entry of fs.readdirSync(modules)) {
      if (entry.startsWith("@")) for (const inner of fs.readdirSync(path.join(modules, entry))) relink(`${entry}/${inner}`);
      else relink(entry);
    }
  }
  return [...names];
}

/** What Zones' server needs: its own code and the modules of Next it uses (next-contract.cjs MODULES, requireNext calls). */
async function traceZonesRuntime({ shellDir, root }) {
  const { createRequire } = await import("node:module");
  const fromShell = createRequire(path.join(shellDir, "package.json"));
  const { MODULES } = createRequire(import.meta.url)("./zones/next-contract.cjs");
  const nextFiles = ["next", "next/package.json", "next/dist/lib/interop-default", ...Object.values(MODULES).map(([file]) => file)]
    .map((id) => { try { return fs.realpathSync(fromShell.resolve(id)); } catch { return null; } }).filter(Boolean);
  const own = [];
  const walk = (dir) => { for (const e of fs.readdirSync(dir, { withFileTypes: true })) { const f = path.join(dir, e.name); if (e.isDirectory()) walk(f); else if (/\.(c|m)?js$/.test(e.name)) own.push(f); } };
  walk(CODE_DIR);
  return traceInto({ shellDir, root, entries: [...own, ...nextFiles] });
}

/* zones.js: Zones started the way Next's standalone server.js starts Next, from the config the build recorded. */
const ZONES_ENTRY = `/* Written by next-zones build: Zones for this standalone folder, as server.js is Next's. Environment: PORT,
   HOSTNAME, NEXT_ZONES_STORE (default ./.zones-store), NEXT_ZONES_CACHE, NEXT_ZONES_ADMIN_TOKEN, NEXT_ZONES_SOURCES (a
   comma-separated list of folders or http(s) templates with {zone} and {version}), NEXT_ZONES_CONNECTOR with
   NEXT_ZONES_CONNECTOR_OWNER and NEXT_ZONES_CONNECTOR_TOKEN (service-connector as one more source). */
const fs = require("node:fs");
const path = require("node:path");

process.env.NODE_ENV = "production";
process.chdir(__dirname);
const { config } = JSON.parse(fs.readFileSync(path.join(__dirname, ".next", "required-server-files.json"), "utf8"));
process.env.__NEXT_PRIVATE_STANDALONE_CONFIG = JSON.stringify(config);

const { createZones } = require("@runsnip/next-zones/zones");
const { fromDirectory, fromHttp, fromConnector } = require("@runsnip/next-zones/sources");
const sources = (process.env.NEXT_ZONES_SOURCES ?? "").split(",").filter(Boolean).map((s) => (/^https?:\\/\\//.test(s) ? fromHttp(s) : fromDirectory(path.resolve(s))));
if (process.env.NEXT_ZONES_CONNECTOR) {
  if (!process.env.NEXT_ZONES_CONNECTOR_OWNER) { console.error("next-zones: NEXT_ZONES_CONNECTOR needs NEXT_ZONES_CONNECTOR_OWNER"); process.exit(1); }
  sources.push(fromConnector({ origin: process.env.NEXT_ZONES_CONNECTOR, owner: process.env.NEXT_ZONES_CONNECTOR_OWNER, token: process.env.NEXT_ZONES_CONNECTOR_TOKEN }));
}
const pinsFile = path.join(__dirname, "zones.json"), policyFile = path.join(__dirname, "zones.config.json");
const zones = createZones({
  shell: __dirname,
  store: process.env.NEXT_ZONES_STORE ?? path.join(__dirname, ".zones-store"),
  cacheDir: process.env.NEXT_ZONES_CACHE,
  adminToken: process.env.NEXT_ZONES_ADMIN_TOKEN,
  pins: fs.existsSync(pinsFile) ? JSON.parse(fs.readFileSync(pinsFile, "utf8")).zones ?? {} : {},
  pinsAt: fs.existsSync(pinsFile) ? fs.statSync(pinsFile).mtimeMs : 0,
  ...(fs.existsSync(policyFile) ? { policy: JSON.parse(fs.readFileSync(policyFile, "utf8")) } : {}),
  sources,
});
const port = parseInt(process.env.PORT, 10) || 3000, hostname = process.env.HOSTNAME || "0.0.0.0";
zones.listen(port, hostname).then(() => console.log(\`Zones on http://\${hostname}:\${port}\`)).catch((error) => { console.error(error); process.exit(1); });
`;
