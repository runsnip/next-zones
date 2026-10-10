"use strict";
/*
 * Who may call Zones' MCP server (zones/mcp.cjs), from Mcp({ auth }) (../mcp.cjs):
 * - Bearer: static tokens (compared in constant time) or a verify function of the owner's;
 * - OAuth: the MCP authorization spec's resource server, with @runsnip/jwks (an optional peer dependency) or another
 *   implementation of its contract given as Mcp({ jwks }). A JWT access token is checked against the
 *   issuer's key set (found from its metadata, kept, fetched again for a key rotated in): signature, iss, aud (this
 *   server), exp and nbf (60 s of leeway), scopes. With introspection, any token the issuer confirms active (RFC 7662).
 *   A request without a valid token gets 401 and WWW-Authenticate pointing at the protected resource metadata
 *   (RFC 9728), which names the issuer;
 * - none declared: the admin rule (Bearer <adminToken>, or a request from the same machine when no token is set).
 * A principal is { scheme, subject, scopes: string[] | null (null: every scope), claims }.
 */
const crypto = require("node:crypto");

const sameSecret = (a, b) => crypto.timingSafeEqual(crypto.createHash("sha256").update(a).digest(), crypto.createHash("sha256").update(b).digest());

class AuthError extends Error {
  constructor(message, { status = 401, error = "invalid_token", scope } = {}) { super(message); this.status = status; this.error = error; this.scope = scope; }
}

/* A refusal of @runsnip/jwks as the MCP server answers it: a missing scope is 403, the issuer unreachable is Zones'
   own failure (500), anything else an invalid token (401). */
function fromJwks(error, requiredScopes) {
  if (error?.code === "ERR_JWT_CLAIM" && error.claim === "scope") return new AuthError(error.message, { status: 403, error: "insufficient_scope", scope: requiredScopes.join(" ") });
  if (["ERR_JWKS_FETCH", "ERR_DISCOVERY", "ERR_INTROSPECTION"].includes(error?.code)) return new AuthError(`next-zones mcp: ${error.message}`, { status: 500, error: "server_error" });
  if (error?.code) return new AuthError(error.message);
  return error;
}

/**
 * The server's authentication.
 * @returns {{ authenticate(req, resource): Promise<object>, metadata(resource): object|null, challenge(metadataUrl, error): string }}
 */
/* What checks OAuth tokens: Mcp({ jwks }), else @runsnip/jwks, installed beside next-zones. */
function jwksOf(given) {
  if (given) return given;
  try { return require("@runsnip/jwks"); } catch (error) {
    if (error?.code !== "MODULE_NOT_FOUND" && error?.code !== "ERR_MODULE_NOT_FOUND") throw error;
    throw new Error("next-zones mcp: OAuth(…) checks tokens with @runsnip/jwks, which is not installed: npm install @runsnip/jwks, or give another implementation as Mcp({ jwks })");
  }
}

function createAuth(ctx, declared, { fetchImpl, jwks: given } = {}) {
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
    /* @runsnip/jwks (or Mcp({ jwks })), loaded only for OAuth. A verifier per audience: the declared one, or the server's
       canonical URL (one unless a proxy changes the host a request names). */
    const jwks = jwksOf(given);
    if (a.introspection && typeof jwks.introspectAccessToken !== "function") throw new Error("next-zones mcp: OAuth({ introspection }) needs introspectAccessToken in Mcp({ jwks })");
    const fetchOption = fetchImpl ? { fetch: fetchImpl } : {};
    const verifiers = new Map();
    const verifierFor = (audience) => {
      let verify = verifiers.get(audience);
      if (!verify) {
        verify = jwks.createAccessTokenVerifier({ issuer: a.issuer, audience, scopes: a.scopes, clockToleranceS: 60, ...(a.jwksUri ? { jwksUri: a.jwksUri } : {}), ...(a.algorithms ? { algorithms: a.algorithms } : {}), ...fetchOption });
        if (verifiers.size < 16) verifiers.set(audience, verify);
      }
      return verify;
    };
    return { scheme: "oauth", issuer: a.issuer, scopes: a.scopes, async check(token, req, resource) {
      const audience = a.audience ?? resource;
      let verified;
      try {
        if (a.introspection) {
          verified = await jwks.introspectAccessToken(token, { endpoint: a.introspection.url, clientId: a.introspection.clientId, clientSecret: a.introspection.clientSecret, issuer: a.issuer, audience, scopes: a.scopes, ...fetchOption });
        } else {
          if (token.split(".").length !== 3) return null;
          verified = await verifierFor(audience)(token);
        }
      } catch (error) {
        throw fromJwks(error, a.scopes);
      }
      return { scheme: "oauth", subject: verified.subject, scopes: verified.scopes, claims: verified.payload };
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

module.exports = { createAuth, AuthError };
