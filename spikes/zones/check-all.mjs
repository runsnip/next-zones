#!/usr/bin/env node
/*
 * Runs every Zones check, each against a freshly started Zones, and prints one line per check: pass or fail, why, and the
 * Zones's unexpected log errors. The base of the upgrade guard: run it before allowing a new Next version.
 *
 *   node check-all.mjs [check …]       (all checks by default; the builds must exist: build-zone.sh, next build)
 *   VERBOSE=1 prints a failed check's output, SHOW=1 every check's; a failed check's output and Zones' log are kept in check-logs/.
 */
import { spawn, execFileSync } from "node:child_process";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";

const CHECKS = ["browse", "features", "bound", "swap", "links", "alias", "media", "routing", "rules", "routes", "proxy",
  "revalidate", "instrumentation", "shared", "concurrent", "swapload", "signal", "external", "params", "miss", "many", "cc", "sharedver", "context", "standalone", "composed", "doctor", "init", "contract", "collect", "integrity", "health", "pull", "endpoints", "endpointsoff", "endpointsbase", "localdeps", "prune", "release", "single", "singlestandalone", "singleexport", "zonesstandalone", "zonesexport", "ownhandler", "reclaim", "lrumem", "isrswap", "widths", "leak", "metrics", "pagesrouter", "composedpages", "singlepages", "singlepagesstandalone", "notfound", "mcp"];
