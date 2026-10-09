/*
 * A zone's own node_modules (a package the workspace did not hoist) is reached by `next-zones build`: the zone imports a
 * package that exists only in its own node_modules, is built into the store, installed on Zones and served.
 */
import fs from "node:fs";
import path from "node:path";
import { buildZone } from "../../src/build.mjs";

const BASE = "http://127.0.0.1:3900";
/* Inside this workspace, so inside Turbopack's root, as a zone of a real workspace is. */
const zonesDir = path.resolve(".localdeps");
const zone = path.join(zonesDir, "deps");
const stored = path.join(".zones-store", "deps");
const write = (file, text) => { fs.mkdirSync(path.dirname(path.join(zone, file)), { recursive: true }); fs.writeFileSync(path.join(zone, file), text); };

fs.rmSync(zonesDir, { recursive: true, force: true });
fs.rmSync(stored, { recursive: true, force: true });
write("package.json", JSON.stringify({ name: "zone-deps", private: true }));
write("next.config.mjs", `import { zoneConfig } from "@runsnip/next-zones/config";\nexport default zoneConfig({ mount: "/deps" });\n`);
write("app/layout.tsx", `export default function Layout({ children }) { return <html><body>{children}</body></html>; }\n`);
write("app/deps/page.tsx", `import { marker } from "zone-local-dep";\nexport const dynamic = "force-dynamic";\nexport default function Page() { return <p id="marker">{marker()}</p>; }\n`);
write("node_modules/zone-local-dep/package.json", JSON.stringify({ name: "zone-local-dep", version: "1.0.0", main: "index.js" }));
write("node_modules/zone-local-dep/index.js", `exports.marker = () => "from the zone's own node_modules";\n`);

const wrong = {};
let page = "";
try {
  await buildZone({ zonesDir, zone: "deps", version: "1", store: ".zones-store", quiet: true });
  if (fs.existsSync(path.join(zonesDir, "deps@1"))) wrong.copyLeft = true;
  const installed = await fetch(`${BASE}/_next-zones/images/deps/1/install`, { method: "POST" });
  if (installed.status !== 200) wrong.install = { status: installed.status, body: await installed.text() };
  const response = await fetch(`${BASE}/deps`);
  page = await response.text();
  if (response.status !== 200 || !page.includes("from the zone&#x27;s own node_modules") && !page.includes("from the zone's own node_modules")) wrong.page = { status: response.status, page: page.slice(0, 300) };
} catch (error) {
  wrong.error = String(error.message ?? error);
} finally {
  fs.rmSync(zonesDir, { recursive: true, force: true });
  fs.rmSync(stored, { recursive: true, force: true });
}
console.log(JSON.stringify({ wrong }, null, 2));
process.exit(Object.keys(wrong).length ? 1 : 0);
