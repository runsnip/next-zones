"use strict";
/*
 * Zones as an MCP server: the shell declares it in its zoneConfig, and Zones serves it (zones/mcp.cjs).
 *
 *   import { zoneConfig } from "@runsnip/next-zones/config";
 *   import { Mcp, Tools, Tool, LivePull, Metrics, Skills, Bearer, OAuth } from "@runsnip/next-zones/mcp";
 *
 *   export default zoneConfig({
 *     mount: "/",
 *     mcp: Mcp({
 *       tools: Tools(LivePull(), Metrics(), Tool({ name: "greet", input: { … }, handler: (args) => "hi" })),
 *       skills: Skills("./skills/release"),                       // optional
 *       auth: [Bearer({ env: "MCP_TOKEN" }), OAuth({ issuer: "https://auth.example.com", audience: "…" })],
 *     }),
 *   });
 *
 * Each function returns a plain description; nothing runs until Zones starts. The MCP server is Zones' own, beside the
 * endpoints (zoneConfig's endpoints may all be off): its tools act on Zones directly, under the same rules as the admin
 * URLs (a pull on request needs the zone's livePull).
 */
const KIND = Symbol.for("@runsnip/next-zones/mcp");
const NAME = /^[A-Za-z0-9_.-]{1,128}$/;
const ZONES_CAPABILITIES = ["read", "pull", "install", "prune"];

const kindOf = (value) => (value && typeof value === "object" ? value[KIND] : undefined);
const tag = (kind, value) => Object.defineProperty(value, KIND, { value: kind, enumerable: false });
const fail = (where, message) => { throw new Error(`next-zones mcp: ${where}: ${message}`); };
const flat = (items) => items.flat(Infinity).filter((item) => item !== undefined && item !== null && item !== false);

/**
 * The MCP server of the shell.
 * @param {object} options
 * @param {string} [options.path]   where it answers (default "<endpoints base>/mcp", "/_next-zones/mcp")
 * @param {string} [options.url]    its canonical URL (the OAuth resource and audience), when a proxy hides it
 * @param {string} [options.name]   the server's name in initialize (default "next-zones")
 * @param {string} [options.version]
 * @param {string} [options.instructions] what the server tells a client about itself
 * @param {object[]} options.tools  Tools(…)
 * @param {object[]} [options.skills] Skills(…), served as resources and prompts
 * @param {object[]} [options.auth] Bearer(…), OAuth(…): a request passes with any one; without auth, the admin rule
 *                                  (Bearer <adminToken>, or a request from the same machine when no token is set)
 * @param {string[]} [options.origins] browser origins allowed besides the server's own (DNS rebinding guard)
 */
function Mcp(options = {}) {
  const { path, url, name = "next-zones", version, instructions, tools = [], skills = [], auth, origins = [] } = options;
  if (path !== undefined && !/^\/[A-Za-z0-9_.~/-]*[A-Za-z0-9_.~-]$/.test(path)) fail("Mcp", `path must be a path like "/_next-zones/mcp", got ${JSON.stringify(path)}`);
  if (url !== undefined) { try { new URL(url); } catch { fail("Mcp", `url must be an absolute URL, got ${JSON.stringify(url)}`); } }
  const toolList = flat([tools]);
  for (const t of toolList) if (kindOf(t) !== "tool") fail("Mcp", "tools are made with Tools(…), Tool(…), LivePull() or Metrics()");
  const names = new Set();
  for (const t of toolList) { if (names.has(t.name)) fail("Mcp", `two tools are named ${t.name}`); names.add(t.name); }
  const skillList = flat([skills]);
  for (const s of skillList) if (kindOf(s) !== "skill") fail("Mcp", "skills are made with Skills(…) or Skill(…)");
  const authList = auth === undefined ? null : flat([auth]);
  if (authList) for (const a of authList) if (kindOf(a) !== "auth") fail("Mcp", "auth takes Bearer(…) and OAuth(…)");
  if (authList && !authList.length) fail("Mcp", "auth is empty: leave it out for the admin rule, or give Bearer(…) or OAuth(…)");
  if (!Array.isArray(origins) || origins.some((o) => typeof o !== "string")) fail("Mcp", "origins is a list of origins like \"https://app.example.com\"");
  return tag("mcp", { path, url, name, version, instructions, tools: toolList, skills: skillList, auth: authList, origins });
}

