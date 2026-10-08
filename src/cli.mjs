#!/usr/bin/env node
/*
 * next-zones <command>
 *
 *   init <dir> [zone…] [--no-install]                 a new workspace: a shared package, the shell and its zones
 *   add <zone> [--mount /<segment>]                  one more zone in the workspace of the current folder
 *   check <dir> [more dirs…]                        checks a workspace of zones (mounts, the shell, aliases)
 *   build [zone…] [--dir .] [--version <v>] [--store <dir>] [--pack [--format tgz|zip]] [--out <dir>]
 *                                                   no zone: the workspace as its shell declares (mode "zones": the
 *                                                   shell as an app, every zone as an image, zones.json pins); with zones:
 *                                                   their images only, to release what changed
 *   start [--dir .] [--store <dir>] [--source <url template | dir>]… [--port 3000] [--host 0.0.0.0] [serve's options]
 *                                                   runs what build made: Zones with the shell and the pinned images, or
 *                                                   (mode "single") next start of the one app
 *   serve --shell <dir> [--store <dir>] [--cache <dir>] [--pins zones.json] [--source <url template | dir>]…
 *         [--keep 2] [--no-prune] [--min-free <MB>] [--port 3000] [--host 0.0.0.0]
 *                                                   runs Zones: the shell, with zones installed from the store
 *   pack <zone image dir> [--out <file.tgz|file.zip>] packs a zone image (<store>/<zone>/<version>) into one .tgz or .zip
 *   pull <zone> <version> --store <dir> --source <url template | dir>… [--min-free <MB>]
 *                                                   pulls a zone image into a store, on the server (any zone)
 *   pull <zone> <version> --url <zones url> [--base /_next-zones]
 *                                                   pings a running Zones to pull it (a zone with livePull only)
 *   prune --store <dir> [--keep 2] [--pins zones.json] [--cache <dir>] [--dry-run]
 *                                                   removes zone images no longer needed, from a store no Zones runs on
 *   prune --url <zones url> [--base /_next-zones] [--keep 2] [--dry-run]
 *                                                   asks a running Zones to prune its store
 *   install <zone> <version> [--url http://127.0.0.1:3000] [--base /_next-zones]
 *                                                   asks a running Zones service to install (swap to, roll back to) a version
 *   doctor <dir> [more dirs…] [--store <dir>] [--url <zones url>] [--fast]
 *                                                   checks a workspace from source: what Zones and dev need
 *   dev <zones dir> [--port 3000]                   the shell and its zones as one app on `next dev`: HMR, soft navigation
 *   watch <zones dir> <zone> [more zones…] [--url http://127.0.0.1:3000] [--base /_next-zones] [--store <dir>]
 *                                                   rebuilds the zones on every change and installs them on a running Zones service
 *
 * --source can be given with --connector <origin> --connector-owner <owner> (service-connector; its token from
 * NEXT_ZONES_CONNECTOR_TOKEN) to serve, start and pull.
 * serve, install, pull, prune and watch read the admin token from NEXT_ZONES_ADMIN_TOKEN. Without one, a Zones service's admin endpoints answer
 * local requests only.
 */
import fs from "node:fs";
import path from "node:path";
import { createRequire } from "node:module";

const [command, ...rest] = process.argv.slice(2);
const flag = (name, fallback) => { const i = rest.indexOf(`--${name}`); return i >= 0 ? rest.splice(i, 2)[1] : fallback; };
const usage = (text) => { console.error(`usage: next-zones ${text}`); process.exit(2); };
const takeSwitch = (name) => { const i = rest.indexOf(`--${name}`); return i >= 0 ? (rest.splice(i, 1), true) : false; };
const wholeNumber = (value, name) => { const n = Number(value); if (!Number.isInteger(n) || n < 0) usage(`${name} takes a whole number, got ${value}`); return n; };
/* --source, repeated: an http(s) template with {zone} and {version}, or a folder. */
/* --connector <origin> --connector-owner <owner>: service-connector as a source, its token from
   NEXT_ZONES_CONNECTOR_TOKEN (never on the command line). */
