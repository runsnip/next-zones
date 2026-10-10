/** A JSON Schema of an object (a tool's arguments or structured result). */
export interface ObjectSchema {
  type: "object";
  properties?: Record<string, unknown>;
  required?: string[];
  additionalProperties?: boolean | Record<string, unknown>;
  [keyword: string]: unknown;
}

/** Who called: from a Bearer token, an OAuth access token, or the admin rule. */
export interface Principal {
  scheme: "bearer" | "oauth" | "admin";
  subject: string | null;
  /** The caller's scopes; null: every scope (a static token, the admin rule). */
  scopes: string[] | null;
  /** The token's claims (OAuth), or what a Bearer's verify returned. */
  claims: Record<string, unknown>;
}

/** What a tool's handler may do with Zones: only the parts its Tool({ zones }) declares. */
export interface ZonesApi {
  /** "read": the active versions, boot failures, uptime and memory. */
  status?(): object;
  /** "read": the zone images in the store, by zone. */
  images?(): Record<string, object[]>;
  /** "read": the metrics as Prometheus text, filtered by a name prefix or a /regex/ (needs the shell's metrics: true). */
  metrics?(match?: string): string;
  /** "pull": pulls a version into the store (the zone must allow live pulls). */
  pull?(zone: string, version: string): Promise<{ pulledFrom: string | null }>;
  /** "install": installs, swaps to or rolls back to a version (pulled first when missing, with live pulls). */
  install?(zone: string, version: string): Promise<object>;
  /** "prune": removes zone images no longer needed. */
  prune?(options?: { keep?: number; dryRun?: boolean }): Promise<object>;
}

export interface ToolContext {
  zones: ZonesApi;
  auth: Principal;
  /** Aborts when the client goes away or the call passes its timeoutMs. */
  signal: AbortSignal;
}

/** What a handler returns: text, structured content, or an MCP CallToolResult. */
export type ToolResult = string | Record<string, unknown> | { content: unknown[]; structuredContent?: Record<string, unknown>; isError?: boolean } | null | undefined;

export interface ToolOptions<Args = Record<string, unknown>> {
  name: string;
  title?: string;
  description: string;
  /** Its arguments' JSON Schema; checked before the handler runs. */
  input?: ObjectSchema;
  /** Its structured result's JSON Schema. */
  output?: ObjectSchema;
  annotations?: { title?: string; readOnlyHint?: boolean; destructiveHint?: boolean; idempotentHint?: boolean; openWorldHint?: boolean };
  /** OAuth scopes a caller needs for it. */
  scopes?: string[];
  /** What its handler may do with Zones; none by default. */
  zones?: Array<"read" | "pull" | "install" | "prune">;
  /** A call that runs longer fails, and its signal aborts (default 30 000). */
  timeoutMs?: number;
  handler(args: Args, context: ToolContext): ToolResult | Promise<ToolResult>;
}

declare const brand: unique symbol;
export interface McpTool { readonly [brand]: "tool"; name: string }
export interface McpSkill { readonly [brand]: "skill" }
export interface McpAuth { readonly [brand]: "auth" }
export interface McpServer { readonly [brand]: "mcp" }

export interface McpOptions {
  /** Where it answers (default "<endpoints base>/mcp", "/_next-zones/mcp"). */
  path?: string;
  /** Its canonical URL (the OAuth resource and audience), when a proxy hides it. */
  url?: string;
  name?: string;
  version?: string;
  instructions?: string;
  tools: McpTool[] | McpTool;
  skills?: McpSkill[];
  /** A request passes with any one; without auth, the admin rule. */
  auth?: McpAuth[] | McpAuth;
  /** Browser origins allowed besides the server's own. */
  origins?: string[];
  /** What checks OAuth tokens (default: @runsnip/jwks, an optional peer dependency needed only with OAuth). */
  jwks?: JwksImplementation;
}

/** The contract of @runsnip/jwks that the MCP server uses: give another implementation as Mcp({ jwks }). */
export interface JwksImplementation {
  createAccessTokenVerifier(options: {
    issuer: string;
    audience: string;
    scopes?: string[];
    clockToleranceS?: number;
    jwksUri?: string;
    algorithms?: string[];
    fetch?: typeof fetch;
  }): (token: string) => Promise<VerifiedAccessToken>;
  introspectAccessToken?(token: string, options: {
    endpoint: string;
    clientId?: string;
    clientSecret?: string;
    issuer?: string;
    audience?: string;
    scopes?: string[];
    fetch?: typeof fetch;
  }): Promise<VerifiedAccessToken>;
}

/** What a verifier returns; a refusal throws an error whose code is @runsnip/jwks' (ERR_JWT_CLAIM with claim "scope" for a
    missing scope: 403; ERR_JWKS_FETCH, ERR_DISCOVERY, ERR_INTROSPECTION: 500; anything else: 401). */
export interface VerifiedAccessToken {
  payload: Record<string, unknown>;
  scopes: string[];
  subject: string | null;
}

/** Zones' MCP server, for the shell's zoneConfig({ mcp }). */
export function Mcp(options: McpOptions): McpServer;
/** The server's tools: Tool(…), LivePull(), Metrics(), or lists of them. */
export function Tools(...tools: Array<McpTool | McpTool[]>): McpTool[];
/** A tool of your own. It runs in Zones' process: run code you do not trust elsewhere, behind a tool that calls it. */
export function Tool<Args = Record<string, unknown>>(options: ToolOptions<Args>): McpTool;
/** zones_status, zones_images, zones_pull and zones_install. */
export function LivePull(options?: { tools?: Array<"status" | "images" | "pull" | "install">; scopes?: string[] }): McpTool[];
/** zones_metrics (needs the shell's metrics: true). */
export function Metrics(options?: { scopes?: string[] }): McpTool[];
/** Skills as resources (skill://<name>/<file>) and prompts: folders holding a SKILL.md (paths from the shell's folder, or file: URLs), or Skill(…). */
export function Skills(...skills: Array<string | URL | McpSkill | Array<string | URL | McpSkill>>): McpSkill[];
export function Skill(options: { name: string; description: string; content: string; files?: Record<string, string> }): McpSkill;
/** next-zones' own skill. */
export function NextZonesSkill(): McpSkill;
/** Static bearer tokens (16 characters or more), one from the environment, or a verify function. */
export function Bearer(options: { token?: string; tokens?: string[]; env?: string; verify?(token: string, request: { headers: Record<string, string | string[] | undefined> }): unknown }): McpAuth;
/** OAuth 2.1 access tokens from an authorization server, Zones being the resource server (MCP authorization). */
export function OAuth(options: {
  issuer: string;
  audience?: string;
  jwksUri?: string;
  algorithms?: string[];
  scopes?: string[];
  introspection?: { url: string; clientId?: string; clientSecret?: string };
}): McpAuth;
