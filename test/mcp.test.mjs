import { test } from "node:test";
import assert from "node:assert/strict";
import http from "node:http";
import crypto from "node:crypto";
import { createRequire } from "node:module";

const require = createRequire(import.meta.url);
const { Mcp, Tools, Tool, LivePull, Skills, Skill, Bearer, OAuth } = require("../src/mcp.cjs");
const { createMcp, validate } = require("../src/zones/mcp.cjs");
const { ZoneError } = require("../src/zones/context.cjs");

const fakeZones = () => {
  const calls = [];
  return {
    calls,
    status: () => ({ ok: true, zones: { blog: "1" } }),
    images: () => ({ blog: [{ version: "1", active: true, livePull: true }], shop: [{ version: "2", active: true, livePull: false }] }),
    pull: async (zone, version) => { calls.push(["pull", zone, version]); if (zone === "shop") throw new ZoneError(`zone "shop" does not allow live pulls`); return { pulledFrom: "dir" }; },
    install: async (zone, version) => { calls.push(["install", zone, version]); return { zone, version, switchUs: 3 }; },
    prune: async () => ({ removed: [] }),
  };
};

/* An HTTP server answering with the MCP server only. */
async function serve(declared, { adminToken, zones = fakeZones() } = {}) {
  const ctx = { options: { adminToken }, shell: process.cwd(), endpoints: null, metrics: null };
  const mcp = createMcp(ctx, declared, zones);
  const server = http.createServer((req, res) => mcp.handle(req, res, new URL(req.url, "http://x")).then((h) => { if (!h) res.writeHead(404).end(); }));
  await new Promise((r) => server.listen(0, "127.0.0.1", r));
  const base = `http://127.0.0.1:${server.address().port}`;
  let id = 0;
  const rpc = async (method, params, headers = {}) => {
    const res = await fetch(base + mcp.path, { method: "POST", headers: { "content-type": "application/json", accept: "application/json, text/event-stream", ...headers }, body: JSON.stringify({ jsonrpc: "2.0", id: ++id, method, params }) });
    return { status: res.status, headers: res.headers, body: res.status === 202 ? null : await res.json() };
  };
  return { base, path: mcp.path, rpc, zones, close: () => new Promise((r) => server.close(r)) };
}

test("Mcp, Tools, Tool: descriptions are checked when the config loads", () => {
  assert.throws(() => Tool({ name: "bad name", description: "x", handler() {} }), /name must be/);
  assert.throws(() => Tool({ name: "t", handler() {} }), /description is required/);
  assert.throws(() => Tool({ name: "t", description: "x", handler() {}, zones: ["root"] }), /zones takes/);
  assert.throws(() => Mcp({ tools: [{ name: "x" }] }), /tools are made with/);
  assert.throws(() => Mcp({ tools: Tools(LivePull(), LivePull({ tools: ["status"] })) }), /two tools are named zones_status/);
  assert.throws(() => Bearer({ token: "short" }), /16 characters/);
  assert.throws(() => OAuth({ issuer: "http://auth.example.com" }), /https/);
  assert.equal(Mcp({ tools: Tools(LivePull()) }).tools.length, 4);
});

test("the JSON Schema check names each problem", () => {
  const schema = { type: "object", properties: { zone: { type: "string", pattern: "^[a-z]+$" }, n: { type: "integer", minimum: 1 } }, required: ["zone"], additionalProperties: false };
  assert.deepEqual(validate(schema, { zone: "blog", n: 2 }), []);
  assert.deepEqual(validate(schema, { zone: "Blog!", n: 0, x: 1 }), ["arguments.zone does not match ^[a-z]+$", "arguments.n must be at least 1", "arguments.x is not expected"]);
  assert.deepEqual(validate(schema, {}), ["arguments.zone is required"]);
});

