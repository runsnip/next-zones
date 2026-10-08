/*
 * A zone stored away from the build: its server-external package is reached through an absolute symlink to the build
 * machine, made broken here as on another machine. Zones resolves the zone's externals from the shell's
 * node_modules, so the page still renders. And a zone built with another React is refused.
 */
import fs from "node:fs";
import os from "node:os";
import path from "node:path";

const BASE = "http://127.0.0.1:3900";
const store = process.env.NEXT_ZONES_STORE;
if (!store) throw new Error("run with NEXT_ZONES_STORE pointing at a copy of the store outside the workspace");
const links = path.join(store, "blog", "1", "node_modules", "@spike");
for (const link of fs.readdirSync(links)) { fs.rmSync(path.join(links, link)); fs.symlinkSync("/nonexistent/build-machine/node_modules/@spike/ext", path.join(links, link)); }
const other = path.join(store, "blog", "9");
fs.cpSync(path.join(store, "blog", "1"), other, { recursive: true, verbatimSymlinks: true });
const zoneJson = JSON.parse(fs.readFileSync(path.join(other, "zone.json"), "utf8"));
fs.writeFileSync(path.join(other, "zone.json"), JSON.stringify({ ...zoneJson, version: "9", built: { ...zoneJson.built, react: "19.2.0" } }));

await fetch(`${BASE}/_next-zones/images/blog/1/install`, { method: "POST" });
const res = await fetch(`${BASE}/blog/ext`);
const html = await res.text();
const refused = await (await fetch(`${BASE}/_next-zones/images/blog/9/install`, { method: "POST" })).json();
fs.rmSync(other, { recursive: true, force: true });
console.log(JSON.stringify({ externalOnAnotherMachine: { status: res.status, rendered: html.includes("from an external package") }, otherReact: refused, store: store.startsWith(os.tmpdir()) || store }, null, 2));