/** The tools of the server: any number of Tool(…), LivePull(), Metrics(), or lists of them. */
function Tools(...items) {
  const tools = flat(items);
  for (const t of tools) if (kindOf(t) !== "tool") fail("Tools", "each item is a Tool(…), or LivePull() or Metrics()");
  return tools;
}

/**
 * A tool of your own.
 * @param {object} tool
 * @param {string} tool.name
 * @param {string} [tool.title]
 * @param {string} tool.description
 * @param {object} [tool.input]  its arguments' JSON Schema (an object schema); checked before the handler runs
 * @param {object} [tool.output] its structured result's JSON Schema
 * @param {object} [tool.annotations] readOnlyHint, destructiveHint, idempotentHint, openWorldHint
 * @param {string[]} [tool.scopes] OAuth scopes a caller needs for it
 * @param {string[]} [tool.zones] what its handler may do with Zones (context.zones): "read" (status, images, metrics),
 *        "pull", "install", "prune". None by default: a tool reaches Zones only as far as it declares.
 * @param {number} [tool.timeoutMs] a call that runs longer fails, and its signal aborts (default 30 000)
 * @param {(args: object, context: object) => any} tool.handler returns a string, an object (structured), or
 *        { content, structuredContent }; a thrown error is the call's error. context: { zones, auth, signal }
 * A tool runs in Zones' process, with the web: auth decides who may call it, not what its code may do. Run code you do
 * not trust (a third party's tool) out of the process, behind a tool of your own that calls it.
 */
function Tool(tool = {}) {
  const { name, title, description, input = { type: "object", properties: {} }, output, annotations, scopes = [], zones = [], timeoutMs = 30_000, handler } = tool;
  const unknown = [].concat(zones).filter((z) => !ZONES_CAPABILITIES.includes(z));
  if (unknown.length) fail(`Tool ${name}`, `zones takes ${ZONES_CAPABILITIES.map((c) => JSON.stringify(c)).join(", ")}, got ${unknown.join(", ")}`);
  if (!(Number.isFinite(timeoutMs) && timeoutMs > 0)) fail(`Tool ${name}`, "timeoutMs is a positive number of milliseconds");
  if (!NAME.test(name ?? "")) fail("Tool", `name must be 1 to 128 letters, digits, "_", "-" or ".", got ${JSON.stringify(name)}`);
  if (typeof description !== "string" || !description) fail(`Tool ${name}`, "a description is required");
  if (typeof handler !== "function") fail(`Tool ${name}`, "a handler function is required");
  if (!input || input.type !== "object") fail(`Tool ${name}`, "input is an object JSON Schema ({ type: \"object\", properties })");
  if (output !== undefined && output?.type !== "object") fail(`Tool ${name}`, "output is an object JSON Schema");
  return tag("tool", { name, title, description, input, output, annotations, scopes, zones: [].concat(zones), timeoutMs, handler });
}

const LIVE_PULL_TOOLS = ["status", "images", "pull", "install"];
/**
 * Zones' own tools for releases: zones_status, zones_images, zones_pull and zones_install. A pull, and an install of a
 * version the store lacks, are pulls on request: the zone must declare livePull, as for the admin URLs.
 * @param {object} [options]
 * @param {string[]} [options.tools] which of "status", "images", "pull", "install" (all by default)
 * @param {string[]} [options.scopes] OAuth scopes a caller needs for pull and install (reading needs none)
 */
function LivePull({ tools = LIVE_PULL_TOOLS, scopes = [] } = {}) {
  const unknown = tools.filter((t) => !LIVE_PULL_TOOLS.includes(t));
  if (unknown.length) fail("LivePull", `unknown tools ${unknown.join(", ")} (known: ${LIVE_PULL_TOOLS.join(", ")})`);
  return tools.map((t) => tag("tool", { builtin: `zones_${t}`, name: `zones_${t}`, scopes: t === "pull" || t === "install" ? scopes : [] }));
}

/**
 * Zones' metrics as a tool, zones_metrics: the Prometheus text the shell's metrics: true opens, filtered by name.
 * @param {object} [options]
 * @param {string[]} [options.scopes] OAuth scopes a caller needs
 */
function Metrics({ scopes = [] } = {}) {
  return [tag("tool", { builtin: "zones_metrics", name: "zones_metrics", scopes })];
}

/**
 * Skills, served as MCP resources (skill://<name>/<file>) and prompts (one per skill: its SKILL.md). Each item is a
 * folder holding a SKILL.md (a path, absolute or from the shell's folder, or a file: URL), or a Skill(…).
 */
