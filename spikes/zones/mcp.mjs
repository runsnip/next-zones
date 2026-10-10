/*
 * Zones' MCP server, declared in the shell's zoneConfig (shell/next.config.mjs), with every endpoint off
 * (NEXT_ZONES_ENDPOINTS=off): MCP is Zones' own, at /_next-zones/mcp, whatever endpoints are declared. Over HTTP, as a
 * client does: initialize; the tools (Zones' own and the shell's); zones_install installs blog 1 then swaps to 2 and
 * rolls back, the page following each time; zones_pull of a zone without livePull is refused, of blog (livePull) is
 * tried; zones_metrics; the shell's tool, reading Zones as it declared; next-zones' skill as a resource and a prompt; a
 * browser origin refused; and the admin endpoints answering 404, as declared off.
 */
const BASE = "http://127.0.0.1:3900";
const MCP = `${BASE}/_next-zones/mcp`;
let id = 0;
const rpc = async (method, params = {}, headers = {}) => {
  const res = await fetch(MCP, { method: "POST", headers: { "content-type": "application/json", accept: "application/json, text/event-stream", "mcp-protocol-version": "2025-11-25", ...headers }, body: JSON.stringify({ jsonrpc: "2.0", id: ++id, method, params }) });
  return { status: res.status, body: res.status === 202 ? null : await res.json() };
};
const call = async (name, args = {}) => (await rpc("tools/call", { name, arguments: args })).body.result;
const page = async (p) => { const t = (await (await fetch(BASE + p)).text()).replace(/<!-- -->/g, ""); return /zone blog v(\d)/.exec(t)?.[0] ?? t.slice(0, 80); };

const seen = {};
const init = await rpc("initialize", { protocolVersion: "2025-11-25", capabilities: {}, clientInfo: { name: "check", version: "1" } });
seen.initialize = { version: init.body.result?.protocolVersion, capabilities: Object.keys(init.body.result?.capabilities ?? {}), server: init.body.result?.serverInfo?.name };
seen.tools = (await rpc("tools/list")).body.result.tools.map((t) => t.name);
const v1 = await call("zones_install", { zone: "blog", version: "1" });
seen.afterV1 = { ok: !v1.isError, page: await page("/blog") };
const v2 = await call("zones_install", { zone: "blog", version: "2" });
seen.afterV2 = { ok: !v2.isError, page: await page("/blog") };
const back = await call("zones_install", { zone: "blog", version: "1" });
seen.rolledBack = { ok: !back.isError, page: await page("/blog") };
seen.status = (await call("zones_status")).structuredContent?.zones;
seen.images = Object.keys((await call("zones_images")).structuredContent?.zones ?? {});
const shopPull = await call("zones_pull", { zone: "shop", version: "99" });
seen.shopPull = { isError: shopPull.isError, text: shopPull.content[0].text };
const blogPull = await call("zones_pull", { zone: "blog", version: "99" });
seen.blogPull = { isError: blogPull.isError, text: blogPull.content[0].text };
const metrics = (await call("zones_metrics", { match: "nextzones_zone_active" })).content[0].text;
seen.metrics = metrics.split("\n").filter((l) => l.startsWith("nextzones_zone_active{")).length;
seen.shellTool = (await call("shell_versions", { zone: "blog" })).structuredContent;
seen.badArgs = (await rpc("tools/call", { name: "zones_install", arguments: { zone: "blog" } })).body.error?.code;
seen.resources = (await rpc("resources/list")).body.result.resources.map((r) => r.uri).filter((u) => u.endsWith("SKILL.md"));
seen.prompt = /next-zones/.test((await rpc("prompts/get", { name: "next-zones" })).body.result?.messages?.[0]?.content?.text ?? "");
seen.foreignOrigin = (await rpc("ping", {}, { origin: "https://evil.example" })).status;
seen.adminEndpoint = (await fetch(`${BASE}/_next-zones/images`)).status;

const wrong = {};
if (seen.initialize.version !== "2025-11-25" || seen.initialize.server !== "next-zones" || !seen.initialize.capabilities.includes("resources")) wrong.initialize = seen.initialize;
for (const t of ["zones_status", "zones_images", "zones_pull", "zones_install", "zones_metrics", "shell_versions"]) if (!seen.tools.includes(t)) wrong.tools = seen.tools;
if (!seen.afterV1.ok || seen.afterV1.page !== "zone blog v1") wrong.afterV1 = seen.afterV1;
if (!seen.afterV2.ok || seen.afterV2.page !== "zone blog v2") wrong.afterV2 = seen.afterV2;
if (!seen.rolledBack.ok || seen.rolledBack.page !== "zone blog v1") wrong.rolledBack = seen.rolledBack;
if (seen.status?.blog !== "1") wrong.status = seen.status;
if (!seen.images.includes("blog")) wrong.images = seen.images;
if (!seen.shopPull.isError || !/live pull/i.test(seen.shopPull.text)) wrong.shopPull = seen.shopPull;
if (!seen.blogPull.isError || /live pull/i.test(seen.blogPull.text)) wrong.blogPull = seen.blogPull;
if (seen.metrics < 1) wrong.metrics = metrics.slice(0, 300);
if (seen.shellTool?.blog !== "1") wrong.shellTool = seen.shellTool;
if (seen.badArgs !== -32602) wrong.badArgs = seen.badArgs;
if (!seen.resources.includes("skill://next-zones/SKILL.md") || !seen.prompt) wrong.skills = { resources: seen.resources, prompt: seen.prompt };
if (seen.foreignOrigin !== 403) wrong.foreignOrigin = seen.foreignOrigin;
if (seen.adminEndpoint !== 404) wrong.adminEndpoint = seen.adminEndpoint;
console.log(JSON.stringify({ seen, wrong }, null, 2));
