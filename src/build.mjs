/*
 * Builds one version of a zone and puts the build in a zone store, as a release would:
 *
 *   buildZone({ zonesDir, zone, version, store })      (next-zones build <zone> runs it, through buildWorkspace below)
 *
 * - The build runs in the zone's own folder. Two versions may give one id to different modules: Zones keys modules by
 *   what they are, their dependencies included (zone-client.cjs in the browser, registry.cjs on the server).
 * - ZONE_VERSION is set for the build.
 * - The store gets <store>/<zone>/<version>/: the build, the zone's public/ (not part of a Next build), and zone.json:
 *   name, version, mount, aliases (from the zone's next.config, with readZone()), the Next and React it was built
 *   with, the build's integrity (a sha256 over its files) and what Zones needs to install it (zones/describe.cjs).
 * - The store is --store, else NEXT_ZONES_STORE, else <zones dir>/.zones-store.
 *
 * buildWorkspace() is `next-zones build` (the owner's three cases; the shell declares which with zoneConfig mode):
 * - "zones" (default), the whole workspace: the shell built as an app (`next build` in its folder), every other zone
 *   built as an image, and zones.json pinning the versions built, for `next-zones start`;
 * - one zone or a few (`next-zones build <zone>…`): their images only, to release what changed; the shell is not built;
 * - "single": every zone built as on Zones, then the shell and every image linked into one Next app following the
 *   shell's output: <dir>/.zones-app for `next start` (link-app.mjs), the shell's standalone folder, or a static site
 *   in <dir>/.zones-export (link.mjs). One zone format; no Zones at run time.
 * An image's version is the `version` in the zone's package.json, unless `version` is given. A version already in the
 * store is never built over: building the whole workspace keeps it (and says so), building one zone refuses it.
 * `pack`: each image is also packed into <out>/<zone>/<version>.tgz (or .zip, `format`), the layout a source serves (fromDirectory,
 * fromHttp), and removed from the store, which then holds only what was not packed.
 */
import fs from "node:fs";
import path from "node:path";
import { spawnSync } from "node:child_process";
import { createRequire } from "node:module";
import { readZone } from "./config.mjs";
import { copyTracedPackages, isStandalone, prepareStandaloneZones } from "./standalone.mjs";
import { isExport, linkStaticSite } from "./link.mjs";

/**
 * Builds one version of a zone into a zone store.
 * quiet: Next's build output is not shown (its errors are).
 * @returns {Promise<string>} the store folder of that version
 */
