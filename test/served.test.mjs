/* <base>/served (endpoints.cjs): the zones serving now, public, and only those. */
import { test } from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import http from "node:http";
import os from "node:os";
import path from "node:path";
import { once } from "node:events";
import { createRequire } from "node:module";

const require = createRequire(import.meta.url);
const { createEndpoints } = require("../src/zones/endpoints.cjs");

async function serve(declared) {
  const shell = fs.mkdtempSync(path.join(os.tmpdir(), "nz-served-"));
  const ctx = { options: { adminToken: "secret" }, endpoints: declared, listeners: new Set(), zones: new Map(), stopped: new Map(), shell, store: shell, draining: false, reclaimed: 0 };
  const endpoints = createEndpoints(ctx, { installer: { boot: () => ({ lenkit: { version: "3", ok: false, error: "broken" } }), describe: () => ({}) } });
  const server = http.createServer(async (req, res) => { if (!(await endpoints.handle(req, res, new URL(req.url, "http://x")))) res.writeHead(404).end(); });
  server.listen(0, "127.0.0.1");
  await once(server, "listening");
  return { ctx, port: server.address().port, done: () => { server.close(); fs.rmSync(shell, { recursive: true, force: true }); } };
}
const get = (port, p, headers = {}) => new Promise((resolve, reject) => {
  http.get({ host: "127.0.0.1", port, path: p, headers }, (res) => {
    let body = "";
    res.on("data", (c) => (body += c)).on("end", () => resolve({ status: res.statusCode, headers: res.headers, body }));
  }).on("error", reject);
});

test("served: the serving zones only (not stopped, not failed), name, mount and aliases, no versions, no token needed", async () => {
  const z = await serve({ base: "/_next-zones", events: true, health: false, admin: true });
  z.ctx.zones.set("docx", { name: "docx", version: "7", buildId: "d", mount: "/docx", aliases: [] });
  z.ctx.zones.set("code", { name: "code", version: "12", buildId: "c", mount: "/code", aliases: [{ source: "/p/:slug", destination: "/code/p/:slug" }] });
  z.ctx.stopped.set("twin", { name: "twin", version: "2", buildId: "t", mount: "/twin", aliases: [] });
  const first = await get(z.port, "/_next-zones/served");
  assert.equal(first.status, 200);
  assert.match(first.headers["content-type"], /application\/json/);
  assert.equal(first.headers["cache-control"], "no-cache");
  assert.deepEqual(JSON.parse(first.body), { zones: [
    { name: "code", mount: "/code", aliases: ["/p/:slug"] },
    { name: "docx", mount: "/docx", aliases: [] },
  ] });
  assert.ok(!first.body.includes("\"version\""), "no versions");

  /* Unchanged: a 304 on the ETag. Once a zone stops (or another installs), the tag moves and the list follows. */
  assert.equal((await get(z.port, "/_next-zones/served", { "if-none-match": first.headers.etag })).status, 304);
  z.ctx.stopped.set("docx", z.ctx.zones.get("docx"));
  z.ctx.zones.delete("docx");
  const after = await get(z.port, "/_next-zones/served", { "if-none-match": first.headers.etag });
  assert.equal(after.status, 200);
  assert.notEqual(after.headers.etag, first.headers.etag);
  assert.deepEqual(JSON.parse(after.body).zones.map((zone) => zone.name), ["code"]);
  z.done();
});

test("served is the events group's: not served when events are not declared", async () => {
  const z = await serve({ base: "/_next-zones", events: false, health: true, admin: false });
  z.ctx.zones.set("code", { name: "code", version: "1", mount: "/code", aliases: [] });
  assert.equal((await get(z.port, "/_next-zones/served")).status, 404);
  z.done();
});