function Skills(...items) {
  return flat(items).map((item) => {
    if (kindOf(item) === "skill") return item;
    if (typeof item === "string" || item instanceof URL) return tag("skill", { dir: item instanceof URL ? item.href : item });
    return fail("Skills", "each item is a folder (a path or a file: URL) holding a SKILL.md, or a Skill(…)");
  });
}

/**
 * One skill, written out.
 * @param {object} skill
 * @param {string} skill.name
 * @param {string} skill.description
 * @param {string} skill.content       its SKILL.md
 * @param {Record<string, string>} [skill.files] other files, by path inside the skill
 */
function Skill({ name, description, content, files = {} } = {}) {
  if (!/^[a-z0-9][a-z0-9-]*$/.test(name ?? "")) fail("Skill", `name is lowercase letters, digits and "-", got ${JSON.stringify(name)}`);
  if (typeof description !== "string" || !description) fail(`Skill ${name}`, "a description is required");
  if (typeof content !== "string") fail(`Skill ${name}`, "content (its SKILL.md) is required");
  return tag("skill", { name, description, content, files });
}

/** next-zones' own skill (skills/next-zones in the package): how to work with zones, for the client's model. */
function NextZonesSkill() {
  return tag("skill", { dir: require("node:path").join(__dirname, "..", "skills", "next-zones") });
}

/**
 * Bearer tokens: a request passes with one of them in `Authorization: Bearer <token>`.
 * @param {object} options
 * @param {string} [options.token]   one token
 * @param {string[]} [options.tokens]
 * @param {string} [options.env]     the environment variable holding it, read when Zones starts (keeps it out of the config)
 * @param {(token: string, request: object) => any} [options.verify] decides instead: a truthy result passes, and is the
 *        caller's identity ({ subject, scopes }) given to handlers
 */
function Bearer({ token, tokens = [], env, verify } = {}) {
  const list = [token, ...tokens].filter((t) => t !== undefined);
  if (list.some((t) => typeof t !== "string" || t.length < 16)) fail("Bearer", "a token is a string of 16 characters or more");
  if (env !== undefined && !/^[A-Za-z_][A-Za-z0-9_]*$/.test(env)) fail("Bearer", `env is a variable name, got ${JSON.stringify(env)}`);
  if (verify !== undefined && typeof verify !== "function") fail("Bearer", "verify is a function");
  if (!list.length && !env && !verify) fail("Bearer", "give token, tokens, env or verify");
  return tag("auth", { scheme: "bearer", tokens: list, env, verify });
}

/**
 * OAuth 2.1 access tokens, as the MCP authorization spec has it: Zones is a resource server. It publishes its
 * protected resource metadata (RFC 9728), points a client without a token at the authorization server, and accepts a
 * token issued by `issuer` for this server (its audience): a JWT checked against the issuer's keys (JWKS), or, with
 * `introspection`, any token the issuer confirms (RFC 7662).
 * @param {object} options
 * @param {string} options.issuer        the authorization server
 * @param {string} [options.audience]    what the token's aud must hold (default: the server's canonical URL)
 * @param {string} [options.jwksUri]     the issuer's keys (default: read from its metadata)
 * @param {string[]} [options.algorithms] accepted signatures (default RS256, RS384, RS512, PS256, PS384, PS512, ES256, ES384, EdDSA)
 * @param {string[]} [options.scopes]    scopes every request needs
 * @param {{ url: string, clientId?: string, clientSecret?: string }} [options.introspection]
 */
function OAuth({ issuer, audience, jwksUri, algorithms, scopes = [], introspection } = {}) {
  let parsed;
  try { parsed = new URL(issuer); } catch { fail("OAuth", `issuer is the authorization server's URL, got ${JSON.stringify(issuer)}`); }
  if (parsed.protocol !== "https:" && !["localhost", "127.0.0.1", "[::1]"].includes(parsed.hostname)) fail("OAuth", "the issuer must use https");
  if (introspection !== undefined && typeof introspection?.url !== "string") fail("OAuth", "introspection needs its url");
  return tag("auth", { scheme: "oauth", issuer: issuer.replace(/\/$/, ""), audience, jwksUri, algorithms, scopes, introspection });
}

module.exports = { Mcp, Tools, Tool, LivePull, Metrics, Skills, Skill, NextZonesSkill, Bearer, OAuth, MCP_KIND: KIND, kindOf };
