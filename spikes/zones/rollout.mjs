/*
 * A rolling deploy, as `next-zones serve` lives through one: Zones processes of its own (the CLI, blog 1 on one, blog 2
 * on the other, each counting what it is sent: rollout-count.cjs), stopped by SIGTERM.
 * - Zones alone: a POST whose body is still arriving when the drain begins is answered once, 200 with its body, with
 *   Connection: close; a new connection is refused meanwhile; the process lingers (--drain-linger), then exits 0.
 * - Behind nginx (Docker, a container of its own; the directives of infra/nginx/default.conf.template that a rolling
 *   deploy relies on), over the two: the second warmed through nginx, then POSTs sent without pause while the first
 *   drains and exits are each answered 200 once, and each reached one Zones once (never sent again), with no 5xx in
 *   nginx's log.
 * - In Chromium, a tab on blog 1 through nginx, with <ZoneUpdates />: the drain ends its event stream, it reconnects
 *   through nginx to the Zones that stays, whose `hello` names another build, and the tab refreshes in the same
 *   document to blog 2.
 * Without Docker, the nginx part and the tab are reported as skipped.
 */
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import net from "node:net";
import { spawn, spawnSync, execFileSync } from "node:child_process";
import { createRequire } from "node:module";

const require = createRequire(import.meta.url);
const { chromium } = require("playwright");
const scale = Number(process.env.TIMEOUT_SCALE ?? 1);
const tmp = fs.mkdtempSync(path.join(os.tmpdir(), "nz-rollout-"));
const counts = path.join(tmp, "counts.jsonl");
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const until = async (fn, ms, what) => { const end = Date.now() + ms * scale; for (;;) { const v = await fn().catch(() => null); if (v) return v; if (Date.now() > end) throw new Error(`timed out: ${what}`); await sleep(100); } };
const seen = {}, wrong = {}, errors = [];
const procs = new Set();
let nginx = null;

/* A store with one version of blog, pinned. */
function store(name, version) {
  const dir = path.join(tmp, name);
  fs.cpSync(path.join(".zones-store", "blog", version), path.join(dir, "store", "blog", version), { recursive: true, verbatimSymlinks: true });
  fs.writeFileSync(path.join(dir, "zones.json"), JSON.stringify({ zones: { blog: version } }));
  return dir;
}
function zones(dir, port) {
  const out = fs.openSync(path.join(dir, "out.log"), "a");
  const child = spawn(process.execPath, ["../../src/cli.mjs", "serve", "--shell", "shell", "--store", path.join(dir, "store"), "--cache", path.join(dir, "cache"),
    "--pins", path.join(dir, "zones.json"), "--port", String(port), "--host", "127.0.0.1", "--no-prune", "--drain-linger", "1500"],
  { stdio: ["ignore", out, out], env: { ...process.env, NODE_OPTIONS: `--require ${path.resolve("rollout-count.cjs")}`, NZ_COUNT_LOG: counts } });
  child.exited = new Promise((resolve) => child.once("exit", (code) => { procs.delete(child); resolve({ code, at: Date.now() }); }));
  procs.add(child);
  child.log = () => fs.readFileSync(path.join(dir, "out.log"), "utf8");
  child.healthy = () => until(async () => (await fetch(`http://127.0.0.1:${port}/_next-zones/health`)).ok, 180_000, `Zones on :${port}`);
  return child;
}
const lines = () => (fs.existsSync(counts) ? fs.readFileSync(counts, "utf8").trim().split("\n").filter(Boolean).map((l) => JSON.parse(l)) : []);
const refused = (port) => new Promise((resolve) => net.connect(port, "127.0.0.1").on("connect", function () { this.destroy(); resolve(false); }).on("error", (e) => resolve(e.code)));
/* A raw HTTP exchange: what was sent, and everything received until the connection closed. */
function exchange(port) {
  const socket = net.connect(port, "127.0.0.1");
  const state = { text: "", closed: false, socket };
  socket.on("data", (c) => (state.text += c)).on("close", () => (state.closed = true)).on("error", () => {});
  return state;
}