function takeSources() {
  const list = [];
  for (let i = rest.indexOf("--source"); i >= 0; i = rest.indexOf("--source")) list.push(rest.splice(i, 2)[1]);
  const { fromHttp, fromDirectory, fromConnector } = createRequire(import.meta.url)("./sources.cjs");
  const sources = list.map((s) => (/^https?:\/\//.test(s) ? fromHttp(s) : fromDirectory(path.resolve(s))));
  const connector = flag("connector"), owner = flag("connector-owner");
  if (connector && !owner) usage("--connector <origin> needs --connector-owner <owner>");
  if (connector) sources.push(fromConnector({ origin: connector, owner, token: process.env.NEXT_ZONES_CONNECTOR_TOKEN }));
  return sources;
}
/* An admin request to a running Zones (NEXT_ZONES_ADMIN_TOKEN); exits on a refusal. */
async function ping(url, base, sub) {
  const token = process.env.NEXT_ZONES_ADMIN_TOKEN;
  const res = await fetch(`${url}${base}${sub}`, { method: "POST", headers: token ? { authorization: `Bearer ${token}` } : {} });
  const body = await res.json().catch(() => ({}));
  if (!res.ok) { console.error(`✗ ${body.refused ?? body.failed ?? body.error ?? res.status}`); process.exit(1); }
  return body;
}
const mb = (n) => `${(n / 1048576).toFixed(1)} MB`;

if (command === "init") await runInit();
else if (command === "add") await runAdd();
else if (command === "check") await check(rest.length ? rest : usage("check <dir with one folder per zone> [more dirs…]"));
else if (command === "build") await build();
else if (command === "serve") await serve();
else if (command === "start") await start();
else if (command === "install") await installOnZones();
else if (command === "pack") await pack();
else if (command === "pull") await pull();
else if (command === "prune") await prune();
else if (command === "doctor") await runDoctor();
else if (command === "dev") await runDev();
else if (command === "watch") await runWatch();
else usage("init | add | check | doctor | dev | build | start | serve | install | pack | pull | prune | watch   (see the header of src/cli.mjs)");

async function runInit() {
  const noInstall = rest.includes("--no-install");
  const args = rest.filter((a) => a !== "--no-install");
  if (!args.length) usage("init <dir> [zone…] [--no-install]");
  const { init } = await import("./init.mjs");
  await init({ dir: args[0], zones: args.slice(1), install: !noInstall });
}

async function runAdd() {
  const mount = flag("mount");
  if (!rest.length) usage("add <zone> [--mount /<segment>]");
  const { add } = await import("./init.mjs");
  await add({ zone: rest[0], mount });
}

async function runDoctor() {
  const store = flag("store"), url = flag("url");
  const fast = rest.includes("--fast");
  const dirs = rest.filter((a) => a !== "--fast");
  if (!dirs.length) usage("doctor <dir> [more dirs…] [--store <dir>] [--url <zones url>] [--fast]");
  const { doctor } = await import("./doctor.mjs");
  const { errors } = await doctor({ dirs, store, url, fast });
  process.exit(errors ? 1 : 0);
}

async function runDev() {
  const port = Number(flag("port", process.env.PORT ?? 3000));
  const [zonesDir] = rest;
  if (!zonesDir) usage("dev <zones dir> [--port 3000]");
  const { composeDev } = await import("./compose.mjs");
  await composeDev({ zonesDir, port });
}

async function runWatch() {
  const url = flag("url", "http://127.0.0.1:3000"), base = flag("base", "/_next-zones"), store = flag("store");
  const [zonesDir, ...zones] = rest;
  if (!zonesDir || !zones.length) usage("watch <zones dir> <zone> [more zones…] [--url http://127.0.0.1:3000] [--base /_next-zones] [--store <dir>]");
  const { watch } = await import("./watch.mjs");
  await watch({ zonesDir, zones, url, base, store });
}

async function build() {
  const dir = flag("dir", "."), version = flag("version"), store = flag("store"), out = flag("out"), pack = takeSwitch("pack"), format = flag("format", "tgz");
  const zones = rest.filter((a) => !a.startsWith("--"));
  if (rest.some((a) => a.startsWith("--"))) usage("build [zone…] [--dir .] [--version <v>] [--store <dir>] [--pack [--format tgz|zip]] [--out <dir>]");
  const { buildWorkspace } = await import("./build.mjs");
  let result;
  try { result = await buildWorkspace({ dir, zones, version, store, out, pack, format }); }
  catch (error) { console.error(`✗ ${error.message}`); process.exit(1); }
  const rel = (p) => path.relative(process.cwd(), p) || ".";
  if (result.app) console.log(`✓ one app, linked from the images: ${rel(result.app)}  (next-zones start runs it: next start)`);
  if (result.server) console.log(`✓ one app, standalone (output "standalone"), linked from the images: ${rel(result.server)}  (next-zones start runs it, or node ${rel(result.server)})`);
  if (result.standalone) console.log(`✓ Zones, standalone (output "standalone"): ${rel(result.standalone.dir)}  (the whole deploy: node ${rel(result.standalone.entry)})`);
  if (result.site) console.log(`✓ zones linked into one static site (output "export"): ${rel(result.site)}  (any static host serves it)`);
  if (result.shell) console.log(`✓ shell: ${rel(result.shell)}/.next`);
  for (const i of result.images) console.log(`✓ ${i.zone} ${i.version}: ${i.tgz ? rel(i.tgz) : i.dir ? rel(i.dir) : "already built"}`);
  if (result.pins) console.log(`✓ pins: ${rel(result.pins)}  (next-zones start runs them)`);
}

/* next-zones start: what `next-zones build` made of the workspace. With mode "zones", Zones on the shell, installing
   the versions zones.json pins from the store, else pulled from <dir>/.zones-images (built with --pack) or --source. */
async function start() {
  const dir = path.resolve(flag("dir", "."));
  const { findZones } = await import("./workspace.mjs");
  const shell = (await findZones([dir])).zones.find((z) => z.mount === "/");
  if (!shell) { console.error(`✗ no shell (the zone mounted at "/") in ${dir}`); process.exit(1); }
  if (shell.mode === "single") {
    /* One app linked from the images (link-app.mjs), served as Next serves it: next start, or the standalone server.js;
       a static export has no server. */
    const { isStandalone, standaloneServerDir } = await import("./standalone.mjs");
    const { isExport } = await import("./link.mjs");
    const dotNext = path.join(shell.dir, ".next");
    if (isExport(dotNext)) { console.error(`✗ the workspace is built as a static site (output: "export"), served by any static host from ${path.join(dir, ".zones-export")}`); process.exit(1); }
    const { spawn } = await import("node:child_process");
    const port = String(flag("port", process.env.PORT ?? 3000)), host = flag("host");
    let child;
    if (isStandalone(dotNext)) {
      const server = path.join(standaloneServerDir(shell.dir), "server.js");
      if (!fs.existsSync(server)) { console.error(`✗ no ${server}: run next-zones build`); process.exit(1); }
      child = spawn(process.execPath, [server], { cwd: path.dirname(server), stdio: "inherit", env: { ...process.env, PORT: port, ...(host ? { HOSTNAME: host } : {}) } });
    } else {
      const app = path.join(dir, ".zones-app");
      if (!fs.existsSync(path.join(app, ".next", "BUILD_ID"))) { console.error(`✗ the workspace is not linked into one app: run next-zones build (${app})`); process.exit(1); }
      const next = createRequire(path.join(shell.dir, "package.json")).resolve("next/dist/bin/next");
      child = spawn(process.execPath, [next, "start", "-p", port, ...(host ? ["-H", host] : [])], { cwd: app, stdio: "inherit" });
    }
    child.on("exit", (code) => process.exit(code ?? 0));
    for (const signal of ["SIGINT", "SIGTERM"]) process.on(signal, () => child.kill(signal));
    return;
  }
  if (!fs.existsSync(path.join(shell.dir, ".next", "BUILD_ID"))) { console.error(`✗ the shell ${shell.name} is not built: run next-zones build first`); process.exit(1); }
  /* Next's output: "export": a static site, no server to start. */
  const { isExport } = await import("./link.mjs");
  if (isExport(path.join(shell.dir, ".next"))) { console.error(`✗ the workspace is built as a static site (output: "export"), served by any static host from ${path.join(dir, ".zones-export")}`); process.exit(1); }
  /* Next's output: "standalone": the deploy is the standalone folder, started by its zones.js (standalone.mjs). */
  const { isStandalone, standaloneServerDir } = await import("./standalone.mjs");
  if (isStandalone(path.join(shell.dir, ".next"))) {
    const entry = path.join(standaloneServerDir(shell.dir), "zones.js");
    if (!fs.existsSync(entry)) { console.error(`✗ no ${entry}: run next-zones build for the whole workspace`); process.exit(1); }
    const { spawn } = await import("node:child_process");
    const port = flag("port", process.env.PORT ?? "3000"), host = flag("host");
    const child = spawn(process.execPath, [entry], { stdio: "inherit", env: { ...process.env, PORT: String(port), ...(host ? { HOSTNAME: host } : {}) } });
    child.on("exit", (code) => process.exit(code ?? 0));
    for (const signal of ["SIGINT", "SIGTERM"]) process.on(signal, () => child.kill(signal));
    return;
  }
  /* The workspace's packed images are always a source, there yet or not: `next-zones build <zone> --pack` adds to them
     while Zones runs, and a ping installs what it added. */
  rest.push("--source", path.join(dir, ".zones-images"));
  if (!rest.includes("--pins")) rest.push("--pins", path.join(dir, "zones.json"));
  if (!rest.includes("--store") && !process.env.NEXT_ZONES_STORE) rest.push("--store", path.join(dir, ".zones-store"));
  rest.push("--shell", shell.dir);
  await serve();
}

async function serve() {
  const shell = flag("shell");
  if (!shell) usage("serve --shell <dir> [--store <dir>] [--cache <dir>] [--port 3000] [--host 0.0.0.0]");
  /* The pins: zones.json shipped with the deploy or written by next-zones build ({ "zones": { "blog": "12" } }),
     read-only; the store's state.json (what was installed since) is read over them, unless they are newer. */
  const pinsFile = flag("pins", "zones.json");
  let pins = {}, pinsAt = 0;
  if (fs.existsSync(pinsFile)) {
    try { pins = JSON.parse(fs.readFileSync(pinsFile, "utf8")).zones ?? {}; pinsAt = fs.statSync(pinsFile).mtimeMs; }
    catch (error) { console.error(`next-zones: ${pinsFile} is not valid JSON: ${error.message}`); process.exit(1); }
  }
  /* Sources: where zone images are pulled from (an http(s) template with {zone} and {version}, or a folder). Without
     them Zones installs what is in its store only. */
  const noPrune = takeSwitch("no-prune"), keep = flag("keep"), minFree = flag("min-free");
  const options = {
    shell, store: flag("store", process.env.NEXT_ZONES_STORE), cacheDir: flag("cache"), adminToken: process.env.NEXT_ZONES_ADMIN_TOKEN, pins, pinsAt,
    sources: takeSources(),
    prune: noPrune ? false : { keep: keep === undefined ? 2 : wholeNumber(keep, "--keep") },
    ...(minFree !== undefined ? { minFree: wholeNumber(minFree, "--min-free") * 1048576 } : {}),
  };
  const port = Number(flag("port", process.env.PORT ?? 3000)), host = flag("host", "0.0.0.0");
  const { createZones } = createRequire(import.meta.url)("./zones/index.cjs");
  const server = createZones(options);
  await server.listen(port, host);
  console.log(`next-zones: Zones on http://${host}:${port}, shell ${path.resolve(shell)}`);
  for (const [zone, { version }] of Object.entries(server.zones())) console.log(`  ${zone} ${version}`);
}

async function pack() {
  const out = flag("out");
  const [dir] = rest;
  if (!dir) usage("pack <zone image dir> [--out <file.tgz>]");
  const zone = JSON.parse(fs.readFileSync(path.join(dir, "zone.json"), "utf8"));
  const { packZoneImage } = createRequire(import.meta.url)("./sources.cjs");
  const file = await packZoneImage(dir, out ?? `${zone.name}-${zone.version}.tgz`);
  console.log(`packed ${zone.name} ${zone.version} into ${file} (${(fs.statSync(file).size / 1048576).toFixed(1)} MB)`);
}

async function pull() {
  const url = flag("url"), base = flag("base", "/_next-zones"), store = flag("store", process.env.NEXT_ZONES_STORE), minFree = flag("min-free");
  const sources = takeSources();
  const [zone, version] = rest;
  if (!zone || !version || (!url && (!store || !sources.length))) usage("pull <zone> <version> (--store <dir> --source <url template | dir>… [--min-free <MB>] | --url <zones url> [--base /_next-zones])");
  if (url) {
    const body = await ping(url, base, `/images/${encodeURIComponent(zone)}/${encodeURIComponent(version)}/pull`);
    console.log(body.pulledFrom ? `✓ ${zone} ${version} pulled from ${body.pulledFrom}` : `✓ ${zone} ${version} was in the store already`);
    return;
  }
  const require = createRequire(import.meta.url);
  const { pullImage } = require("./zones/pull.cjs");
  const { digestBuild } = require("./zones/describe.cjs");
  if (fs.existsSync(path.join(store, zone, version, "zone.json"))) { console.log(`✓ ${zone} ${version} is in the store already`); return; }
  try {
    const { source, identity } = await pullImage({
      store: path.resolve(store), name: zone, version, sources, verify: async (dir) => digestBuild(dir),
      ...(minFree !== undefined ? { minFree: wholeNumber(minFree, "--min-free") * 1048576 } : {}),
    });
    console.log(`✓ ${zone} ${version} pulled from ${source}${identity.integrity.bytes ? ` (${mb(identity.integrity.bytes)})` : ""}`);
  } catch (error) { console.error(`✗ ${error.message}`); process.exit(1); }
}

async function prune() {
  const url = flag("url"), base = flag("base", "/_next-zones"), store = flag("store", process.env.NEXT_ZONES_STORE);
  const keep = flag("keep"), pinsFile = flag("pins", "zones.json"), cacheDir = flag("cache"), dryRun = takeSwitch("dry-run");
  if (!url && !store) usage("prune (--store <dir> [--pins zones.json] [--cache <dir>] | --url <zones url> [--base /_next-zones]) [--keep 2] [--dry-run]");
  let result;
  if (url) {
    const query = new URLSearchParams({ ...(keep !== undefined ? { keep: String(wholeNumber(keep, "--keep")) } : {}), ...(dryRun ? { dry: "1" } : {}) });
    result = await ping(url, base, `/prune${query.size ? `?${query}` : ""}`);
  } else {
    const require = createRequire(import.meta.url);
    const { prune: pruneStore, running } = require("./zones/prune.cjs");
    const pid = running(path.resolve(store));
    if (pid) { console.error(`✗ Zones (pid ${pid}) runs on this store: prune it through Zones (next-zones prune --url …), which unloads what it removes`); process.exit(1); }
    let pins = {};
    if (fs.existsSync(pinsFile)) pins = JSON.parse(fs.readFileSync(pinsFile, "utf8")).zones ?? {};
    result = await pruneStore({ store: path.resolve(store), pins, keep: keep === undefined ? 2 : wholeNumber(keep, "--keep"), cacheDir: cacheDir && path.resolve(cacheDir), dryRun });
  }
  const verb = dryRun ? "would remove" : "removed";
  console.log(result.removed.length ? `✓ ${verb} ${result.removed.join(", ")} (${mb(result.freedBytes)})` : "✓ nothing to remove");
  if (result.held?.length) console.log(`  held until a restart: ${result.held.join(", ")}`);
  for (const k of result.kept) console.log(`  kept ${k.zone}@${k.version}: ${k.why}`);
}

async function installOnZones() {
  const url = flag("url", "http://127.0.0.1:3000"), base = flag("base", "/_next-zones");
  const [zone, version] = rest;
  if (!zone || !version) usage("install <zone> <version> [--url http://127.0.0.1:3000] [--base /_next-zones]");
  const token = process.env.NEXT_ZONES_ADMIN_TOKEN;
  const res = await fetch(`${url}${base}/images/${encodeURIComponent(zone)}/${encodeURIComponent(version)}/install`, {
    method: "POST", headers: token ? { authorization: `Bearer ${token}` } : {},
  });
  const body = await res.json();
  if (!res.ok) { console.error(`✗ ${body.refused ?? body.failed ?? body.error ?? res.status}`); process.exit(1); }
  console.log(`✓ ${zone} ${version} installed: switch ${(body.t.activate * 1000).toFixed(1)} µs, ${body.routes.length} routes`);
}

async function check(dirs) {
  const { findZones, declarationProblems } = await import("./workspace.mjs");
  const { zones, failed } = await findZones(dirs);
  const problems = [...failed.map((f) => `${f.name}: ${f.error}`), ...declarationProblems(zones)];
  if (problems.length) {
    console.error(problems.map((p) => `✗ ${p}`).join("\n"));
    process.exit(1);
  }
  console.log(zones.map((z) => `✓ ${z.mount.padEnd(12)} ${z.name}${z.aliases?.length ? `  (aliases: ${z.aliases.map((a) => a.source).join(", ")})` : ""}`).join("\n"));
}
