/*
 * Nothing of the server reaches a browser: a probe, reusable on any running Zones (BASE, ZONES).
 * Markers live only in server code (fixtures/blog/app/blog/leak: a server-only module, a server action's body, a route
 * handler's code) and in a non-public env variable (NZ_LEAK_SECRET, set by check-all). The probe fetches everything a
 * browser can: every route's HTML and RSC payload (as a navigation and as a prefetch), every script, stylesheet and
 * source map they name, the chunks Zones writes again and a zone's main chunk, Zones' own URLs; and it tries to walk
 * out of the static and public folders (encoded and raw dot segments) to a zone image's server code, zone.json and
 * the store's state. A marker in any response, or a server file served, is a finding. Exit code 1 on any finding;
 * the report is JSON (findings, what was fetched).
 */
import http from "node:http";

const BASE = process.env.LEAK_BASE ?? "http://127.0.0.1:3900";
const ZONES = (process.env.LEAK_ZONES ?? "blog/1,shop/1").split(",");
const MARKERS = ["nz-server-marker-5c1e", "nz-action-marker-91b2", "nz-route-marker-3d77", "nz-env-marker-a8e0"];
/* LEAK_EXTRA_MARKER: a string known to be sent (the probe's own control: it must be found). */
if (process.env.LEAK_EXTRA_MARKER) MARKERS.push(process.env.LEAK_EXTRA_MARKER);
/* Text of a store's server side: a zone image's zone.json, the store's state, a server chunk's runtime. */
const SERVER_TEXT = [/"integrity"\s*:/, /"active"\s*:\s*\{/, /\[turbopack\]_runtime|moduleFactories = new Map\(\)/];

/* A request with the path exactly as given (no URL normalisation), so dot segments reach the server. */
function raw(path, headers = {}) {
  const url = new URL(BASE);
  return new Promise((resolve) => {
    const req = http.request({ host: url.hostname, port: url.port, path, method: "GET", headers }, (res) => {
      const parts = [];
      res.on("data", (c) => parts.push(c));
      res.on("end", () => resolve({ status: res.statusCode, body: Buffer.concat(parts).toString("utf8"), type: res.headers["content-type"] ?? "" }));
    });
    req.on("error", (e) => resolve({ status: 0, body: String(e), type: "" }));
    req.end();
  });
}

const findings = [], fetched = new Map();
const scan = (where, r) => {
  fetched.set(where, r.status);
  for (const m of MARKERS) if (r.body.includes(m)) findings.push({ where, status: r.status, marker: m });
};

/* Routes: the shell's home and about, and every route each installed zone reports. */
const routes = new Set(["/", "/about"]);
for (const z of ZONES) {
  const r = await (await fetch(`${BASE}/_next-zones/images/${z}/install`, { method: "POST" })).json();
  for (const route of r.routes ?? []) routes.add(route.replace(/\[\[?\.\.\.[^\]]+\]\]?/g, "a/b").replace(/\[[^\]]+\]/g, "42"));
}
routes.add("/blog/leak"); routes.add("/blog/leak/api");

/* Pages, as a document, a navigation and a prefetch; the assets they name. */
const assets = new Set();
for (const route of routes) {
  for (const [kind, headers] of [["html", {}], ["rsc", { RSC: "1" }], ["prefetch", { RSC: "1", "Next-Router-Prefetch": "1" }]]) {
    const r = await raw(route, headers);
    scan(`${kind} ${route}`, r);
    for (const m of r.body.matchAll(/\/?_next\/static\/[A-Za-z0-9_./@%-]+?\.(?:js|css)/g)) assets.add(m[0].startsWith("/") ? m[0] : `/${m[0]}`);
    for (const m of r.body.matchAll(/static\/chunks\/[A-Za-z0-9_./@%-]+?\.(?:js|css)/g)) assets.add(`/_next/${m[0]}`);
  }
}
for (const a of assets) {
  const r = await raw(a);
  scan(`asset ${a}`, r);
  for (const m of r.body.matchAll(/static\/chunks\/[A-Za-z0-9_./@%-]+?\.js/g)) assets.add(`/_next/${m[0]}`);   // chunks a chunk loads
  const map = await raw(`${a}.map`);
  if (map.status === 200) scan(`map ${a}.map`, map);
}
for (const p of ["/_next-zones/health", "/_next-zones/debug", "/_next-zones/events"]) {
  const r = await Promise.race([raw(p), new Promise((res) => setTimeout(() => res({ status: -1, body: "", type: "" }), 1500))]);
  scan(`zones ${p}`, r);
}

/* Out of the static and public folders, to a zone image's server side. */
const targets = ["server/app/blog/leak/page.js", "zone.json", "server/app-paths-manifest.json", "../state.json", `${"../".repeat(2)}state.json`, "required-server-files.json"];
const prefixes = ["/_next/static/", "/_next/static/chunks/", "/blog/", "/_next/static/chunks/zone-blog-"];
/* Each repeated 1 to 3 times below. */
const ups = ["../", "%2e%2e/", "%2e%2e%2f", "..%2f", "%2e%2e%5c", "..\\", ".%2e/", "%252e%252e/"];
let walks = 0;
for (const prefix of prefixes) for (const up of ups) for (const depth of [1, 2, 3]) for (const target of targets) {
  const path = prefix + up.repeat(depth) + target;
  const r = await raw(path);
  walks++;
  scan(`walk ${path}`, r);
  if (r.status === 200 && SERVER_TEXT.some((re) => re.test(r.body))) findings.push({ where: `walk ${path}`, status: r.status, served: "server-side file" });
}

/* The page itself works: the server used its secret and the action answers through its id. */
const leakPage = await raw("/blog/leak");
const report = { routes: routes.size, assets: assets.size, walks, pageWorks: /id="leak">(match|no match)</.test(leakPage.body), findings };
const wrong = {};
if (findings.length) wrong.findings = findings.slice(0, 20);
if (!report.pageWorks) wrong.pageWorks = leakPage.status;
console.log(JSON.stringify({ ...report, wrong }, null, 2));
/* The events stream stays open: end here. */
process.exit(Object.keys(wrong).length ? 1 : 0);
