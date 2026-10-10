/*
 * Stopping a zone: its URLs answer the shell's 404, marked x-next-zones-state: stopped and x-next-zones-zone, and in
 * Server-Timing, which the shell's not-found page (static) reads in the browser with useZoneState(); it stays installed,
 * and resuming serves it again with no install. Over HTTP: <base>/zones lists every zone and its state; blog stopped answers 404 on its mount, its alias
 * (/post/7), an RSC request, a POST, and a URL the shell's proxy rewrites into it (/b/42, on the second Zones); its static chunks are still
 * served; shop and the shell serve as before; a 404 elsewhere is not marked, and a client cannot mark one. Stopping
 * twice changes nothing. A version installed while blog is stopped stays stopped, and serves once resumed. wiki (Pages
 * Router) stopped answers 404 on its pages and its /_next/data. In a browser: a tab on the shell soft-navigates into
 * blog, blog is stopped, and the tab's next navigation into blog shows the shell's not-found with the state; a page
 * load of a stopped URL shows it too, the address bar keeping the URL; a plain 404 shows no state. Then
 * persistence: a Zones of its own on a copy of the store, blog stopped, restarted: blog is still stopped.
 */
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { spawn } from "node:child_process";
import http from "node:http";
import { createRequire } from "node:module";

const require = createRequire(import.meta.url);
const { chromium } = require("playwright");
const BASE = "http://127.0.0.1:3900";
const post = (p) => fetch(BASE + p, { method: "POST" }).then(async (r) => ({ status: r.status, body: await r.json() }));
const zones = async (base = BASE) => (await (await fetch(`${base}/_next-zones/zones`)).json()).zones;
const get = async (p, init) => {
  const r = await fetch(BASE + p, { redirect: "manual", ...init });
  const text = (await r.text()).replace(/<!-- -->/g, "");
  return {
    status: r.status, state: r.headers.get("x-next-zones-state"), zone: r.headers.get("x-next-zones-zone"), timing: r.headers.get("server-timing"),
    says: /zone-state">([^<]*)</.exec(text)?.[1] ?? (/zone blog v\d/.exec(text)?.[0] ?? (/could not be found/.test(text) ? "404 page" : text.slice(0, 40))),
    type: r.headers.get("content-type")?.split(";")[0],
  };
};
/* /b/… through the shell's proxy, which rewrites it into blog. A rewrite to a URL no route serves (blog's, once it is
   stopped) Next proxies over HTTP, back to Zones, which marks it; that proxying warns of 11 close listeners on the
   response (Next's own, as for any such rewrite: /b/zz/qq/rr with blog serving does the same), so it is asked of the
   second Zones below, whose log the check does not read. */
const viaProxy = (base, p) => new Promise((resolve, reject) => {
  const { hostname, port } = new URL(base);
  http.get({ host: hostname, port, path: p }, (res) => {
    let text = "";
    res.on("data", (c) => (text += c)).on("end", () => resolve({
      status: res.statusCode, state: res.headers["x-next-zones-state"] ?? null, zone: res.headers["x-next-zones-zone"] ?? null, timing: res.headers["server-timing"] ?? null,
      says: /could not be found/.test(text) ? "404 page" : text.slice(0, 40),
    }));
  }).on("error", reject);
});
const seen = {};
const wrong = {};

seen.installs = [];
for (const [zone, v] of [["blog", "1"], ["shop", "1"], ["wiki", "1"]]) seen.installs.push((await post(`/_next-zones/images/${zone}/${v}/install`)).status);
seen.before = await zones();
/* A chunk of blog's, from its page, fetched again once blog is stopped. */
const blogHtml = await (await fetch(`${BASE}/blog`)).text();
const chunk = [...blogHtml.matchAll(/src="(\/_next\/static\/[^"]+\.js)"/g)].map((m) => m[1]).find((u) => !fs.existsSync(path.join("shell", ".next", u.replace("/_next/", ""))));