test("initialize, tools/list, Zones' own tools and the owner's, from this machine (no auth: the admin rule)", async () => {
  const seen = {};
  const s = await serve(Mcp({ tools: Tools(LivePull(), Tool({
    name: "echo", description: "Echoes", input: { type: "object", properties: { text: { type: "string" } }, required: ["text"] },
    handler: (args, context) => { seen.zones = Object.keys(context.zones); seen.auth = context.auth.scheme; return { echoed: args.text }; },
  }), Tool({ name: "reader", description: "Reads Zones", zones: ["read"], handler: (args, { zones }) => ({ keys: Object.keys(zones), status: zones.status() }) })) }));
  try {
    const init = await s.rpc("initialize", { protocolVersion: "2025-06-18", capabilities: {}, clientInfo: { name: "t", version: "1" } });
    assert.equal(init.body.result.protocolVersion, "2025-06-18");
    assert.deepEqual(init.body.result.capabilities, { tools: { listChanged: false } });
    const unknownVersion = await s.rpc("initialize", { protocolVersion: "1999-01-01" });
    assert.equal(unknownVersion.body.result.protocolVersion, "2025-11-25");
    const listed = await s.rpc("tools/list", {});
    assert.deepEqual(listed.body.result.tools.map((t) => t.name), ["zones_status", "zones_images", "zones_pull", "zones_install", "echo", "reader"]);
    const images = await s.rpc("tools/call", { name: "zones_images", arguments: { zone: "blog" } });
    assert.deepEqual(images.body.result.structuredContent, { zones: { blog: [{ version: "1", active: true, livePull: true }] } });
    const installed = await s.rpc("tools/call", { name: "zones_install", arguments: { zone: "blog", version: "2" } });
    assert.equal(installed.body.result.structuredContent.version, "2");
    /* A refusal is the call's error, not a protocol error. */
    const refused = await s.rpc("tools/call", { name: "zones_pull", arguments: { zone: "shop", version: "3" } });
    assert.equal(refused.body.result.isError, true);
    assert.match(refused.body.result.content[0].text, /does not allow live pulls/);
    const bad = await s.rpc("tools/call", { name: "zones_pull", arguments: { zone: "Shop" } });
    assert.equal(bad.body.error.code, -32602);
    assert.match(bad.body.error.message, /version is required/);
    const echoed = await s.rpc("tools/call", { name: "echo", arguments: { text: "hi" } });
    assert.deepEqual(echoed.body.result.structuredContent, { echoed: "hi" });
    /* An owner's tool reaches Zones only as far as it declares: none by default, reading with zones: ["read"]. */
    assert.deepEqual(seen, { zones: [], auth: "admin" });
    const reader = await s.rpc("tools/call", { name: "reader", arguments: {} });
    assert.deepEqual(reader.body.result.structuredContent.keys, ["status", "images", "metrics"]);
    assert.equal((await s.rpc("nope/nothing", {})).body.error.code, -32601);
    /* Notifications: 202, no body. GET: 405. */
    const note = await fetch(s.base + s.path, { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ jsonrpc: "2.0", method: "notifications/initialized" }) });
    assert.equal(note.status, 202);
    assert.equal((await fetch(s.base + s.path)).status, 405);
    /* A browser page of another origin is refused. */
    assert.equal((await s.rpc("ping", {}, { origin: "https://evil.example" })).status, 403);
    assert.equal((await s.rpc("ping", {}, { "mcp-protocol-version": "1999-01-01" })).status, 400);
  } finally { await s.close(); }
});

test("a tool's call has a time limit, and its signal aborts", async () => {
  let aborted = false;
  const s = await serve(Mcp({ tools: Tools(Tool({ name: "slow", description: "Slow", timeoutMs: 50, handler: (_, { signal }) => new Promise((resolve) => signal.addEventListener("abort", () => { aborted = true; resolve("late"); })) })) }));
  try {
    const r = await s.rpc("tools/call", { name: "slow", arguments: {} });
    assert.equal(r.body.result.isError, true);
    assert.match(r.body.result.content[0].text, /took over 50 ms/);
    assert.equal(aborted, true);
  } finally { await s.close(); }
});

test("the admin token, and Bearer tokens", async () => {
  const admin = await serve(Mcp({ tools: Tools(LivePull({ tools: ["status"] })) }), { adminToken: "admin-token-0123456789" });
  try {
    assert.equal((await admin.rpc("ping", {})).status, 401);
    assert.equal((await admin.rpc("ping", {}, { authorization: "Bearer admin-token-0123456789" })).status, 200);
  } finally { await admin.close(); }
  process.env.TEST_MCP_TOKEN = "env-token-0123456789";
  const bearer = await serve(Mcp({ tools: Tools(LivePull({ tools: ["status"] })), auth: [Bearer({ token: "static-token-0123456789" }), Bearer({ env: "TEST_MCP_TOKEN" }), Bearer({ verify: (t) => t === "custom-token" && { subject: "ci", scopes: ["zones:read"] } })] }));
  try {
    const none = await bearer.rpc("ping", {});
    assert.equal(none.status, 401);
    assert.equal(none.headers.get("www-authenticate"), "Bearer");
    for (const token of ["static-token-0123456789", "env-token-0123456789", "custom-token"]) assert.equal((await bearer.rpc("ping", {}, { authorization: `Bearer ${token}` })).status, 200, token);
    assert.equal((await bearer.rpc("ping", {}, { authorization: "Bearer wrong-token-0123456789" })).status, 401);
  } finally { await bearer.close(); delete process.env.TEST_MCP_TOKEN; }
});

