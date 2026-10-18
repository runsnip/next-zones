/*
 * The warm-up: Zones listens with the shell's page bundles loaded and its "/" rendered once (a document and an RSC
 * request), and a live install loads the new version's bundles before its switch, so the first request to each route
 * finds its code in Node's module cache. The switch stays a switch (µs).
 */
const BASE = "http://127.0.0.1:3900";
const debug = async () => (await fetch(`${BASE}/_next-zones/debug`)).json();
const wrong = {};

/* At boot: every shell bundle loaded, though only "/" was requested (check-all waits for it). */
const boot = await debug();
if (!boot.warm || boot.warm.failed.length) wrong.report = boot.warm;
if (!boot.bundles || boot.bundles.missing.length || !boot.bundles.total) wrong.bootBundles = boot.bundles;
const rendered = (boot.warm?.routes ?? []).filter((r) => r.path === "/");
if (rendered.length !== 2 || rendered.some((r) => r.status !== 200 || r.error)) wrong.rendered = boot.warm?.routes;

/* A live install: the version's bundles are loaded before any request reaches it. */
const res = await fetch(`${BASE}/_next-zones/images/blog/2/install`, { method: "POST" });
const install = await res.json();
if (!res.ok || typeof install.t?.warm !== "number" || install.warmFailed) wrong.install = install;
if (!(install.t?.activate < 1)) wrong.switch = install.t;                  // ms: the switch only assigns
const after = await debug();
if (after.bundles?.missing.length || after.bundles?.total <= boot.bundles?.total) wrong.installBundles = after.bundles;

/* The first requests to the new version, timed: the code they run is loaded. */
const first = {};
for (const p of ["/blog", "/about"]) { const s = performance.now(); const r = await fetch(BASE + p); await r.arrayBuffer(); first[p] = { status: r.status, ms: +(performance.now() - s).toFixed(1) }; if (r.status !== 200) wrong[p] = first[p]; }

await fetch(`${BASE}/_next-zones/images/blog/1/install`, { method: "POST" });
console.log(JSON.stringify({ warm: { ms: boot.warm?.ms, modules: boot.warm?.modules, routes: boot.warm?.routes }, bundles: { boot: boot.bundles, afterInstall: after.bundles }, install: { t: install.t, blockedMs: install.blockedMs }, first, wrong }, null, 2));
