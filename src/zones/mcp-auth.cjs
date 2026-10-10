"use strict";
/*
 * Who may call Zones' MCP server (zones/mcp.cjs), from Mcp({ auth }) (../mcp.cjs):
 * - Bearer: static tokens (compared in constant time) or a verify function of the owner's;
 * - OAuth: the MCP authorization spec's resource server. A JWT access token is checked against the issuer's keys
 *   (JWKS, found from its metadata, cached, fetched again for an unknown key id at most every 30 s): signature,
 *   iss, aud (this server), exp and nbf (60 s of leeway), scopes. With introspection, any token the issuer confirms
 *   active (RFC 7662). A request without a valid token gets 401 and WWW-Authenticate pointing at the protected
 *   resource metadata (RFC 9728), which names the issuer;
 * - none declared: the admin rule (Bearer <adminToken>, or a request from the same machine when no token is set).
 * A principal is { scheme, subject, scopes: string[] | null (null: every scope), claims }.
 */
const crypto = require("node:crypto");

const ALGORITHMS = { RS256: "sha256", RS384: "sha384", RS512: "sha512", PS256: "sha256", PS384: "sha384", PS512: "sha512", ES256: "sha256", ES384: "sha384", ES512: "sha512", EdDSA: null };
const DEFAULT_ALGORITHMS = ["RS256", "RS384", "RS512", "PS256", "PS384", "PS512", "ES256", "ES384", "EdDSA"];
const LEEWAY_S = 60;

const b64url = (s) => Buffer.from(s, "base64url");
const sameSecret = (a, b) => crypto.timingSafeEqual(crypto.createHash("sha256").update(a).digest(), crypto.createHash("sha256").update(b).digest());
const scopesOf = (claims) => (typeof claims.scope === "string" ? claims.scope.split(" ").filter(Boolean) : Array.isArray(claims.scp) ? claims.scp : typeof claims.scp === "string" ? claims.scp.split(" ") : []);

class AuthError extends Error {
  constructor(message, { status = 401, error = "invalid_token", scope } = {}) { super(message); this.status = status; this.error = error; this.scope = scope; }
}

/** The issuer's signing keys: kid → KeyObject, from its jwks_uri. */
function createKeySet({ issuer, jwksUri, fetchImpl = fetch }) {
  let keys = null, fetchedAt = 0, uri = jwksUri ?? null, inflight = null;
  async function discover() {
    for (const suffix of ["/.well-known/oauth-authorization-server", "/.well-known/openid-configuration"]) {
      const at = new URL(issuer);
      const url = `${at.origin}${suffix}${at.pathname === "/" ? "" : at.pathname}`;
      const res = await fetchImpl(url, { headers: { accept: "application/json" } }).catch(() => null);
      if (res?.ok) { const meta = await res.json(); if (meta.jwks_uri) return meta.jwks_uri; }
    }
    throw new AuthError(`next-zones mcp: the issuer ${issuer} publishes no jwks_uri`, { status: 500, error: "server_error" });
  }
  async function load() {
    uri ??= await discover();
    const res = await fetchImpl(uri, { headers: { accept: "application/json" } });
    if (!res.ok) throw new AuthError(`next-zones mcp: the issuer's keys (${uri}) answered ${res.status}`, { status: 500, error: "server_error" });
    const { keys: jwks = [] } = await res.json();
    const next = new Map();
    for (const jwk of jwks) {
      if (jwk.use && jwk.use !== "sig") continue;
      try { next.set(jwk.kid ?? "", { key: crypto.createPublicKey({ key: jwk, format: "jwk" }), alg: jwk.alg }); } catch {}
    }
    keys = next; fetchedAt = Date.now();
  }
  return async function keyFor(kid = "") {
    if (!keys || (!keys.has(kid) && Date.now() - fetchedAt > 30_000)) await (inflight ??= load().finally(() => { inflight = null; }));
    const found = keys.get(kid) ?? (kid === "" && keys.size === 1 ? [...keys.values()][0] : null);
    if (!found) throw new AuthError("the token's key is not one of the issuer's");
    return found;
  };
}

/** Checks a JWT: signature, then claims. Returns its claims. */
async function verifyJwt(token, { keyFor, issuer, audience, algorithms = DEFAULT_ALGORITHMS, now = Date.now() }) {
  const parts = token.split(".");
  if (parts.length !== 3) throw new AuthError("the token is not a JWT");
  let header, claims;
  try { header = JSON.parse(b64url(parts[0])); claims = JSON.parse(b64url(parts[1])); } catch { throw new AuthError("the token is not a JWT"); }
  if (!algorithms.includes(header.alg) || !(header.alg in ALGORITHMS)) throw new AuthError(`the token's algorithm ${header.alg} is not accepted`);
  const { key, alg } = await keyFor(header.kid);
  if (alg && alg !== header.alg) throw new AuthError("the token's algorithm is not its key's");
  const data = Buffer.from(`${parts[0]}.${parts[1]}`), signature = b64url(parts[2]);
  const hash = ALGORITHMS[header.alg];
  const options = header.alg.startsWith("PS") ? { key, padding: crypto.constants.RSA_PKCS1_PSS_PADDING, saltLength: crypto.constants.RSA_PSS_SALTLEN_DIGEST }
    : header.alg.startsWith("ES") ? { key, dsaEncoding: "ieee-p1363" } : key;
  if (!crypto.verify(hash, data, options, signature)) throw new AuthError("the token's signature does not hold");
  const s = Math.floor(now / 1000);
  if (claims.iss !== issuer) throw new AuthError("the token was issued by another authorization server");
  const aud = Array.isArray(claims.aud) ? claims.aud : [claims.aud];
  if (!aud.includes(audience)) throw new AuthError("the token is not for this server (its audience)");
  if (typeof claims.exp !== "number" || claims.exp + LEEWAY_S < s) throw new AuthError("the token has expired");
  if (typeof claims.nbf === "number" && claims.nbf - LEEWAY_S > s) throw new AuthError("the token is not valid yet");
  return claims;
}

