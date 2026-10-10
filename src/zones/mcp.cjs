"use strict";
/*
 * Zones' MCP server, from the shell's zoneConfig({ mcp: Mcp(…) }) (../mcp.cjs): Model Context Protocol over Streamable
 * HTTP, stateless, at one path (default "<endpoints base>/mcp", "/_next-zones/mcp"), whatever endpoints the shell
 * declares.
 *
 * - Transport: a POST carries one JSON-RPC message (or a batch, for 2025-03-26 clients) and gets its answer as
 *   application/json; a notification or a response gets 202. No server-initiated stream: GET and DELETE are 405. A
 *   browser request from another origin is refused (403), as the spec asks against DNS rebinding.
 * - Versions: 2025-11-25, 2025-06-18 and 2025-03-26; initialize settles on the client's when it is one of them.
 * - Authorization: zones/mcp-auth.cjs. With OAuth, the protected resource metadata is served at
 *   /.well-known/oauth-protected-resource<path>.
 * - Tools: the owner's (Tool(…): its arguments checked against its input schema, then its handler run, with
 *   { zones, auth, signal }), and Zones' own: zones_status, zones_images, zones_pull and zones_install (LivePull()),
 *   zones_metrics (Metrics()). A pull on request needs the zone's livePull, as for the admin URLs.
 * - Skills (Skills(…)): resources skill://<name>/<file>, and one prompt per skill, its SKILL.md.
 * Nothing here depends on another package: the official SDK installs 26 MB in 91 packages and takes 78 ms and 37 MB
 * to load (measured 2026-10-10, Node 24.16, Apple M1); see RESULTS.md, "MCP".
 */
const fs = require("node:fs");
const path = require("node:path");
const { ZoneError } = require("./context.cjs");
const { createAuth, AuthError } = require("./mcp-auth.cjs");

const VERSIONS = ["2025-11-25", "2025-06-18", "2025-03-26"];
const BODY_LIMIT = 1 << 20;
const RESULT_LIMIT = 8 << 20;
const PACKAGE_VERSION = (() => { try { return require("../../package.json").version; } catch { return "0.0.0"; } })();

/* JSON-RPC errors. */
const PARSE = -32700, INVALID = -32600, NO_METHOD = -32601, PARAMS = -32602, INTERNAL = -32603;

/* The JSON Schema a tool's arguments are checked against: the keywords tools use (type, properties, required,
   additionalProperties, items, enum, const, minimum, maximum, minLength, maxLength, pattern, minItems, maxItems). */
function validate(schema, value, at = "arguments") {
  const errors = [];
  const typeOf = (v) => (v === null ? "null" : Array.isArray(v) ? "array" : Number.isInteger(v) ? "integer" : typeof v);
  const check = (s, v, where) => {
    if (!s || typeof s !== "object") return;
    if (s.type) {
      const types = [].concat(s.type), t = typeOf(v);
      if (!types.some((x) => x === t || (x === "number" && t === "integer"))) { errors.push(`${where} must be ${types.join(" or ")}`); return; }
    }
    if (s.enum && !s.enum.some((e) => JSON.stringify(e) === JSON.stringify(v))) errors.push(`${where} must be one of ${s.enum.map((e) => JSON.stringify(e)).join(", ")}`);
    if ("const" in s && JSON.stringify(s.const) !== JSON.stringify(v)) errors.push(`${where} must be ${JSON.stringify(s.const)}`);
    if (typeof v === "number") {
      if (s.minimum !== undefined && v < s.minimum) errors.push(`${where} must be at least ${s.minimum}`);
      if (s.maximum !== undefined && v > s.maximum) errors.push(`${where} must be at most ${s.maximum}`);
    }
    if (typeof v === "string") {
      if (s.minLength !== undefined && v.length < s.minLength) errors.push(`${where} is too short`);
      if (s.maxLength !== undefined && v.length > s.maxLength) errors.push(`${where} is too long`);
      if (s.pattern && !new RegExp(s.pattern, "u").test(v)) errors.push(`${where} does not match ${s.pattern}`);
    }
    if (Array.isArray(v)) {
      if (s.minItems !== undefined && v.length < s.minItems) errors.push(`${where} needs at least ${s.minItems} items`);
      if (s.maxItems !== undefined && v.length > s.maxItems) errors.push(`${where} takes at most ${s.maxItems} items`);
      if (s.items) v.forEach((item, i) => check(s.items, item, `${where}[${i}]`));
    }
    if (v && typeof v === "object" && !Array.isArray(v)) {
      for (const key of s.required ?? []) if (!(key in v)) errors.push(`${where}.${key} is required`);
      for (const [key, item] of Object.entries(v)) {
        if (s.properties?.[key]) check(s.properties[key], item, `${where}.${key}`);
        else if (s.additionalProperties === false) errors.push(`${where}.${key} is not expected`);
        else if (typeof s.additionalProperties === "object") check(s.additionalProperties, item, `${where}.${key}`);
      }
    }
  };
  check(schema, value, at);
  return errors;
}

