/* drain.cjs on a real HTTP server, with Zones' own endpoints (endpoints.cjs) for health and events. */
import { test } from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import http from "node:http";
import net from "node:net";
import os from "node:os";
import path from "node:path";
import { once } from "node:events";
import { createRequire } from "node:module";

const require = createRequire(import.meta.url);
const { closing, createDrain, stopOnSignal } = require("../src/zones/drain.cjs");
const { createEndpoints } = require("../src/zones/endpoints.cjs");

/* A Zones in small: endpoints, a request held until `release()` (/slow; /held/<path>, then <path>), and one whose
   answer begins at once (/begun). */
async function serve() {
  const shell = fs.mkdtempSync(path.join(os.tmpdir(), "nz-drain-"));
  const ctx = { options: {}, endpoints: { base: "/_next-zones", events: true, health: true }, listeners: new Set(), inflight: new Set(), closeConnections: false, zones: new Map(), stopped: new Map(), shell, store: shell, draining: false, reclaimed: 0 };
  const endpoints = createEndpoints(ctx, { installer: { boot: () => ({}), describe: () => ({}) } });
  let release;
  const gate = new Promise((r) => (release = r));
  const server = http.createServer(closing(ctx, async (req, res) => {
    let url = new URL(req.url, "http://x");
    if (url.pathname.startsWith("/held/")) { await gate; url = new URL(url.pathname.slice(5), url); }
    if (url.pathname === "/slow") { await gate; return void res.end("slow done"); }
    if (url.pathname === "/begun") { res.writeHead(200, { "content-type": "text/plain" }); res.write("begun "); await gate; return void res.end("done"); }
    if (!(await endpoints.handle(req, res, url))) res.writeHead(404).end();
  }));
  server.keepAliveTimeout = 1000;   // Node's 5 s, shortened: a drain waits for the kept-alive connections to close
  server.listen(0, "127.0.0.1");
  await once(server, "listening");
  let closed = 0;
  const drain = createDrain(ctx, { server: () => server, close: async () => { closed++; } });
  return { ctx, server, drain, release, port: server.address().port, closed: () => closed, done: () => fs.rmSync(shell, { recursive: true, force: true }) };
}
const get = (port, p, agent) => new Promise((resolve, reject) => {
  http.get({ host: "127.0.0.1", port, path: p, agent }, (res) => {
    let body = "";
    res.on("data", (c) => (body += c)).on("end", () => resolve({ status: res.statusCode, connection: res.headers.connection, body }));
  }).on("error", reject);
});
const refused = (port) => new Promise((resolve) => net.connect(port, "127.0.0.1").on("connect", function () { this.destroy(); resolve(false); }).on("error", (e) => resolve(e.code)));
/* A raw connection, every byte it receives kept. */
function raw(port, request) {
  const socket = net.connect(port, "127.0.0.1");
  const state = { text: "", ended: false, socket };
  socket.on("data", (c) => (state.text += c)).on("close", () => (state.ended = true));
  socket.write(request);
  return state;
}
const until = async (fn, ms = 5000) => { const end = Date.now() + ms; while (!fn()) { if (Date.now() > end) throw new Error("timed out"); await new Promise((r) => setTimeout(r, 5)); } };

test("a drain: no new connection, requests in flight answered with Connection: close, health 503, event streams told retry: 1000", async () => {
  const z = await serve();
  assert.equal((await get(z.port, "/_next-zones/health")).status, 200);
  const stream = raw(z.port, "GET /_next-zones/events HTTP/1.1\r\nHost: x\r\n\r\n");
  await until(() => stream.text.includes("event: hello"));
  /* In flight as the drain begins, on kept-alive connections (a proxy's): /slow and a health check, not answered yet;
     /begun, its answer begun. */
  const agent = new http.Agent({ keepAlive: true });
  /* Kept alive and idle as the drain begins (a proxy's pool): a request still sent on it is answered, not lost. */
  const pooled = raw(z.port, "GET /_next-zones/health HTTP/1.1\r\nHost: x\r\n\r\n");
  await until(() => /\r\n0\r\n\r\n$/.test(pooled.text));
  assert.match(pooled.text, /^HTTP\/1\.1 200[\s\S]*connection: keep-alive/i);
  const slow = get(z.port, "/slow", agent), health = get(z.port, "/held/_next-zones/health", agent);
  const busy = raw(z.port, "GET /begun HTTP/1.1\r\nHost: x\r\n\r\n");
  await until(() => busy.text.includes("begun "));
  await new Promise((r) => setTimeout(r, 20));

  const drained = z.drain();
  assert.equal(z.drain(), drained, "a second drain is the first");
  /* The stream ends at once; its connection, kept alive, closes by its keep-alive timeout. */
  await until(() => /retry: 1000\n\n[\s\S]*\r\n0\r\n\r\n$/.test(stream.text));
  /* It stops listening at the first quiet turn of the event loop. */
  await until(() => !z.server.listening);
  assert.equal(await refused(z.port), "ECONNREFUSED", "no new connection");
  pooled.text = "";
  pooled.socket.write("GET /_next-zones/health HTTP/1.1\r\nHost: x\r\n\r\n");
  await until(() => pooled.ended);
  assert.match(pooled.text, /^HTTP\/1\.1 503[\s\S]*connection: close/i, "a request on a connection kept alive before the drain: answered");
  z.release();
  const answered = await slow;
  assert.deepEqual([answered.status, answered.body, answered.connection], [200, "slow done", "close"]);
  const checked = await health;
  assert.deepEqual([checked.status, JSON.parse(checked.body).draining, checked.connection], [503, true, "close"]);
  /* Begun kept-alive before the drain: finished, then its connection, idle, closed by its keep-alive timeout. */
  await until(() => busy.ended);
  assert.match(busy.text, /begun [\s\S]*done/);
  assert.deepEqual({ ...(await drained), ms: 0 }, { streams: 1, ms: 0, timedOut: false });
  assert.equal(z.closed(), 1);
  await until(() => stream.ended);
  agent.destroy();
  z.done();
});