const stop = await post("/_next-zones/zones/blog/stop");
seen.stop = stop;
seen.stopAgain = await post("/_next-zones/zones/blog/stop");
seen.stopped = {
  "/blog": await get("/blog"),
  "/blog/42": await get("/blog/42"),
  "/post/7": await get("/post/7"),
  "/blog (RSC)": await get("/blog", { headers: { rsc: "1" } }),
  "/blog (POST)": await get("/blog/42", { method: "POST" }),
};
seen.others = { "/shop": (await get("/shop")).status, "/": (await get("/")).status, "/nothing": await get("/nothing"), spoofed: await get("/nothing", { headers: { "x-next-zones-state": "stopped", "x-next-zones-zone": "shop" } }) };
seen.chunk = chunk ? (await fetch(BASE + chunk)).status : "no chunk found";
seen.listed = await zones();

/* Installed while stopped: blog 2 stays stopped, then serves once resumed. */
seen.installStopped = (await post("/_next-zones/images/blog/2/install")).body.state;
seen.afterInstall = { page: await get("/blog"), listed: (await zones()).blog };
seen.resume = (await post("/_next-zones/zones/blog/resume")).body;
seen.resumed = { "/blog": await get("/blog"), "/post/7": (await get("/post/7")).status, listed: (await zones()).blog };

/* wiki, on the Pages Router: its pages and its data. */
const wikiBuildId = fs.readFileSync(path.join(".zones-store", "wiki", "1", "BUILD_ID"), "utf8").trim();
const wikiData = `/_next/data/${wikiBuildId}/wiki.json`;
seen.wikiBefore = { "/wiki": (await get("/wiki")).status, data: (await get(wikiData)).status };
await post("/_next-zones/zones/wiki/stop");
seen.wikiStopped = { "/wiki": await get("/wiki"), data: await get(wikiData) };
await post("/_next-zones/zones/wiki/resume");
seen.wikiResumed = { "/wiki": (await get("/wiki")).status, data: (await get(wikiData)).status };

/* In a browser: a tab soft-navigates into blog, blog is stopped, its next navigation into blog shows the not-found. */
const browser = await chromium.launch();
const page = await browser.newPage();
const errors = [];
page.on("pageerror", (e) => errors.push(e.message));
await page.goto(`${BASE}/`);
await page.click("#to-blog");
await page.waitForSelector("#title >> text=/zone blog v2/");
await page.click("#blog-to-shop");
await page.waitForSelector("#title >> text=/shop/");
await post("/_next-zones/zones/blog/stop");
await page.waitForTimeout(300);
await page.click("#to-item");
await page.waitForSelector("#zone-state", { timeout: 10_000 }).catch(() => {});
seen.browser = { state: (await page.textContent("#zone-state").catch(() => null))?.trim(), url: new URL(page.url()).pathname };
/* A page load of a stopped URL, and a plain 404. */
await page.goto(`${BASE}/post/7?x=1`);
await page.waitForSelector("#zone-state", { timeout: 10_000 }).catch(() => {});
seen.browser.load = { state: (await page.textContent("#zone-state").catch(() => null))?.trim(), url: new URL(page.url()).pathname + new URL(page.url()).search };
await page.goto(`${BASE}/nothing`);
await page.waitForTimeout(500);
seen.browser.plain = (await page.textContent("#zone-state").catch(() => null)) ?? null;
seen.browser.errors = errors;
await browser.close();
await post("/_next-zones/zones/blog/resume");

/* Persistence: blog stopped in a Zones of its own, which restarts. */
const store = fs.mkdtempSync(path.join(os.tmpdir(), "nz-stop-store-"));
for (const zone of ["blog", "shop"]) fs.cpSync(path.join(".zones-store", zone, "1"), path.join(store, zone, "1"), { recursive: true, verbatimSymlinks: true });
const OWN = "http://127.0.0.1:3901";
const startOwn = async () => {
  const child = spawn(process.execPath, ["zones.cjs"], { env: { ...process.env, PORT: "3901", NEXT_ZONES_STORE: store, NEXT_ZONES_PERSIST: "on" }, stdio: "ignore" });
  for (let i = 0; i < 120; i++) { try { await fetch(`${OWN}/_next-zones/health`); return child; } catch { await new Promise((r) => setTimeout(r, 250)); } }
  throw new Error("the second Zones did not start");
};
let own = await startOwn();
await fetch(`${OWN}/_next-zones/images/blog/1/install`, { method: "POST" });
await fetch(`${OWN}/_next-zones/zones/blog/stop`, { method: "POST" });
own.kill();
await new Promise((r) => own.once("exit", r));
own = await startOwn();
seen.persisted = { state: (await zones(OWN)).blog?.state, status: (await fetch(`${OWN}/blog`)).status, file: JSON.parse(fs.readFileSync(path.join(store, "state.json"), "utf8")).stopped };
seen.stopped["/b/42 (the proxy's rewrite)"] = await viaProxy(OWN, "/b/42");
await fetch(`${OWN}/_next-zones/zones/blog/resume`, { method: "POST" });
seen.persistedResumed = (await fetch(`${OWN}/blog`)).status;
own.kill();
await new Promise((r) => own.once("exit", r));
fs.rmSync(store, { recursive: true, force: true });