/* Zones' own tools: what they say of themselves, and what they do. */
const NAME = { type: "string", pattern: "^[a-z0-9][a-z0-9-]*$", description: "The zone's name" };
const VERSION = { type: "string", pattern: "^[A-Za-z0-9._-]+$", description: "The zone image's version" };
const BUILTINS = {
  zones_status: {
    title: "Zones status", annotations: { readOnlyHint: true, openWorldHint: false },
    description: "The zones Zones serves: each zone's active version and mount, the zones that failed at boot, uptime and memory.",
    input: { type: "object", properties: {}, additionalProperties: false },
    run: (z) => z.status(),
  },
  zones_images: {
    title: "Zone images", annotations: { readOnlyHint: true, openWorldHint: false },
    description: "The zone images in Zones' store, by zone: each version, whether it is active, whether the zone allows live pulls, what it was built with, its integrity.",
    input: { type: "object", properties: { zone: { ...NAME, description: "Only this zone's images" } }, additionalProperties: false },
    run: (z, { zone }) => { const all = z.images(); return { zones: zone ? { [zone]: all[zone] ?? [] } : all }; },
  },
  zones_pull: {
    title: "Pull a zone image", annotations: { readOnlyHint: false, destructiveHint: false, idempotentHint: true, openWorldHint: true },
    description: "Pulls a version of a zone into Zones' store from its sources, without installing it. The zone must allow live pulls (zoneConfig livePull: true). Returns where it came from (null when it was already in the store).",
    input: { type: "object", properties: { zone: NAME, version: VERSION }, required: ["zone", "version"], additionalProperties: false },
    run: (z, { zone, version }) => z.pull(zone, version),
  },
  zones_install: {
    title: "Install a zone version", annotations: { readOnlyHint: false, destructiveHint: false, idempotentHint: true, openWorldHint: true },
    description: "Installs a version of a zone into the running Zones, with no restart: a new version, a swap, or a rollback to an earlier one. A version the store lacks is pulled first, which needs the zone's live pulls. Returns the install's timings.",
    input: { type: "object", properties: { zone: NAME, version: VERSION }, required: ["zone", "version"], additionalProperties: false },
    run: (z, { zone, version }) => z.install(zone, version),
  },
  zones_metrics: {
    title: "Zones metrics", annotations: { readOnlyHint: true, openWorldHint: false },
    description: "Zones' metrics as Prometheus text: requests by zone and version, installs, pulls, memory, and what the zones' code measures. `match` keeps the metrics whose name starts with it (or matches it, written /regex/).",
    input: { type: "object", properties: { match: { type: "string", description: "A name prefix, or /regex/" } }, additionalProperties: false },
    run: (z, { match }) => z.metrics(match),
  },
};