/* Checks that need their own setup: the environment for Zones and the check. */
const SETUP = {
  /* A non-public env variable only the server may read (leak.mjs looks for it in everything a browser can fetch). */
  leak: () => ({ NZ_LEAK_SECRET: "nz-env-marker-a8e0" }),
  /* The zone store copied away from the workspace, as on a server. */
  external: () => {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), "nz-store-"));
    fs.cpSync(".zones-store", dir, { recursive: true, verbatimSymlinks: true });
    return { NEXT_ZONES_STORE: dir };
  },
  /* A store with blog 1 and shop 1 only, and a source folder: blog 2 packed into a .tgz; blog 5, a copy of blog 1
     with one server file changed after it was built; shop 2, intact, from a zone that does not allow live pulls
     (pull.mjs). */
  pull: () => {
    const store = fs.mkdtempSync(path.join(os.tmpdir(), "nz-store-")), source = fs.mkdtempSync(path.join(os.tmpdir(), "nz-source-"));
    for (const [zone, v] of [["blog", "1"], ["shop", "1"]]) fs.cpSync(path.join(".zones-store", zone, v), path.join(store, zone, v), { recursive: true, verbatimSymlinks: true });
    fs.mkdirSync(path.join(source, "blog"));
    execFileSync(process.execPath, ["../../src/cli.mjs", "pack", path.join(".zones-store", "blog", "2"), "--out", path.join(source, "blog", "2.tgz")]);
    const five = path.join(source, "blog", "5");
    fs.cpSync(path.join(".zones-store", "blog", "1"), five, { recursive: true, verbatimSymlinks: true });
    const zoneJson = JSON.parse(fs.readFileSync(path.join(five, "zone.json"), "utf8"));
    fs.writeFileSync(path.join(five, "zone.json"), JSON.stringify({ ...zoneJson, version: "5" }));
    fs.appendFileSync(path.join(five, "server", "app-paths-manifest.json"), " ");
    /* shop 2: intact, but the shop does not allow live pulls. */
    fs.mkdirSync(path.join(source, "shop"));
    execFileSync(process.execPath, ["../../src/cli.mjs", "pack", path.join(".zones-store", "shop", "2"), "--out", path.join(source, "shop", "2.tgz")]);
    return { NEXT_ZONES_STORE: store, NEXT_ZONES_SOURCE: source, NEXT_ZONES_PRUNE_KEEP: "2" };
  },
  /* A store with blog 1 only, and a source with blog 2, which endpoints.mjs asks Zones to pull. */
  endpoints: () => {
    const store = fs.mkdtempSync(path.join(os.tmpdir(), "nz-store-")), source = fs.mkdtempSync(path.join(os.tmpdir(), "nz-source-"));
    fs.cpSync(path.join(".zones-store", "blog", "1"), path.join(store, "blog", "1"), { recursive: true, verbatimSymlinks: true });
    fs.mkdirSync(path.join(source, "blog"));
    execFileSync(process.execPath, ["../../src/cli.mjs", "pack", path.join(".zones-store", "blog", "2"), "--out", path.join(source, "blog", "2.tgz")]);
    return { NEXT_ZONES_STORE: store, NEXT_ZONES_SOURCE: source };
  },
  /* A store with blog 1, and a source with blog 11, 12 and 13: blog 1's build under other versions (a zone image's
     integrity leaves zone.json out), pruned to one version before the active one (prune.mjs). */
  prune: () => {
    const store = fs.mkdtempSync(path.join(os.tmpdir(), "nz-store-")), source = fs.mkdtempSync(path.join(os.tmpdir(), "nz-source-"));
    fs.cpSync(path.join(".zones-store", "blog", "1"), path.join(store, "blog", "1"), { recursive: true, verbatimSymlinks: true });
    for (const v of ["11", "12", "13"]) {
      const dir = path.join(source, "blog", v);
      fs.cpSync(path.join(".zones-store", "blog", "1"), dir, { recursive: true, verbatimSymlinks: true });
      const zoneJson = JSON.parse(fs.readFileSync(path.join(dir, "zone.json"), "utf8"));
      fs.writeFileSync(path.join(dir, "zone.json"), JSON.stringify({ ...zoneJson, version: v }));
    }
    return { NEXT_ZONES_STORE: store, NEXT_ZONES_SOURCE: source, NEXT_ZONES_PRUNE_KEEP: "1", NEXT_ZONES_PERSIST: "on" };
  },
  endpointsoff: () => ({ NEXT_ZONES_ENDPOINTS: "off" }),
  /* MCP with every endpoint off: it is Zones' own, whatever endpoints are declared. */
  mcp: () => {
    /* An empty source: a pull on request reaches it only for a zone that allows live pulls. */
    const source = fs.mkdtempSync(path.join(os.tmpdir(), "nz-mcp-source-"));
    return { NEXT_ZONES_ENDPOINTS: "off", NEXT_ZONES_SOURCE: source };
  },
  endpointsbase: () => ({ NEXT_ZONES_ENDPOINTS: "/_ops" }),
  /* A shell and a zone with Cache Components (fixtures-cc), on their own store. */
  cc: () => ({ NEXT_ZONES_SHELL: "fixtures-cc/shell", NEXT_ZONES_STORE: ".zones-store-cc", PORT: "3900" }),
};
/* Checks slower than 2 minutes: init installs a new workspace from the registry, then runs doctor and next dev
   (2 min 46 s measured); release builds a shell and three zone images; single builds one app and three apps. */
const TIMEOUT = { composedpages: 300_000, singlepages: 600_000, singlepagesstandalone: 600_000, init: 360_000, release: 600_000, single: 600_000, ownhandler: 300_000 };
const EXPECTED = /may hold state|boom|broken on purpose|NoFallbackError|metadataBase|Running next\.config|Zones on :3900|next-zones: pruned|digest|^\s*at |^\s*[{}]|^\s*$/i;
const chosen = process.argv.slice(2).length ? process.argv.slice(2) : CHECKS;
/* The spike installs the package as a copy (install-links: Turbopack refuses a link out of its root), so the copy
   is brought up to date with src/ first: the zones' next.config and the shell import it. */
/* Written "../../dist/" so the upgrade guard, which runs a copy of this folder, can point it at the package. The
   package as published: dist/, built from src/ (tools/build-dist.mjs). */