export async function buildZone({ zonesDir, zone: name, version = "1", store: storeArg, quiet = false }) {
  const source = path.resolve(zonesDir, name);
  /* Built where it is: no copy per version (debt D10, settled). A module's identity is what it is, its dependencies
     included, in the browser (zone-client.cjs: a module that differs from what the browser may hold gets a new id) and
     on the server (registry.cjs): v1 and v2 of a zone may give one id to different modules. Turbopack's cache in
     .next/cache is reused by the next version's build. */
  const work = source;
  const store = path.resolve(storeArg ?? process.env.NEXT_ZONES_STORE ?? path.join(zonesDir, ".zones-store"));
  if (!fs.existsSync(source)) throw new Error(`no zone at ${source}`);

  const next = createRequire(path.join(work, "package.json")).resolve("next/dist/bin/next");
  const built = spawnSync(process.execPath, [next, "build"], { cwd: work, stdio: quiet ? ["ignore", "ignore", "inherit"] : "inherit", env: { ...process.env, ZONE_VERSION: version, NEXT_ZONES_BUILD: "zones" } });
  if (built.status !== 0) throw new Error(`next build failed for ${name}@${version} (exit ${built.status})`);

  process.env.ZONE_VERSION = version;
  const zone = await readZone(work);
  if (!zone) throw new Error(`${source}: its next.config does not use zoneConfig()`);
  const target = path.join(store, name, version);
  fs.rmSync(target, { recursive: true, force: true });
  fs.mkdirSync(path.dirname(target), { recursive: true });
  /* The build, without what only building needs: Turbopack's build cache (most of the size), traces, diagnostics,
     generated types and file traces. Zones keeps a zone image's own cache elsewhere. */
  const BUILD_ONLY = new Set(["cache", "trace", "trace-build", "diagnostics", "types", "standalone"]);
  fs.cpSync(path.join(work, ".next"), target, {
    recursive: true,
    filter: (src) => {
      const rel = path.relative(path.join(work, ".next"), src);
      return !BUILD_ONLY.has(rel.split(path.sep)[0]) && !(!rel.includes(path.sep) && rel.endsWith(".nft.json"));
    },
  });
  /* Next's output: "standalone" in the zone's own config: the image carries the packages its server traces need,
     as a standalone folder would (standalone.mjs), so it runs where the workspace's node_modules is not. */
  if (isStandalone(path.join(work, ".next"))) copyTracedPackages(path.join(work, ".next"), target);
  /* Next's output: "export" in the zone's own config: the image keeps the export too, for the static link (link.mjs). */
  if (isExport(path.join(work, ".next")) && fs.existsSync(path.join(work, "out"))) fs.cpSync(path.join(work, "out"), path.join(target, "out"), { recursive: true });
  /* public/ is not part of a Next build: the store keeps it beside the build. */
  if (fs.existsSync(path.join(work, "public"))) fs.cpSync(path.join(work, "public"), path.join(target, "public"), { recursive: true });
  /* The Next and React the zone was built with: Zones refuses a zone whose shared packages differ from its own. */
  const requireFromZone = createRequire(path.join(work, "package.json"));
  const builtWith = Object.fromEntries(["next", "react", "react-dom"].map((pkg) => [pkg, requireFromZone(`${pkg}/package.json`).version]));
  /* instrumentation-client is bundled into the zone's own documents only; Zones refuses it, so it is recorded. */
  const clientInstrumentation = ["", "src"].some((dir) => ["ts", "tsx", "js", "mjs"].some((ext) => fs.existsSync(path.join(work, dir, `instrumentation-client.${ext}`))));
  /* What Zones needs to install it, read from the build once, here (D2), and the build's integrity, which Zones
     checks before it installs it. */
  const { describeBuild, digestBuild } = createRequire(import.meta.url)("./zones/describe.cjs");
  const install = describeBuild(target);
  const integrity = digestBuild(target);
  fs.writeFileSync(path.join(target, "zone.json"), JSON.stringify({ name, version, ...zone, built: builtWith, clientInstrumentation, integrity, install }, null, 2) + "\n");
  return target;
}

/** The version an image of `dir` is built as: `version`, else the zone's package.json version. */
export function zoneVersion(dir, version) {
  if (version !== undefined) return String(version);
  let pkg = {};
  try { pkg = JSON.parse(fs.readFileSync(path.join(dir, "package.json"), "utf8")); } catch {}
  if (!pkg.version) throw new Error(`${path.basename(dir)}: no "version" in its package.json (or pass --version)`);
  return String(pkg.version);
}

/**
 * `next-zones build`: the workspace in `dir` (folders of zones), as its shell declares, or only `zones` when named.
 * @returns {Promise<{ mode: "zones"|"single", app?: string, shell: string|null, images: { zone, version, built: boolean, dir?: string, tgz?: string }[], pins: string|null }>}
 */
