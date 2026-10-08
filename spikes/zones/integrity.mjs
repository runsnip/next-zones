/*
 * The stored build is checked against the integrity zone.json recorded at build time: a build changed after it was
 * stored (one byte of one server file) is refused and nothing changes, while an intact copy of it installs.
 */
import fs from "node:fs";
import path from "node:path";

const BASE = "http://127.0.0.1:3900";
const store = path.join(".zones-store", "blog");
const install = async (v) => { const r = await fetch(`${BASE}/_next-zones/images/blog/${v}/install`, { method: "POST" }); return { status: r.status, body: await r.json() }; };
const served = async () => (await (await fetch(`${BASE}/blog/api/x`)).json()).version;

for (const v of ["91", "92"]) fs.rmSync(path.join(store, v), { recursive: true, force: true });
fs.cpSync(path.join(store, "1"), path.join(store, "91"), { recursive: true, verbatimSymlinks: true });
fs.cpSync(path.join(store, "1"), path.join(store, "92"), { recursive: true, verbatimSymlinks: true });
/* One byte of one server file changed in 91. */
const victim = path.join(store, "91", "server", "app-paths-manifest.json");
fs.writeFileSync(victim, fs.readFileSync(victim, "utf8").replace("{", "{ "));
try {
  await install("2");
  const changed = await install("91");
  const afterRefusal = await served();
  const intact = await install("92");
  const afterIntact = await served();
  const wrong = {};
  if (changed.status !== 409 || !/differs from the one built/.test(changed.body.refused ?? "")) wrong.changed = changed;
  if (afterRefusal !== "2") wrong.afterRefusal = afterRefusal;
  if (intact.status !== 200) wrong.intact = intact;
  if (afterIntact !== "1") wrong.afterIntact = afterIntact;
  console.log(JSON.stringify({ changed: changed.body.refused ?? changed.body, afterRefusal, intact: intact.status, afterIntact, wrong }, null, 2));
} finally {
  for (const v of ["91", "92"]) fs.rmSync(path.join(store, v), { recursive: true, force: true });
}