execFileSync(process.execPath, ["../../tools/build-dist.mjs"], { stdio: "ignore" });
fs.rmSync(path.join("node_modules", "@runsnip", "next-zones", "src"), { recursive: true, force: true });
fs.rmSync(path.join("node_modules", "@runsnip", "next-zones", "dist"), { recursive: true, force: true });
fs.cpSync("../../dist/", path.join("node_modules", "@runsnip", "next-zones", "dist"), { recursive: true });
/* Its exports map too (a new subpath, such as ./metrics, is resolved from it). */
fs.copyFileSync("../../package.json", path.join("node_modules", "@runsnip", "next-zones", "package.json"));
/* Its skills (NextZonesSkill() serves skills/next-zones). */
fs.rmSync(path.join("node_modules", "@runsnip", "next-zones", "skills"), { recursive: true, force: true });
fs.cpSync("../../skills", path.join("node_modules", "@runsnip", "next-zones", "skills"), { recursive: true });
const BASE = "http://127.0.0.1:3900";

async function startZones(env) {
  fs.rmSync(".zones-cache", { recursive: true, force: true });
  const log = fs.openSync("zones.log", "w");
  const server = spawn(process.execPath, ["zones.cjs"], { stdio: ["ignore", log, log], env: { ...process.env, ...env } });
  for (let i = 0; i < 60; i++) {
    try { await fetch(BASE + "/"); return server; } catch { await new Promise((r) => setTimeout(r, 250)); }
  }
  throw new Error("Zones did not start");
}

let failed = 0;
for (const name of chosen) {
  const env = SETUP[name]?.() ?? {};
  const server = await startZones(env);
  let output = "", code = 0;
  try { output = execFileSync(process.execPath, [`${name}.mjs`], { encoding: "utf8", timeout: TIMEOUT[name] ?? 120_000, stdio: ["ignore", "pipe", "pipe"], env: { ...process.env, ...env } }); }
  catch (error) { code = error.status ?? 1; output = `${error.stdout ?? ""}${error.stderr ?? ""}`; }
  server.kill();
  await new Promise((r) => server.once("exit", r));
  /* Only a store copied into the temporary directory is removed, never a store of the workspace. */
  if (env.NEXT_ZONES_STORE?.startsWith(os.tmpdir())) fs.rmSync(env.NEXT_ZONES_STORE, { recursive: true, force: true });
  if (env.NEXT_ZONES_SOURCE?.startsWith(os.tmpdir())) fs.rmSync(env.NEXT_ZONES_SOURCE, { recursive: true, force: true });
  const logErrors = fs.readFileSync("zones.log", "utf8").split("\n").filter((l) => !EXPECTED.test(l));
  const pageErrors = /"errors":\s*\[\s*"/.test(output) ? 1 : 0;          // any non-empty "errors" list
  const wrong = /"wrong":\s*\{\s*"/.test(output) ? 1 : 0;                // any non-empty "wrong" map
  const ok = code === 0 && !pageErrors && !wrong && logErrors.length === 0;
  if (!ok) failed++;
  console.log(`${ok ? "✓" : "✗"} ${name.padEnd(16)}${ok ? "" : ` exit ${code}${pageErrors ? ", page errors" : ""}${wrong ? ", wrong responses" : ""}${logErrors.length ? `, Zones log: ${logErrors.slice(0, 2).join(" | ")}` : ""}`}`);
  if ((!ok && process.env.VERBOSE) || process.env.SHOW) console.log(output.slice(0, 4000));
  /* A failed check's output and Zones' log are kept, so a failure seen once can still be read (check-logs/). */
  if (!ok) {
    fs.mkdirSync("check-logs", { recursive: true });
    const stamp = new Date().toISOString().replace(/[:.]/g, "-");
    fs.writeFileSync(path.join("check-logs", `${name}-${stamp}.log`), `${output}\n--- zones.log ---\n${fs.existsSync("zones.log") ? fs.readFileSync("zones.log", "utf8") : ""}`);
  }
}
console.log(failed ? `${failed} of ${chosen.length} failed` : `all ${chosen.length} passed`);
process.exit(failed ? 1 : 0);