test("connections set up but not accepted yet as the drain begins are answered, not reset", async () => {
  const z = await serve();
  /* Five POSTs on new connections (a proxy's), connected in the next tick; then the loop busy, as in a render, so the
     kernel queues them unaccepted; then the drain, in that same turn. */
  const posts = Array.from({ length: 5 }, (_, i) => raw(z.port, `POST /p${i} HTTP/1.1\r\nHost: x\r\nContent-Length: 2\r\n\r\nhi`));
  for (const p of posts) p.socket.on("error", (e) => (p.error = e.code));
  await new Promise((r) => process.nextTick(r));
  const end = Date.now() + 100;
  while (Date.now() < end);
  const drained = z.drain();
  await until(() => posts.every((p) => p.ended));
  assert.deepEqual(posts.map((p) => p.error ?? p.text.split("\r\n")[0]), Array(5).fill("HTTP/1.1 404 Not Found"));
  assert.equal(await refused(z.port), "ECONNREFUSED");
  await drained;
  z.done();
});

test("a drain's timeout closes the connections still in flight", async () => {
  const z = await serve();
  const hung = raw(z.port, "GET /slow HTTP/1.1\r\nHost: x\r\n\r\n");
  await new Promise((r) => setTimeout(r, 50));
  const started = Date.now();
  const r = await z.drain({ timeoutMs: 150 });
  assert.equal(r.timedOut, true);
  assert.ok(Date.now() - started >= 140);
  await until(() => hung.ended);
  assert.equal(hung.text, "");
  assert.equal(z.closed(), 1);
  z.release();
  z.done();
});

test("events while draining: ended with retry: 1000, no hello", async () => {
  const z = await serve();
  Object.assign(z.ctx, { draining: true, closeConnections: true });
  const r = await get(z.port, "/_next-zones/events");
  assert.equal(r.connection, "close");
  assert.match(r.body, /retry: 1000/);
  assert.doesNotMatch(r.body, /hello/);
  z.server.close();
  z.server.closeAllConnections();
  z.done();
});

test("on a signal: drains, refuses connections for --drain-linger, then exits 0; a second signal exits 1", async () => {
  const z = await serve();
  const exits = [], logs = [];
  const stop = stopOnSignal({ drain: z.drain, timeoutMs: 1000, lingerMs: 300, exit: (code) => exits.push([code, Date.now()]), log: (l) => logs.push(l) });
  const started = Date.now();
  stop.listening();
  stop.signal("SIGTERM");
  await new Promise((r) => setTimeout(r, 150));
  assert.equal(z.ctx.draining, true);
  assert.deepEqual(exits, [], "still lingering");
  assert.equal(await refused(z.port), "ECONNREFUSED", "refusing while it lingers");
  stop.signal("SIGTERM");
  assert.deepEqual(exits.map(([c]) => c), [1], "a second signal exits at once");
  await until(() => exits.length === 2);
  assert.equal(exits[1][0], 0);
  assert.ok(exits[1][1] - started >= 300, `exited after ${exits[1][1] - started} ms`);
  assert.match(logs[0], /SIGTERM, draining \(at most 1000 ms\)/);
  assert.match(logs[1], /drained in \d+ ms \(0 event streams ended\), exiting in 300 ms/);
  z.done();
});

test("a signal before Zones serves exits 0 at once, with nothing drained", () => {
  const exits = [];
  let drains = 0;
  const stop = stopOnSignal({ drain: async () => { drains++; }, timeoutMs: 1000, lingerMs: 300, exit: (c) => exits.push(c), log: () => {} });
  stop.signal("SIGINT");
  assert.deepEqual([exits, drains], [[0], 0]);
});