test("OAuth: protected resource metadata, JWTs checked against the issuer's keys, audience and scopes", async () => {
  const { privateKey, publicKey } = crypto.generateKeyPairSync("rsa", { modulusLength: 2048 });
  const jwk = { ...publicKey.export({ format: "jwk" }), kid: "k1", alg: "RS256", use: "sig" };
  const issuerServer = http.createServer((req, res) => {
    if (req.url === "/.well-known/oauth-authorization-server") return res.writeHead(200, { "content-type": "application/json" }).end(JSON.stringify({ issuer: issuer, jwks_uri: `${issuer}/jwks` }));
    if (req.url === "/jwks") return res.writeHead(200, { "content-type": "application/json" }).end(JSON.stringify({ keys: [jwk] }));
    res.writeHead(404).end();
  });
  await new Promise((r) => issuerServer.listen(0, "127.0.0.1", r));
  const issuer = `http://127.0.0.1:${issuerServer.address().port}`;
  const sign = (claims, key = privateKey, kid = "k1") => {
    const enc = (o) => Buffer.from(JSON.stringify(o)).toString("base64url");
    const head = enc({ alg: "RS256", typ: "JWT", kid }), body = enc(claims);
    return `${head}.${body}.${crypto.sign("sha256", Buffer.from(`${head}.${body}`), key).toString("base64url")}`;
  };
  const s = await serve(Mcp({ url: "https://zones.example.com/_next-zones/mcp", tools: Tools(LivePull({ scopes: ["zones:release"] })), auth: OAuth({ issuer, scopes: ["zones:read"] }) }));
  try {
    const meta = await (await fetch(`${s.base}/.well-known/oauth-protected-resource/_next-zones/mcp`)).json();
    assert.deepEqual(meta, { resource: "https://zones.example.com/_next-zones/mcp", authorization_servers: [issuer], bearer_methods_supported: ["header"], scopes_supported: ["zones:read"] });
    const none = await s.rpc("ping", {});
    assert.equal(none.status, 401);
    assert.equal(none.headers.get("www-authenticate"), 'Bearer resource_metadata="https://zones.example.com/.well-known/oauth-protected-resource/_next-zones/mcp"');
    const now = Math.floor(Date.now() / 1000);
    const good = { iss: issuer, aud: "https://zones.example.com/_next-zones/mcp", sub: "alice", exp: now + 300, scope: "zones:read" };
    const auth = (claims, key, kid) => ({ authorization: `Bearer ${sign(claims, key, kid)}` });
    assert.equal((await s.rpc("ping", {}, auth(good))).status, 200);
    assert.equal((await s.rpc("ping", {}, auth({ ...good, aud: "https://other.example.com/mcp" }))).status, 401);
    assert.equal((await s.rpc("ping", {}, auth({ ...good, exp: now - 3600 }))).status, 401);
    assert.equal((await s.rpc("ping", {}, auth({ ...good, iss: "https://evil.example" }))).status, 401);
    assert.equal((await s.rpc("ping", {}, auth(good, crypto.generateKeyPairSync("rsa", { modulusLength: 2048 }).privateKey))).status, 401);
    const noScope = await s.rpc("ping", {}, auth({ ...good, scope: "other" }));
    assert.equal(noScope.status, 403);
    assert.match(noScope.headers.get("www-authenticate"), /error="insufficient_scope", scope="zones:read"/);
    /* A tool's own scopes: reading passes, installing needs zones:release. */
    assert.equal((await s.rpc("tools/call", { name: "zones_status", arguments: {} }, auth(good))).status, 200);
    const install = await s.rpc("tools/call", { name: "zones_install", arguments: { zone: "blog", version: "2" } }, auth(good));
    assert.equal(install.status, 403);
    assert.deepEqual(s.zones.calls, []);
    assert.equal((await s.rpc("tools/call", { name: "zones_install", arguments: { zone: "blog", version: "2" } }, auth({ ...good, scope: "zones:read zones:release" }))).status, 200);
    assert.deepEqual(s.zones.calls, [["install", "blog", "2"]]);
  } finally { await s.close(); await new Promise((r) => issuerServer.close(r)); }
});

test("skills: resources and prompts", async () => {
  const s = await serve(Mcp({ tools: Tools(LivePull({ tools: ["status"] })), skills: Skills(Skill({ name: "release", description: "How to release a zone", content: "---\nname: release\n---\n# Release", files: { "steps.md": "1. build" } })) }));
  try {
    const init = await s.rpc("initialize", { protocolVersion: "2025-11-25" });
    assert.ok(init.body.result.capabilities.resources && init.body.result.capabilities.prompts);
    const list = await s.rpc("resources/list", {});
    assert.deepEqual(list.body.result.resources.map((r) => r.uri), ["skill://release/SKILL.md", "skill://release/steps.md"]);
    const read = await s.rpc("resources/read", { uri: "skill://release/steps.md" });
    assert.deepEqual(read.body.result.contents, [{ uri: "skill://release/steps.md", mimeType: "text/markdown", text: "1. build" }]);
    const prompt = await s.rpc("prompts/get", { name: "release" });
    assert.match(prompt.body.result.messages[0].content.text, /# Release/);
  } finally { await s.close(); }
});
