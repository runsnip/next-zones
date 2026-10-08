/*
 * Production builds on a running Zones service, rebuilt on every change (next-zones dev is the development server, with HMR):
 *
 *   next-zones watch <zones dir> <zone> [more zones…] [--url http://127.0.0.1:3000] [--base /_next-zones] [--store <dir>]
 *
 * It installs through Zones' admin endpoints, which the shell declares (zoneConfig({ mount: "/", endpoints: { admin:
 * true } })), under --base.
 *
 * Builds each zone once, then watches the zones dir. A change inside a zone rebuilds that zone; a change in a shared
 * package (any other folder that is not a zone) rebuilds every zone watched. Each build is a version `dev-<time>`,
 * installed on Zones at once, so an open tab gets it through <ZoneUpdates /> and links between zones stay soft. Old
 * dev versions are collected on Zones and removed from the store, keeping the one before for a rollback.
 *
 * The shell is not rebuilt: it is Zones' own build, so a change to it needs `next build` and a restart.
 */
import fs from "node:fs";
import path from "node:path";
import { buildZone } from "./build.mjs";
import { readZone } from "./config.mjs";

const IGNORED = /(^|[\\/])(node_modules|\.next|\.git|\.zones-store|\.zones-cache)([\\/]|$)|\.tsbuildinfo$|~$/;

export async function watch({ zonesDir, zones, url = "http://127.0.0.1:3000", base = "/_next-zones", store }) {
  zonesDir = path.resolve(zonesDir);
  const token = process.env.NEXT_ZONES_ADMIN_TOKEN;
  /* Zones' admin endpoints (the shell declares endpoints: { admin: true }). */
  const admin = (route, params = {}) => fetch(`${url}${base}/${route}?${new URLSearchParams(params)}`, {
    method: "POST", headers: token ? { authorization: `Bearer ${token}` } : {},
  }).then(async (res) => ({ ok: res.ok, body: await res.json() }));
  const storeDir = path.resolve(store ?? process.env.NEXT_ZONES_STORE ?? path.join(zonesDir, ".zones-store"));

  /* What each top-level folder is: a watched zone, the shell or another zone (ignored), or a shared package. */
  const kinds = new Map();
  for (const entry of fs.readdirSync(zonesDir, { withFileTypes: true })) {
    if (!entry.isDirectory() || entry.name.includes("@") || entry.name.startsWith(".") || entry.name === "node_modules") continue;
    const zone = await readZone(path.join(zonesDir, entry.name)).catch(() => null);
    kinds.set(entry.name, zone ? (zones.includes(entry.name) ? "zone" : zone.mount === "/" ? "shell" : "other") : "shared");
  }
  for (const name of zones) {
    if (kinds.get(name) !== "zone") throw new Error(`${name}: not a zone of ${zonesDir}${kinds.get(name) === "shell" ? " (the shell is Zones' own build)" : ""}`);
  }

  const pending = new Set(zones);
  let running = false, timer = null;
  async function run() {
    if (running) return;
    running = true;
    while (pending.size) {
      const name = pending.values().next().value;
      pending.delete(name);
      const version = `dev-${Date.now().toString(36)}`;
      const started = performance.now();
      try {
        await buildZone({ zonesDir, zone: name, version, store: storeDir, quiet: true });
        const built = performance.now();
        const installed = await admin(`items/${name}/${version}/install`);
        if (!installed.ok) throw new Error(installed.body.refused ?? installed.body.failed ?? installed.body.error ?? "install failed");
        console.log(`✓ ${name} ${version}: built in ${((built - started) / 1000).toFixed(1)} s, installed in ${(performance.now() - built).toFixed(0)} ms`);
        const collected = await admin("collect", { keep: "1" });
        for (const key of collected.body.removed ?? []) {
          const [zone, v] = key.split("@");
          if (v.startsWith("dev-")) fs.rmSync(path.join(storeDir, zone, v), { recursive: true, force: true });
        }
      } catch (error) {
        console.error(`✗ ${name} ${version}: ${error.message}`);
      }
    }
    running = false;
  }

  fs.watch(zonesDir, { recursive: true }, (event, file) => {
    if (!file || IGNORED.test(file)) return;
    const top = file.split(/[\\/]/)[0];
    const kind = kinds.get(top);
    if (kind === "zone") pending.add(top);
    else if (kind === "shared") for (const z of zones) pending.add(z);
    else if (kind === "shell") { console.log(`• ${file}: the shell changed; rebuild it and restart Zones`); return; }
    else return;
    clearTimeout(timer);
    timer = setTimeout(run, 300);
  });
  console.log(`next-zones watch: watching ${zones.join(", ")} in ${zonesDir}, installing on ${url}`);
  await run();
}