export async function buildWorkspace({ dir = ".", zones: only = [], version, store: storeArg, pack = false, format = "tgz", out: outArg, quiet = false, log = console.log }) {
  if (!["tgz", "zip"].includes(format)) throw new Error(`a zone image is packed as tgz or zip, not ${JSON.stringify(format)}`);
  const { findZones, declarationProblems } = await import("./workspace.mjs");
  const root = path.resolve(dir);
  const { zones, failed } = await findZones([root]);
  const problems = [...failed.map((f) => `${f.name}: ${f.error}`), ...declarationProblems(zones)];
  if (problems.length) throw new Error(`the workspace has problems (next-zones check):\n${problems.map((p) => `  - ${p}`).join("\n")}`);
  const shell = zones.find((z) => z.mount === "/");
  for (const name of only) {
    if (!zones.some((z) => z.name === name)) throw new Error(`no zone named "${name}" in ${root} (zones: ${zones.map((z) => z.name).join(", ")})`);
    if (name === shell.name) throw new Error(`${name} is the shell: it is built with the whole workspace (next-zones build), not as an image`);
  }
  const store = path.resolve(storeArg ?? process.env.NEXT_ZONES_STORE ?? path.join(root, ".zones-store"));
  const out = path.resolve(outArg ?? path.join(root, ".zones-images"));
  const whole = only.length === 0;
  const targets = zones.filter((z) => z.mount !== "/" && (whole || only.includes(z.name)));
  const plan = targets.map((z) => ({ zone: z.name, version: zoneVersion(z.dir, version) }));
  for (const p of plan) if (!/^[A-Za-z0-9._-]+$/.test(p.version)) throw new Error(`${p.zone}: version ${JSON.stringify(p.version)} has characters a zone image's version may not (letters, digits, ".", "_", "-")`);

  /* Images are immutable: one already built is kept by a workspace build, refused by a build of named zones. */
  const exists = (p) => fs.existsSync(path.join(store, p.zone, p.version, "zone.json")) || ["tgz", "zip"].some((f) => fs.existsSync(path.join(out, p.zone, `${p.version}.${f}`)));
  if (!whole) {
    const taken = plan.filter(exists);
    if (taken.length) throw new Error(`already built (an image is never built over; bump the zone's version): ${taken.map((p) => `${p.zone} ${p.version}`).join(", ")}`);
  }

  const single = shell.mode === "single";
  const result = { mode: single ? "single" : "zones", shell: null, images: [], pins: null };
  if (whole) {
    log(`▸ ${shell.name} (the shell): next build`);
    const next = createRequire(path.join(shell.dir, "package.json")).resolve("next/dist/bin/next");
    const built = spawnSync(process.execPath, [next, "build"], { cwd: shell.dir, stdio: quiet ? ["ignore", "ignore", "inherit"] : "inherit", env: { ...process.env, NEXT_ZONES_BUILD: "zones" } });
    if (built.status !== 0) throw new Error(`next build failed for the shell ${shell.name} (exit ${built.status})`);
    result.shell = shell.dir;
  }
  /* Next's output: "export" in the shell's config: the images are linked into one static site, after they are built
     and before any is packed away. */
  const exported = whole && isExport(path.join(shell.dir, ".next"));
  /* Mode "single" links the images into one app after they are built (below): none is packed away before that. */
  const linkLater = single || exported;
  const packLater = [];
  for (const p of plan) {
    if (exists(p)) { log(`▸ ${p.zone} ${p.version}: already built, kept`); result.images.push({ ...p, built: false }); continue; }
    log(`▸ ${p.zone} ${p.version}: building its image`);
    const target = await buildZone({ zonesDir: root, zone: p.zone, version: p.version, store, quiet });
    const image = { ...p, built: true, dir: target };
    if (pack && linkLater) { packLater.push(image); result.images.push(image); continue; }
    if (pack) {
      const { packZoneImage } = createRequire(import.meta.url)("./sources.cjs");
      fs.mkdirSync(path.join(out, p.zone), { recursive: true });
      image.tgz = await packZoneImage(target, path.join(out, p.zone, `${p.version}.${format}`));
      fs.rmSync(target, { recursive: true, force: true });
      delete image.dir;
    }
    result.images.push(image);
  }
  if (linkLater) {
    /* Every zone's image, the ones just built and the ones kept: a link is made of all of them. */
    const versionOf = (z) => plan.find((p) => p.zone === z.name)?.version ?? zoneVersion(z.dir);
    const images = zones.filter((z) => z.mount !== "/").map((z) => ({ zone: z.name, mount: z.mount, aliases: z.aliases ?? [], dir: path.join(store, z.name, versionOf(z)) }));
    for (const image of images) if (!fs.existsSync(path.join(image.dir, "zone.json"))) throw new Error(`${image.zone}: its image is not in ${store} (build it: next-zones build ${image.zone})`);
    if (!fs.existsSync(path.join(shell.dir, ".next", "BUILD_ID"))) throw new Error(`the shell ${shell.name} is not built: build the whole workspace (next-zones build)`);
    const shellDist = path.join(shell.dir, ".next");
    if (isExport(shellDist)) {
      log(`▸ linking ${images.length} zones into one static site`);
      result.site = (await linkStaticSite({ shellDir: shell.dir, images, site: path.join(root, ".zones-export") })).site;
    } else {
      const { linkApp } = await import("./link-app.mjs");
      let policy = {};
      try { policy = JSON.parse(fs.readFileSync(path.join(root, "zones.config.json"), "utf8")).instrumentation ?? {}; } catch {}
      if (isStandalone(shellDist)) {
        /* Next's output: "standalone": linked into the shell's standalone folder, which is then the whole deploy; what
           the zones' server code needs of Next that the shell's trace did not reach is traced in. */
        const { standaloneServerDir, traceInto, bringZoneExternals } = await import("./standalone.mjs");
        const serverDir = standaloneServerDir(shell.dir);
        log(`▸ linking ${images.length} zones into one standalone app`);
        await linkApp({ shellDir: shell.dir, images, out: serverDir, policy, into: true });
        const entries = [];
        const collect = (d) => { for (const e of fs.readdirSync(d, { withFileTypes: true })) { const f = path.join(d, e.name); if (e.isDirectory()) collect(f); else if (/\.js$/.test(e.name)) entries.push(f); } };
        for (const image of images) collect(path.join(image.dir, "server"));
        await traceInto({ shellDir: shell.dir, root: path.join(shell.dir, ".next", "standalone"), entries });
        await bringZoneExternals({ shellDir: shell.dir, root: path.join(shell.dir, ".next", "standalone"), homes: images.map((i) => path.join(serverDir, ".next", "zones", i.zone)) });
        result.server = path.join(serverDir, "server.js");
      } else {
        log(`▸ linking ${images.length} zones into one app`);
        result.app = (await linkApp({ shellDir: shell.dir, images, out: path.join(root, ".zones-app"), policy })).out;
      }
    }
    for (const image of packLater) {
      const { packZoneImage } = createRequire(import.meta.url)("./sources.cjs");
      fs.mkdirSync(path.join(out, image.zone), { recursive: true });
      image.tgz = await packZoneImage(image.dir, path.join(out, image.zone, `${image.version}.${format}`));
      fs.rmSync(image.dir, { recursive: true, force: true });
      delete image.dir;
    }
  }
  /* The versions just built, for next-zones start (read-only for Zones: installs since go to the store's state.json). */
  if (whole && !single) {
    result.pins = path.join(root, "zones.json");
    const pins = Object.fromEntries(plan.map((p) => [p.zone, p.version]));
    fs.writeFileSync(result.pins, JSON.stringify({ zones: pins }, null, 2) + "\n");
    /* Next's output: "standalone" in the shell's config: its standalone folder becomes the whole deploy of Zones. */
    if (isStandalone(path.join(shell.dir, ".next"))) {
      const { name: _name, dir: _dir, ...declaration } = shell;
      result.standalone = await prepareStandaloneZones({ shellDir: shell.dir, declaration, store: pack ? null : store, pins: result.pins, policy: path.join(root, "zones.config.json") });
    }
  }
  return result;
}

