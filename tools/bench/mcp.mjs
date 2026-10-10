/*
 * Zones' MCP server against the official SDK, serving the same tool (echo { text }): 3000 sequential tools/call over a
 * kept-alive connection after 300 warm-up, p50 and p99 (spikes/zones/RESULTS.md, "MCP").
 *
 *   node tools/bench/mcp.mjs own
 *   node tools/bench/mcp.mjs sdk <a folder where @modelcontextprotocol/sdk and zod are installed>
 */
import http from "node:http";
import path from "node:path";
import { createRequire } from "node:module";
const require = createRequire(import.meta.url);
const which = process.argv[2], N = 3000, WARM = 300;
const sdk = which === "sdk" ? createRequire(path.resolve(process.argv[3] ?? ".", "package.json")) : null;
let server;
if (which === "own") {
  const { Mcp, Tools, Tool } = require("../../src/mcp.cjs");
  const { createMcp } = require("../../src/zones/mcp.cjs");
  const mcp = createMcp({ options: {}, shell: process.cwd(), endpoints: null, metrics: null }, Mcp({ tools: Tools(Tool({ name: "echo", description: "Echo", input: { type: "object", properties: { text: { type: "string" } }, required: ["text"] }, handler: ({ text }) => text })) }), {});
  server = http.createServer((req, res) => mcp.handle(req, res, new URL(req.url, "http://x")));
} else {
  const { McpServer } = await import(sdk.resolve("@modelcontextprotocol/sdk/server/mcp.js"));
  const { StreamableHTTPServerTransport } = await import(sdk.resolve("@modelcontextprotocol/sdk/server/streamableHttp.js"));
  const { z } = await import(sdk.resolve("zod"));
  server = http.createServer(async (req, res) => {
    let body = ""; for await (const c of req) body += c;
    const s = new McpServer({ name: "sdk", version: "1" });
    s.registerTool("echo", { description: "Echo", inputSchema: { text: z.string() } }, async ({ text }) => ({ content: [{ type: "text", text }] }));
    const t = new StreamableHTTPServerTransport({ sessionIdGenerator: undefined, enableJsonResponse: true });
    res.on("close", () => { t.close(); s.close(); });
    await s.connect(t);
    await t.handleRequest(req, res, JSON.parse(body));
  });
}
await new Promise((r) => server.listen(0, "127.0.0.1", r));
const url = `http://127.0.0.1:${server.address().port}/_next-zones/mcp`;
const agent = new http.Agent({ keepAlive: true });
const post = (body) => new Promise((resolve, reject) => {
  const req = http.request(url, { method: "POST", agent, headers: { "content-type": "application/json", accept: "application/json, text/event-stream", "mcp-protocol-version": "2025-06-18" } }, (res) => { let t = ""; res.on("data", (d) => (t += d)); res.on("end", () => resolve(t)); });
  req.on("error", reject); req.end(body);
});
const body = JSON.stringify({ jsonrpc: "2.0", id: 1, method: "tools/call", params: { name: "echo", arguments: { text: "hi" } } });
const first = await post(body);
if (!first.includes("hi")) { console.error("bad", first); process.exit(1); }
const times = [];
for (let i = 0; i < N + WARM; i++) { const t = process.hrtime.bigint(); await post(body); if (i >= WARM) times.push(Number(process.hrtime.bigint() - t) / 1e6); }
times.sort((a, b) => a - b);
console.log(which, "p50", times[N / 2 | 0].toFixed(3), "p99", times[N * 0.99 | 0].toFixed(3), "ms");
server.close(); agent.destroy();
