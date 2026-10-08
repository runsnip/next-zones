"use strict";
/*
 * A zone's files: its static output (chunks, CSS, fonts, imported media), its synthesized main chunk, and its public/.
 *
 * Served by Zones before Next sees the request (server.cjs), and handed to Next's image optimizer (hooks.cjs), whose
 * internal fetch calls Next's handler directly and so never reaches Zones' HTTP layer. A zone's public files live
 * under its mount (public/blog/…, served at /blog/…) and, as in Next, take precedence over its dynamic routes.
 */
const fs = require("node:fs");
const path = require("node:path");

const CONTENT_TYPES = {
  ".js": "application/javascript", ".mjs": "application/javascript", ".css": "text/css", ".json": "application/json",
  ".map": "application/json", ".txt": "text/plain", ".html": "text/html", ".xml": "application/xml",
  ".woff2": "font/woff2", ".woff": "font/woff", ".ttf": "font/ttf", ".otf": "font/otf",
  ".png": "image/png", ".jpg": "image/jpeg", ".jpeg": "image/jpeg", ".gif": "image/gif", ".webp": "image/webp",
  ".avif": "image/avif", ".svg": "image/svg+xml", ".ico": "image/x-icon",
  ".mp4": "video/mp4", ".webm": "video/webm", ".mp3": "audio/mpeg", ".pdf": "application/pdf", ".wasm": "application/wasm",
};
const IMMUTABLE = "public, max-age=31536000, immutable";
const contentTypeOf = (file) => CONTENT_TYPES[path.extname(file).toLowerCase()] ?? "application/octet-stream";
const inside = (root, file) => file === root || file.startsWith(root + path.sep);

function createAssets(ctx) {
  const shellStatic = path.join(ctx.shell, ".next", "static");
  /** The file a URL names among the zones' files, or null (the shell's own, or nothing). */
  function zoneAsset(pathname) {
    let decoded;
    try { decoded = decodeURIComponent(pathname); } catch { return null; }
    if (decoded.startsWith("/_next/static/")) {
      const rel = decoded.slice("/_next/static/".length);
      for (const z of ctx.zones.values()) {
        if (z.mainChunks?.[0] === decoded) return { file: z.mainChunkFile, contentType: "application/javascript", cacheControl: IMMUTABLE };
        /* A chunk written again with remapped module ids (stage.cjs). */
        for (const url of Object.values(z.chunkUrls ?? {})) {
          if (url === decoded) return { file: path.join(z.chunkDir, path.basename(url)), contentType: "application/javascript", cacheControl: IMMUTABLE };
        }
      }
      if (fs.existsSync(path.join(shellStatic, rel))) return null;
      for (const z of ctx.zones.values()) {
        const root = path.join(z.dist, "static");
        const file = path.join(root, rel);
        if (inside(root, file) && fs.existsSync(file) && fs.statSync(file).isFile()) return { file, contentType: contentTypeOf(file), cacheControl: IMMUTABLE };
      }
      return null;
    }
    const zone = ctx.zoneOfRoute(decoded);
    if (!zone?.publicDir) return null;
    const file = path.join(zone.publicDir, decoded);
    if (!inside(zone.publicDir, file) || !fs.existsSync(file) || !fs.statSync(file).isFile()) return null;
    return { file, contentType: contentTypeOf(file), cacheControl: "public, max-age=0" };   // Next's default for public/
  }
  return { zoneAsset };
}

module.exports = { createAssets };