/**
 * The server's authentication.
 * @returns {{ authenticate(req, resource): Promise<object>, metadata(resource): object|null, challenge(resource, error): string }}
 */
function createAuth(ctx, declared, { fetchImpl = fetch } = {}) {
  const isLocal = (req) => ["127.0.0.1", "::1", "::ffff:127.0.0.1"].includes(req.socket.remoteAddress);
  const methods = (declared ?? []).map((a) => {
    if (a.scheme === "bearer") {
      const tokens = [...a.tokens, ...(a.env && process.env[a.env] ? [process.env[a.env]] : [])];
      if (a.env && !process.env[a.env] && !a.tokens.length && !a.verify) throw new Error(`next-zones mcp: Bearer({ env: "${a.env}" }): ${a.env} is not set`);
      return { scheme: "bearer", async check(token, req) {
        if (tokens.some((t) => sameSecret(t, token))) return { scheme: "bearer", subject: null, scopes: null, claims: {} };
        if (a.verify) {
          const who = await a.verify(token, { headers: req.headers });
          if (who) return { scheme: "bearer", subject: who.subject ?? null, scopes: Array.isArray(who.scopes) ? who.scopes : null, claims: who };
        }
        return null;
      } };
    }
    const keyFor = createKeySet({ issuer: a.issuer, jwksUri: a.jwksUri, fetchImpl });
    return { scheme: "oauth", issuer: a.issuer, scopes: a.scopes, async check(token, req, resource) {
      const audience = a.audience ?? resource;
      let claims;
      if (a.introspection) {
        const body = new URLSearchParams({ token, token_type_hint: "access_token" });
        const headers = { "content-type": "application/x-www-form-urlencoded", accept: "application/json" };
        if (a.introspection.clientId) headers.authorization = `Basic ${Buffer.from(`${encodeURIComponent(a.introspection.clientId)}:${encodeURIComponent(a.introspection.clientSecret ?? "")}`).toString("base64")}`;
        const res = await fetchImpl(a.introspection.url, { method: "POST", headers, body });
        if (!res.ok) throw new AuthError(`next-zones mcp: introspection answered ${res.status}`, { status: 500, error: "server_error" });
        claims = await res.json();
        if (!claims.active) return null;
        if (claims.iss !== undefined && claims.iss !== a.issuer) return null;
        if (claims.aud !== undefined && !(Array.isArray(claims.aud) ? claims.aud : [claims.aud]).includes(audience)) return null;
        if (typeof claims.exp === "number" && claims.exp + LEEWAY_S < Date.now() / 1000) return null;
      } else {
        if (token.split(".").length !== 3) return null;
        claims = await verifyJwt(token, { keyFor, issuer: a.issuer, audience, algorithms: a.algorithms });
      }
      const scopes = scopesOf(claims);
      const missing = a.scopes.filter((s) => !scopes.includes(s));
      if (missing.length) throw new AuthError(`the token lacks the scopes ${missing.join(", ")}`, { status: 403, error: "insufficient_scope", scope: a.scopes.join(" ") });
      return { scheme: "oauth", subject: claims.sub ?? null, scopes, claims };
    } };
  });
  const oauth = methods.filter((m) => m.scheme === "oauth");

  return {
    /** The protected resource metadata (RFC 9728), when OAuth is declared. */
    metadata(resource) {
      if (!oauth.length) return null;
      const scopes = [...new Set(oauth.flatMap((m) => m.scopes))];
      return { resource, authorization_servers: oauth.map((m) => m.issuer), bearer_methods_supported: ["header"], ...(scopes.length ? { scopes_supported: scopes } : {}) };
    },
    /** WWW-Authenticate for a refusal. */
    challenge(metadataUrl, error) {
      const parts = [];
      if (oauth.length) parts.push(`resource_metadata="${metadataUrl}"`);
      if (error?.error && error.error !== "server_error") parts.push(`error="${error.error}"`);
      if (error?.scope) parts.push(`scope="${error.scope}"`);
      return `Bearer${parts.length ? ` ${parts.join(", ")}` : ""}`;
    },
    /** The caller, or an AuthError. */
    async authenticate(req, resource) {
      const header = req.headers.authorization ?? "";
      const token = /^Bearer\s+(\S+)$/i.exec(header)?.[1] ?? null;
      if (!methods.length) {
        const admin = ctx.options.adminToken;
        if (admin ? token !== null && sameSecret(admin, token) : isLocal(req)) return { scheme: "admin", subject: null, scopes: null, claims: {} };
        throw new AuthError(admin ? "next-zones mcp: the admin token is required" : "next-zones mcp: only a request from this machine (no auth declared, no admin token)", { error: token ? "invalid_token" : null });
      }
      if (!token) throw new AuthError("next-zones mcp: a bearer token is required", { error: null });
      let refusal = null;
      for (const m of methods) {
        try { const who = await m.check(token, req, resource); if (who) return who; } catch (error) { if (error instanceof AuthError && error.status !== 401) throw error; refusal = error; }
      }
      throw refusal instanceof AuthError ? refusal : new AuthError("next-zones mcp: the token is not accepted");
    },
  };
}

module.exports = { createAuth, verifyJwt, createKeySet, AuthError, scopesOf };