try {
  const a = store("a", "1"), b = store("b", "2");

  /* Zones alone: a POST in flight as the drain begins. */
  let zonesA = zones(a, 3911);
  await zonesA.healthy();
  const body = JSON.stringify({ n: "inflight", pad: "x".repeat(2000) });
  const post = exchange(3911);
  post.socket.write(`POST /blog/api/inflight HTTP/1.1\r\nHost: x\r\nContent-Type: application/json\r\nContent-Length: ${Buffer.byteLength(body)}\r\n\r\n${body.slice(0, 1000)}`);
  await until(async () => lines().some((l) => l.url === "/blog/api/inflight" && l.what === "in"), 10_000, "the POST received");
  const termAt = Date.now();
  zonesA.kill("SIGTERM");
  await until(async () => /draining/.test(zonesA.log()), 10_000, "the drain began");
  /* It stops listening at the first quiet turn of its event loop, within 5 s. */
  seen.refusedWhileDraining = await until(async () => (await refused(3911)) || null, 6000, "refusing").catch(() => "accepted");
  post.socket.write(body.slice(1000));
  await until(async () => post.closed, 20_000, "the POST answered");
  const exited = await zonesA.exited;
  const drained = /drained in (\d+) ms .*exiting in 1500 ms/.exec(zonesA.log());
  const received = lines().filter((l) => l.url === "/blog/api/inflight");
  seen.zonesAlone = {
    status: /^HTTP\/1\.1 (\d+)/.exec(post.text)?.[1], connection: /\r\nconnection: ([^\r]+)/i.exec(post.text)?.[1], echoed: post.text.includes('"n":"inflight"'),
    answers: post.text.match(/^HTTP\/1\.1 /gm)?.length ?? 0, received: received.filter((l) => l.what === "in").length, exitCode: exited.code,
    exitAfterTermMs: exited.at - termAt, drainedLogged: Boolean(drained),
  };
  const za = seen.zonesAlone;
  if (za.status !== "200" || za.connection?.toLowerCase() !== "close" || !za.echoed || za.answers !== 1 || za.received !== 1) wrong.zonesAlone = za;
  if (seen.refusedWhileDraining !== "ECONNREFUSED") wrong.refusedWhileDraining = seen.refusedWhileDraining;
  if (za.exitCode !== 0 || !za.drainedLogged || za.exitAfterTermMs < 1500) wrong.linger = za;

  let docker = true;
  try { execFileSync("docker", ["version", "--format", "{{.Server.Version}}"], { stdio: "ignore", timeout: 15_000 }); } catch { docker = false; }
  if (!docker) seen.nginx = "skipped: no Docker";
  else {
    /* nginx in front of both, as the RunSnip deploy has it (infra/nginx/default.conf.template). The host by its IPv4
       address only: its name (host-gateway, host.docker.internal) also has an IPv6 one, which nginx would balance
       over too, unreachable. */
    const host = /^(\S+)/.exec(execFileSync("docker", ["run", "--rm", "--add-host", "probe:host-gateway", "nginx:1.29-alpine", "getent", "ahostsv4", "probe"], { encoding: "utf8" }))[1];
    const conf = path.join(tmp, "default.conf");
    fs.writeFileSync(conf, `log_format spike '$request_method $request_uri $status ua=$upstream_addr us=$upstream_status';
access_log /dev/stdout spike;
upstream zones_upstream {
  zone zones_upstream 64k;
  server ${host}:3911 max_fails=1 fail_timeout=10s;
  server ${host}:3912 max_fails=1 fail_timeout=10s;
  keepalive 16;
  keepalive_timeout 4s;
}
proxy_http_version 1.1;
proxy_set_header Connection "";
proxy_set_header Host $host;
proxy_next_upstream error timeout http_502 http_503;
proxy_next_upstream_tries 2;
proxy_next_upstream_timeout 10s;
proxy_connect_timeout 1s;
server {
  listen 80;
  location = /_next-zones/events { proxy_buffering off; proxy_read_timeout 1h; proxy_pass http://zones_upstream; }
  location / { proxy_pass http://zones_upstream; add_header X-Upstream $upstream_addr always; }
}
`);
    const name = `nz-rollout-spike-${process.pid}`;
    nginx = name;
    execFileSync("docker", ["run", "-d", "--rm", "--name", name, "-p", "127.0.0.1:3913:80", "-v", `${conf}:/etc/nginx/conf.d/default.conf:ro`, "nginx:1.29-alpine"], { stdio: "ignore" });
    const BASE = "http://127.0.0.1:3913";
    zonesA = zones(a, 3911);
    await zonesA.healthy();
    await until(async () => (await fetch(`${BASE}/_next-zones/health`)).ok, 30_000, "nginx");

    /* The tab, on blog 1 (the only Zones yet), its event stream open. */
    const browser = await chromium.launch();
    const page = await browser.newPage();
    page.on("pageerror", (e) => errors.push(e.message));
    const hellos = [];
    page.on("request", (r) => { if (r.url().endsWith("/_next-zones/events")) hellos.push(Date.now()); });
    seen.tabStatus = (await page.goto(`${BASE}/blog`))?.status();
    seen.tabBefore = await page.textContent("#title");
    await page.evaluate(() => { window.__rolloutMarker = "kept"; });

    /* The second Zones, blog 2; healthy, then nginx's fail_timeout outlived (it was marked down while it booted).
       Then warmed through nginx until it has answered there: past fail_timeout nginx sends a server marked down one
       request, and leaves it out until that one succeeds; were the first Zones refusing meanwhile, nginx would have
       no live server (measured: 17 POSTs answered 502, a cold route at load 50). A rolling deploy needs this step. */
    const zonesB = zones(b, 3912);
    await zonesB.healthy();
    await sleep(11_000);
    await until(async () => (await fetch(`${BASE}/blog/api/warm`)).headers.get("x-upstream")?.endsWith(":3912"), 60_000, "the second Zones answering through nginx");

    /* POSTs through nginx without pause, eight at a time, while the first Zones drains, lingers and exits. */
    let n = 0, stop = false;
    const answers = [];
    const worker = async () => {
      while (!stop) {
        const id = `p${n++}`;
        const r = await fetch(`${BASE}/blog/api/${id}`, { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ id }) })
          .then(async (res) => ({ id, status: res.status, echoed: (await res.text()).includes(`"id":"${id}"`) }), (e) => ({ id, status: 0, error: String(e.cause?.code ?? e.message) }));
        answers.push(r);
      }
    };
    const workers = Array.from({ length: 8 }, worker);
    await sleep(1000);
    const termA = Date.now();
    seen.termAt = termA;
    zonesA.kill("SIGTERM");
    const exitA = await zonesA.exited;
    await sleep(2000);
    stop = true;
    await Promise.all(workers);
    const posts = lines().filter((l) => l.method === "POST" && /^\/blog\/api\/p\d+$/.test(l.url));
    const received = new Map();
    for (const l of posts.filter((l) => l.what === "in")) received.set(l.url, (received.get(l.url) ?? 0) + 1);
    const byA = posts.filter((l) => l.pid === zonesA.pid);
    const inA = new Map(byA.filter((l) => l.what === "in").map((l) => [l.url, l.t]));
    const inFlight = byA.filter((l) => l.what === "out" && l.t > termA && inA.get(l.url) < termA).length;
    /* nginx's access log is the container's stdout, its error log its stderr. */
    const logs = spawnSync("docker", ["logs", name], { encoding: "utf8" }), log = `${logs.stdout}\n${logs.stderr}`;
    if (process.env.KEEP) fs.writeFileSync(path.join(tmp, "nginx.log"), log);
    const nginxLines = log.split("\n").filter((l) => /^(GET|POST|HEAD) /.test(l));
    seen.nginx = {
      posts: answers.length, ok: answers.filter((r) => r.status === 200 && r.echoed).length,
      failed: answers.filter((r) => r.status !== 200 || !r.echoed).slice(0, 5),
      receivedOnce: [...received.values()].filter((c) => c === 1).length, receivedTwice: [...received].filter(([, c]) => c > 1).map(([u]) => u).slice(0, 5),
      neverReceived: answers.filter((r) => !received.has(`/blog/api/${r.id}`)).length,
      byLeaving: byA.filter((l) => l.what === "in").length, inFlightAtDrain: inFlight,
      retriedByNginx: nginxLines.filter((l) => /^POST .* ua=\S+, /.test(l)).length,
      nginx5xx: nginxLines.filter((l) => / 5\d\d ua=/.test(l)).slice(0, 5),
      nginxErrors: log.split("\n").filter((l) => /\[(error|warn)\]/.test(l)).map((l) => l.replace(/^.*?\[(error|warn)\] \S+ /, "").replace(/, client: .*?(, upstream)/, "$1")).slice(0, 8),
      leavingExit: exitA.code, leavingMs: exitA.at - termA,
    };
    const s = seen.nginx;
    if (s.ok !== s.posts || s.receivedOnce !== s.posts || s.receivedTwice.length || s.neverReceived || s.nginx5xx.length || s.leavingExit !== 0 || !s.byLeaving) wrong.nginx = s;

    /* The tab: its stream ended by the drain, reconnected through nginx to blog 2's Zones, refreshed in place. */
    seen.tabAfter = await until(async () => { const t = await page.textContent("#title"); return t.includes("v2") ? t : null; }, 30_000, "the tab refreshed").catch(() => page.textContent("#title"));
    seen.tabSameDocument = (await page.evaluate(() => window.__rolloutMarker)) === "kept";
    seen.eventStreams = hellos.length;
    if (seen.tabBefore !== "zone blog v1" || seen.tabAfter !== "zone blog v2" || !seen.tabSameDocument || seen.eventStreams < 2) wrong.tab = { before: seen.tabBefore, after: seen.tabAfter, sameDocument: seen.tabSameDocument, eventStreams: seen.eventStreams };
    await browser.close();
    zonesB.kill("SIGTERM");
    await zonesB.exited;
  }
} catch (error) {
  wrong.error = String(error.stack ?? error);
} finally {
  for (const p of procs) p.kill("SIGKILL");
  if (nginx) try { execFileSync("docker", ["rm", "-f", nginx], { stdio: "ignore" }); } catch {}
  if (process.env.KEEP) console.error(`kept: ${tmp}`); else fs.rmSync(tmp, { recursive: true, force: true });
}
if (errors.length) wrong.errors = errors;
console.log(JSON.stringify({ seen, wrong }, null, 2));
if (Object.keys(wrong).length) process.exit(1);
