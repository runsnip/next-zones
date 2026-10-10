# Zones as an MCP server

Zones can serve the [Model Context Protocol](https://modelcontextprotocol.io), so an assistant (Claude, an IDE, an
agent) works with the running Zones: reads what serves, installs and rolls back zone versions, reads the metrics, and
calls tools of your own. The shell declares it in its `zoneConfig`:

```js
// shell/next.config.mjs
import { zoneConfig } from "@runsnip/next-zones/config";
import { Mcp, Tools, Tool, LivePull, Metrics, Skills, Bearer, OAuth } from "@runsnip/next-zones/mcp";
import { searchOrders } from "./mcp/orders.mjs";             // a tool of your own, from a module of the shell

export default zoneConfig({
  mount: "/",
  metrics: true,
  mcp: Mcp({
    tools: Tools(LivePull(), Metrics(), searchOrders),
    skills: Skills("./mcp/skills/release"),                  // optional
    auth: [Bearer({ env: "MCP_TOKEN" }), OAuth({ issuer: "https://auth.example.com", scopes: ["zones:read"] })],
  }),
});
```

- **Its own path,** `/_next-zones/mcp` (under `endpoints.base` when the shell sets one; `Mcp({ path })` chooses
  another). It answers whatever [endpoints](zones.md#endpoints) are declared: with every endpoint off, the MCP server
  still serves, and its tools still install and pull, under the same rules.
- **Zones only** (mode `"zones"`, `output: "standalone"` included). One app (mode `"single"`) has no Zones, and no MCP
  server.
- **Light.** The transport and the JSON-RPC are next-zones' own; OAuth tokens are checked with
  [`@runsnip/jwks`](https://github.com/runsnip/jwks), which has no dependency of its own (see [the numbers](#the-numbers)).

## Tools

`Tools(…)` takes any number of tools, or lists of them. None is required: Zones' own are there to be picked, beside
yours.

| | Tools | What they do |
|---|---|---|
| `LivePull()` | `zones_status` | Each zone's active version, the zones that failed at boot, uptime and memory |
| | `zones_images` | The zone images in the store, by zone (one zone with `zone`) |
| | `zones_pull` | Pulls `{ zone, version }` into the store from Zones' sources, without installing it |
| | `zones_install` | Installs, swaps to or rolls back to `{ zone, version }`, with no restart; a version the store lacks is pulled first |
| `Metrics()` | `zones_metrics` | The [metrics](metrics.md) as Prometheus text, filtered by `match` (a name prefix, or `/regex/`); needs the shell's `metrics: true` |

A pull on request (`zones_pull`, and `zones_install` of a version the store lacks) needs the zone's `livePull: true`,
as for the admin URLs ([live pulls](zones.md#live-pulls)); a version already in the store installs either way.
`LivePull({ tools: ["status", "images"] })` keeps only some of them; `LivePull({ scopes: ["zones:release"] })` makes
pulling and installing need that OAuth scope.

### Your own

```js
// shell/mcp/orders.mjs
import { Tool } from "@runsnip/next-zones/mcp";
import { db } from "../lib/db.mjs";

export const searchOrders = Tool({
  name: "orders_search",
  description: "Finds orders by customer email.",
  input: { type: "object", properties: { email: { type: "string" }, limit: { type: "integer", minimum: 1, maximum: 50 } }, required: ["email"] },
  annotations: { readOnlyHint: true },
  scopes: ["orders:read"],                       // OAuth scopes a caller needs
  zones: [],                                     // what it may do with Zones (below): nothing
  timeoutMs: 10_000,
  async handler({ email, limit = 10 }, { auth, signal }) {
    return { orders: await db.orders.find({ email, limit, signal }) };
  },
});
```

- **`input`** is the arguments' JSON Schema: a call whose arguments do not fit is refused before the handler runs,
  with each problem named. `output` declares the structured result's.
- **The handler** returns a string (text), an object (structured content, and its JSON as text), or an MCP result
  (`{ content, structuredContent }`). A thrown error is the call's error (`isError`), which the assistant reads.
- **`context`**: `auth`, the caller ([below](#authorization)); `signal`, aborted when the client leaves or the call
  passes `timeoutMs` (30 s by default); `zones`, what the tool may do with Zones.
- **`zones`**: a tool reaches Zones only as far as it declares. `"read"` gives `status()`, `images()` and
  `metrics(match)`; `"pull"`, `"install"` and `"prune"` give those. None by default.
- **Results** over 8 MiB are refused.

A tool is any `Tool(…)`: write your own factories (`Orders()`, `Billing()`) returning one or a list, and pass them to
`Tools(…)` beside Zones' own.

**A tool runs in Zones' process, with the web.** Authorization decides who may call it, not what its code may do: a
tool's code can read the process's environment and files, and a slow or broken one takes the web's time and memory.
Keep code you do not trust (a third party's) out of the process: run it as a service of its own, and give Zones a tool
that calls it.

## Skills

`Skills(…)` serves skills to the assistant, each as MCP resources (`skill://<name>/<file>`, every file of its folder)
and as a prompt (its `SKILL.md`):

```js
import { Skills, Skill, NextZonesSkill } from "@runsnip/next-zones/mcp";

skills: Skills("./mcp/skills/release", NextZonesSkill(), Skill({ name: "oncall", description: "…", content: "# On call…" })),
```

- a folder holding a `SKILL.md` (its front matter's `name` and `description`), from the shell's folder or as a `file:`
  URL;
- `NextZonesSkill()`: next-zones' own skill, so the assistant knows how zones work;
- `Skill({ name, description, content, files })`, written out.

Leave `skills` out when there are none.

## Authorization

`auth` takes any number of methods; a request passes with one of them. Without `auth`, the admin rule holds: the admin
token (`NEXT_ZONES_ADMIN_TOKEN`) as a bearer token, or, when none is set, a request from the same machine.

| Method | What passes |
|---|---|
| `Bearer({ token })`, `Bearer({ tokens })` | Static tokens (16 characters or more), compared in constant time |
| `Bearer({ env: "MCP_TOKEN" })` | The token from the environment, read when Zones starts: it stays out of the config. Zones refuses to start when it is unset |
| `Bearer({ verify })` | `verify(token, { headers })` decides: what it returns (`{ subject, scopes }`) is the caller |
| `OAuth({ issuer, audience, scopes })` | OAuth 2.1 access tokens, as the MCP authorization spec has it (below) |

**OAuth.** Zones is a resource server:
- it publishes its protected resource metadata (RFC 9728) at `/.well-known/oauth-protected-resource<path>`, naming
  the issuer;
- a request without a valid token gets 401, with `WWW-Authenticate: Bearer resource_metadata="…"`, which a client
  follows to the authorization server; a token without the scopes needed gets 403, `error="insufficient_scope"`;
- a JWT is checked with [`@runsnip/jwks`](https://github.com/runsnip/jwks) against the issuer's keys (its JWKS, found
  from its metadata or `jwksUri`, kept, fetched again for a key rotated in): signature (`RS*`, `PS*`, `ES*`, `EdDSA`;
  a key verifies only its own type's), `iss`, `aud`, `exp` and `nbf` (60 s of leeway), scopes (`scope` or `scp`). With
  `introspection: { url, clientId, clientSecret }`, any token the issuer confirms active (RFC 7662);
- `aud` must hold `audience`, by default the server's canonical URL. Behind a proxy, give it: `Mcp({ url:
  "https://app.example.com/_next-zones/mcp" })`.

A tool's `scopes` (and `LivePull({ scopes })`) apply to OAuth callers, and to a `Bearer({ verify })` that returns
scopes; a static token and the admin rule have every scope.

**From a browser,** a request whose `Origin` is not the server's own is refused (403), against DNS rebinding;
`Mcp({ origins })` allows others.

## The protocol

Streamable HTTP, stateless: a `POST` carries a JSON-RPC message (a batch from a 2025-03-26 client) and gets its answer
as JSON; a notification gets 202. There is no server stream (`GET` is 405). Versions 2025-11-25, 2025-06-18 and
2025-03-26. Methods: `initialize`, `ping`, `tools/list`, `tools/call`, and with skills `resources/list`,
`resources/read`, `resources/templates/list`, `prompts/list`, `prompts/get`.

A client connects with the URL, for example with Claude Code:

```sh
claude mcp add --transport http zones https://app.example.com/_next-zones/mcp --header "Authorization: Bearer $MCP_TOKEN"
```

With metrics on, each call is counted: `nextzones_mcp_calls_total{tool, outcome}`.

## Deploying

- **`next-zones start` and `serve`** read the MCP server from the shell's `next.config`.
- **`output: "standalone"`**: the declaration holds code (your tools' handlers), which no record keeps, so
  `next-zones build` copies the shell's `next.config` into the standalone folder with every module it imports (traced
  with Next's own `@vercel/nft`), and the skill folders; `zones.js` reads the MCP server from there.
- **`createZones({ mcp })`** gives or replaces it from code; `mcp: false` turns it off.

`next-zones doctor` checks the declaration: `Metrics()` without `metrics: true`, a path a route or a zone serves, a
`Bearer({ env })` whose variable is not set, mode `"single"`.

## The numbers

Node 24.16, Apple M1, measured 2026-10-10. The reference is the official SDK (`@modelcontextprotocol/sdk` 1.32.1, its
`McpServer` and stateless `StreamableHTTPServerTransport`), serving the same one-argument tool; 3000 sequential
`tools/call` over a kept-alive connection after 300, two rounds:

| | next-zones | the SDK |
|---|---|---|
| Installed | 52 KB of source, and `@runsnip/jwks` (13 KB packed, no dependency) | 26 MB, 91 packages |
| Loading it (median of 5 fresh processes) | 3.5 ms, +3.1 MB RSS | 78 ms, +37 MB RSS |
| A call, p50 | 0.078, 0.085 ms | 0.193, 0.216 ms |
| A call, p99 | 0.17, 0.34 ms | 1.15, 1.08 ms |