/* A tool's result, as MCP has it: a string is text; an object is structured content (and its JSON as text); one with
   content is passed as it is. */
function toResult(value) {
  if (value && typeof value === "object" && Array.isArray(value.content)) return value;
  if (typeof value === "string") return { content: [{ type: "text", text: value }] };
  if (value === undefined || value === null) return { content: [] };
  if (typeof value === "object" && !Array.isArray(value)) return { content: [{ type: "text", text: JSON.stringify(value, null, 1) }], structuredContent: value };
  return { content: [{ type: "text", text: JSON.stringify(value) }] };
}

const MIME = { ".md": "text/markdown", ".txt": "text/plain", ".json": "application/json", ".js": "text/javascript", ".mjs": "text/javascript", ".ts": "text/x-typescript", ".py": "text/x-python", ".sh": "text/x-shellscript", ".html": "text/html", ".css": "text/css", ".yaml": "application/yaml", ".yml": "application/yaml" };
/* A SKILL.md's front matter: name and description. */
function frontMatter(text) {
  const m = /^---\r?\n([\s\S]*?)\r?\n---/.exec(text);
  const out = {};
  for (const line of (m?.[1] ?? "").split(/\r?\n/)) { const kv = /^([A-Za-z_-]+):\s*(.*)$/.exec(line); if (kv) out[kv[1]] = kv[2].replace(/^["']|["']$/g, ""); }
  return out;
}

/** Reads the declared skills: { name, description, files: Map<rel, { text } | { blob }> }. */
function loadSkills(declared, base) {
  return declared.map((s) => {
    if (s.content !== undefined) return { name: s.name, description: s.description, files: new Map([["SKILL.md", { text: s.content }], ...Object.entries(s.files ?? {}).map(([k, v]) => [k, { text: v }])]) };
    const dir = s.dir.startsWith("file:") ? require("node:url").fileURLToPath(s.dir) : path.resolve(base, s.dir);
    const file = path.join(dir, "SKILL.md");
    if (!fs.existsSync(file)) throw new Error(`next-zones mcp: the skill folder ${dir} has no SKILL.md`);
    const files = new Map();
    const walk = (at) => {
      for (const e of fs.readdirSync(at, { withFileTypes: true })) {
        if (e.name.startsWith(".")) continue;
        const f = path.join(at, e.name);
        if (e.isDirectory()) { walk(f); continue; }
        const rel = path.relative(dir, f).split(path.sep).join("/");
        const bytes = fs.readFileSync(f);
        if (bytes.length > 4 << 20) continue;
        const text = bytes.toString("utf8");
        files.set(rel, Buffer.from(text, "utf8").equals(bytes) && !text.includes("\u0000") ? { text } : { blob: bytes.toString("base64") });
      }
    };
    walk(dir);
    const meta = frontMatter(files.get("SKILL.md").text);
    const name = meta.name ?? path.basename(dir);
    if (!/^[a-z0-9][a-z0-9-]*$/.test(name)) throw new Error(`next-zones mcp: the skill in ${dir} is named ${JSON.stringify(name)}: lowercase letters, digits and "-"`);
    return { name, description: meta.description ?? "", files };
  });
}

/**
 * The MCP server.
 * @param {object} ctx
 * @param {object} declared   Mcp(…)
 * @param {object} zones      { status(), images(), pull(zone, version), install(zone, version), prune(options) }
 * @returns {{ path: string, handle(req, res, url): Promise<boolean> }}
 */
function createMcp(ctx, declared, zones, { fetchImpl } = {}) {
  const base = ctx.endpoints?.base ?? "/_next-zones";
  const mcpPath = declared.path ?? `${base}/mcp`;
  const metadataPath = `/.well-known/oauth-protected-resource${mcpPath}`;
  const auth = createAuth(ctx, declared.auth, { fetchImpl });
  /* What a tool's handler may do with Zones: the same as the admin URLs, a pull on request needing the zone's livePull. */
  const api = {
    status: () => zones.status(),
    images: () => zones.images(),
    pull: (zone, version) => zones.pull(zone, version),
    install: (zone, version) => zones.install(zone, version),
    prune: (options) => zones.prune(options),
    metrics(match) {
      const { render } = require("../metrics.cjs");
      const text = render();
      if (!match) return text;
      const re = /^\/(.*)\/([a-z]*)$/.exec(match);
      const test = re ? ((r) => (n) => r.test(n))(new RegExp(re[1], re[2])) : (n) => n.startsWith(match);
      return text.split("\n").filter((line) => { const name = /^(?:# (?:HELP|TYPE) )?([a-zA-Z_:][a-zA-Z0-9_:]*)/.exec(line)?.[1]; return name && test(name); }).join("\n") + "\n";
    },
  };

  const tools = new Map();
  for (const t of declared.tools) {
    if (t.builtin) {
      const b = BUILTINS[t.builtin];
      if (t.builtin === "zones_metrics" && !ctx.metrics) throw new Error("next-zones mcp: Metrics() needs the shell's metrics: true (or createZones({ metrics: true }))");
      tools.set(t.name, { name: t.name, title: b.title, description: b.description, input: b.input, annotations: b.annotations, scopes: t.scopes, run: (args) => b.run(api, args) });
    } else {
      /* The owner's tool reaches Zones only as far as it declares (Tool({ zones })). */
      const allowed = new Set(t.zones ?? []);
      const scoped = {
        ...(allowed.has("read") ? { status: api.status, images: api.images, metrics: api.metrics } : {}),
        ...(allowed.has("pull") ? { pull: api.pull } : {}),
        ...(allowed.has("install") ? { install: api.install } : {}),
        ...(allowed.has("prune") ? { prune: api.prune } : {}),
      };
      tools.set(t.name, { ...t, run: (args, context) => t.handler(args, { ...context, zones: Object.freeze(scoped) }) });
    }
  }
  const skills = loadSkills(declared.skills ?? [], ctx.shell);
  const skillByName = new Map(skills.map((s) => [s.name, s]));
  const calls = ctx.metrics ? require("../metrics.cjs").counter("nextzones_mcp_calls_total", { help: "MCP tool calls, by tool and outcome" }) : null;

  const originOf = (req) => {
    const proto = String(req.headers["x-forwarded-proto"] ?? (req.socket.encrypted ? "https" : "http")).split(",")[0].trim();
    const host = String(req.headers["x-forwarded-host"] ?? req.headers.host ?? "localhost").split(",")[0].trim();
    return `${proto}://${host}`;
  };
  const resourceOf = (req) => declared.url ?? `${originOf(req)}${mcpPath}`;
  const metadataUrlOf = (req) => { const r = new URL(resourceOf(req)); return `${r.origin}/.well-known/oauth-protected-resource${r.pathname === "/" ? "" : r.pathname}`; };
  const send = (res, status, body, headers = {}) => {
    const text = body === undefined ? "" : JSON.stringify(body);
    res.writeHead(status, { ...(body === undefined ? {} : { "content-type": "application/json" }), "cache-control": "no-store", ...headers }).end(text);
  };
  const rpcError = (id, code, message, data) => ({ jsonrpc: "2.0", id: id ?? null, error: { code, message, ...(data !== undefined ? { data } : {}) } });

  async function dispatch(message, who, signal) {
    const { id, method, params = {} } = message;
    const ok = (result) => ({ jsonrpc: "2.0", id, result });
    switch (method) {
      case "initialize": {
        const asked = params.protocolVersion;
        return ok({
          protocolVersion: VERSIONS.includes(asked) ? asked : VERSIONS[0],
          capabilities: { tools: { listChanged: false }, ...(skills.length ? { resources: { listChanged: false }, prompts: { listChanged: false } } : {}) },
          serverInfo: { name: declared.name, version: declared.version ?? PACKAGE_VERSION },
          ...(declared.instructions ? { instructions: declared.instructions } : {}),
        });
      }
      case "ping": return ok({});
      case "tools/list": return ok({ tools: [...tools.values()].map((t) => ({
        name: t.name, ...(t.title ? { title: t.title } : {}), description: t.description, inputSchema: t.input,
        ...(t.output ? { outputSchema: t.output } : {}), ...(t.annotations ? { annotations: t.annotations } : {}),
      })) });
      case "tools/call": {
        const tool = tools.get(params.name);
        if (!tool) return rpcError(id, PARAMS, `unknown tool ${JSON.stringify(params.name)}`);
        const args = params.arguments ?? {};
        const problems = validate(tool.input, args);
        if (problems.length) return rpcError(id, PARAMS, `invalid arguments: ${problems.join("; ")}`);
        if (tool.scopes?.length && who.scopes !== null) {
          const missing = tool.scopes.filter((s) => !who.scopes.includes(s));
          if (missing.length) throw new AuthError(`${tool.name} needs the scopes ${missing.join(", ")}`, { status: 403, error: "insufficient_scope", scope: tool.scopes.join(" ") });
        }
        /* A call has a time limit: past it, it fails and its signal aborts (the handler should stop). */
        const timeoutMs = tool.timeoutMs ?? 30_000;
        const own = new AbortController();
        const abort = () => own.abort(signal.reason);
        signal.addEventListener("abort", abort, { once: true });
        let timer;
        try {
          const result = toResult(await Promise.race([
            tool.run(args, { zones: api, auth: who, signal: own.signal }),
            new Promise((_, reject) => { timer = setTimeout(() => { const e = new Error(`${tool.name} took over ${timeoutMs} ms`); reject(e); own.abort(e); }, timeoutMs); }),
          ]));
          const size = Buffer.byteLength(JSON.stringify(result));
          if (size > RESULT_LIMIT) throw new Error(`${tool.name} answered ${size} bytes, over the ${RESULT_LIMIT} a call may`);
          calls?.inc({ tool: tool.name, outcome: "ok" });
          return ok(result);
        } catch (error) {
          calls?.inc({ tool: tool.name, outcome: "error" });
          /* A refusal (a ZoneError) or the owner's error is the call's answer; anything else from Zones is logged too. */
          if (!tool.handler && !(error instanceof ZoneError)) console.error(error);
          return ok({ content: [{ type: "text", text: String(error?.message ?? error) }], isError: true });
        } finally {
          clearTimeout(timer);
          signal.removeEventListener("abort", abort);
        }
      }
      case "resources/list": return ok({ resources: skills.flatMap((s) => [...s.files.keys()].map((rel) => ({
        uri: `skill://${s.name}/${rel}`, name: rel === "SKILL.md" ? s.name : `${s.name}/${rel}`,
        ...(rel === "SKILL.md" && s.description ? { description: s.description } : {}),
        mimeType: MIME[path.extname(rel)] ?? (s.files.get(rel).text !== undefined ? "text/plain" : "application/octet-stream"),
      }))) });
      case "resources/templates/list": return ok({ resourceTemplates: [] });
      case "resources/read": {
        const m = /^skill:\/\/([^/]+)\/(.+)$/.exec(params.uri ?? "");
        const file = m && skillByName.get(m[1])?.files.get(m[2]);
        if (!file) return rpcError(id, -32002, `resource not found: ${params.uri}`);
        const mimeType = MIME[path.extname(m[2])] ?? (file.text !== undefined ? "text/plain" : "application/octet-stream");
        return ok({ contents: [{ uri: params.uri, mimeType, ...file }] });
      }
      case "prompts/list": return ok({ prompts: skills.map((s) => ({ name: s.name, ...(s.description ? { description: s.description } : {}) })) });
      case "prompts/get": {
        const s = skillByName.get(params.name);
        if (!s) return rpcError(id, PARAMS, `unknown prompt ${JSON.stringify(params.name)}`);
        return ok({ description: s.description, messages: [{ role: "user", content: { type: "text", text: s.files.get("SKILL.md").text } }] });
      }
      default: return rpcError(id, NO_METHOD, `method not found: ${method}`);
    }
  }

  async function readBody(req) {
    const chunks = [];
    let size = 0;
    for await (const chunk of req) { size += chunk.length; if (size > BODY_LIMIT) return null; chunks.push(chunk); }
    return Buffer.concat(chunks).toString("utf8");
  }

  /** Answers a request for the MCP server (or its resource metadata); false when the request is not for it. */
  async function handle(req, res, url) {
    if (url.pathname === metadataPath && req.method === "GET") {
      const meta = auth.metadata(resourceOf(req));
      if (!meta) return false;
      send(res, 200, meta, { "access-control-allow-origin": "*" });
      return true;
    }
    if (url.pathname !== mcpPath) return false;
    /* A browser request from another origin (DNS rebinding): refused. */
    const origin = req.headers.origin;
    if (origin && origin !== originOf(req) && !declared.origins.includes(origin) && !(declared.url && new URL(declared.url).origin === origin)) {
      send(res, 403, rpcError(null, INVALID, "next-zones mcp: this origin is not allowed"));
      return true;
    }
    if (req.method !== "POST") { send(res, 405, rpcError(null, INVALID, "next-zones mcp: POST JSON-RPC messages here (no server stream)"), { allow: "POST" }); return true; }
    const version = req.headers["mcp-protocol-version"];
    if (version !== undefined && !VERSIONS.includes(version)) { send(res, 400, rpcError(null, INVALID, `unsupported MCP-Protocol-Version ${version} (supported: ${VERSIONS.join(", ")})`)); return true; }
    let who;
    try { who = await auth.authenticate(req, resourceOf(req)); } catch (error) {
      if (!(error instanceof AuthError)) throw error;
      send(res, error.status, rpcError(null, INVALID, error.message), error.status === 500 ? {} : { "www-authenticate": auth.challenge(metadataUrlOf(req), error) });
      return true;
    }
    const text = await readBody(req);
    if (text === null) { send(res, 413, rpcError(null, INVALID, "next-zones mcp: the message is over 1 MiB")); return true; }
    let message;
    try { message = JSON.parse(text); } catch { send(res, 400, rpcError(null, PARSE, "parse error")); return true; }
    const controller = new AbortController();
    res.once("close", () => { if (!res.writableFinished) controller.abort(); });
    const one = async (m) => {
      if (!m || typeof m !== "object" || m.jsonrpc !== "2.0") return rpcError(m?.id, INVALID, "not a JSON-RPC 2.0 message");
      if (m.method === undefined) return null;                    // a response or an error from the client
      if (m.id === undefined) return null;                        // a notification (notifications/initialized…)
      if (typeof m.method !== "string") return rpcError(m.id, INVALID, "method must be a string");
      return dispatch(m, who, controller.signal);
    };
    try {
      const answers = Array.isArray(message) ? (await Promise.all(message.map(one))).filter(Boolean) : [await one(message)].filter(Boolean);
      if (!answers.length) send(res, 202);
      else send(res, 200, Array.isArray(message) ? answers : answers[0]);
    } catch (error) {
      if (error instanceof AuthError) { send(res, error.status, rpcError(message?.id, INVALID, error.message), { "www-authenticate": auth.challenge(metadataUrlOf(req), error) }); return true; }
      console.error(error);
      send(res, 500, rpcError(message?.id, INTERNAL, "next-zones mcp: internal error"));
    }
    return true;
  }

  return { path: mcpPath, handle, tools: [...tools.keys()] };
}

module.exports = { createMcp, validate, VERSIONS };