/* What should hold. */
const marked = (r, zone) => r.status === 404 && r.state === "stopped" && r.zone === zone && r.timing === `next-zones-state;desc="stopped", next-zones-zone;desc="${zone}"`;
if (seen.installs.some((s) => s !== 200)) wrong.installs = seen.installs;
if (seen.before.blog?.state !== "serving" || seen.before.blog?.mount !== "/blog" || seen.before.docs?.state !== "available") wrong.before = seen.before;
if (stop.status !== 200 || stop.body.state !== "stopped" || stop.body.changed !== true) wrong.stop = stop;
if (seen.stopAgain.body.changed !== false) wrong.stopAgain = seen.stopAgain;
for (const [p, r] of Object.entries(seen.stopped)) {
  const html = !p.includes("RSC") && !p.includes("POST");
  if (!marked(r, "blog") || (html && r.says !== "404 page") || (p.includes("RSC") && r.type !== "text/x-component")) wrong[p] = r;
}
if (seen.others["/shop"] !== 200 || seen.others["/"] !== 200) wrong.others = seen.others;
if (seen.others["/nothing"].status !== 404 || seen.others["/nothing"].state || seen.others["/nothing"].says !== "404 page") wrong.nothing = seen.others["/nothing"];
if (seen.others.spoofed.state || seen.others.spoofed.says !== "404 page") wrong.spoofed = seen.others.spoofed;
if (seen.chunk !== 200) wrong.chunk = { chunk, status: seen.chunk };
if (seen.listed.blog?.state !== "stopped" || !seen.listed.blog?.since || seen.listed.shop?.state !== "serving") wrong.listed = seen.listed;
if (seen.installStopped !== "stopped" || !marked(seen.afterInstall.page, "blog") || seen.afterInstall.listed?.version !== "2" || seen.afterInstall.listed?.state !== "stopped" || seen.afterInstall.listed?.previous !== "1") wrong.afterInstall = { installStopped: seen.installStopped, ...seen.afterInstall };
if (seen.resume.state !== "serving" || seen.resumed["/blog"].status !== 200 || seen.resumed["/blog"].says !== "zone blog v2" || seen.resumed["/blog"].state || seen.resumed["/post/7"] !== 200 || seen.resumed.listed?.state !== "serving") wrong.resumed = { resume: seen.resume, ...seen.resumed };
if (seen.wikiBefore["/wiki"] !== 200 || seen.wikiBefore.data !== 200) wrong.wikiBefore = seen.wikiBefore;
if (!marked(seen.wikiStopped["/wiki"], "wiki") || !marked(seen.wikiStopped.data, "wiki")) wrong.wikiStopped = seen.wikiStopped;
if (seen.wikiResumed["/wiki"] !== 200 || seen.wikiResumed.data !== 200) wrong.wikiResumed = seen.wikiResumed;
if (seen.browser.state !== "blog is stopped" || seen.browser.url !== "/blog/42" || seen.browser.load.state !== "blog is stopped" || seen.browser.load.url !== "/post/7?x=1" || seen.browser.plain !== null || seen.browser.errors.length) wrong.browser = seen.browser;
if (seen.persisted.state !== "stopped" || seen.persisted.status !== 404 || JSON.stringify(seen.persisted.file) !== '["blog"]' || seen.persistedResumed !== 200) wrong.persisted = { ...seen.persisted, resumed: seen.persistedResumed };
console.log(JSON.stringify({ ...seen, wrong }, null, 2));
process.exit(0);
