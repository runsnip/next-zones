"use strict";
/*
 * A zone's files: its static output (chunks, CSS, fonts, imported media), its synthesized main chunk, and its public/.
 *
 * Served by Zones before Next sees the request (server.cjs), and handed to Next's image optimizer (hooks.cjs), whose
 * internal fetch calls Next's handler directly and so never reaches Zones' HTTP layer. A zone's public files live
 * under its mount (public/blog/…, served at /blog/…) and, as in Next, take precedence over its dynamic routes.
 *
 * A build's static files are named by their content and never change, and a tab opened on a version that has since
 * been replaced still asks for that version's chunks (a lazy one, a prefetch): they are served from every image still
 * in the store, not only the active versions, so a swap or a rollback never breaks an open tab.
 */
const fs = require("node:fs");
const path = require("node:path");
const { siblingsOf, contentAddressed, DEFAULT_HASH_QUERY } = require("./send.cjs");

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
/* Every file under a folder, as URL paths ("/blog/logo.png"). */
function listFiles(root) {
  const files = new Set();
  try {
    for (const entry of fs.readdirSync(root, { withFileTypes: true, recursive: true })) {
      if (entry.isFile()) files.add(`/${path.relative(root, path.join(entry.parentPath, entry.name)).split(path.sep).join("/")}`);
    }
  } catch {}
  return files;
}

function createAssets(ctx) {
  const shellStatic = path.join(ctx.shell, ".next", "static");
  /* The static folders of every image in the store, read again at most once a second (a miss is rare: the shell's
     files and the active versions' are found first). */
  let stored = { at: 0, dirs: [] };
  const storedStatic = () => {
    if (Date.now() - stored.at < 1000) return stored.dirs;
    const dirs = [];
    try {
      for (const zone of fs.readdirSync(ctx.store, { withFileTypes: true })) {
        if (!zone.isDirectory()) continue;
        for (const version of fs.readdirSync(path.join(ctx.store, zone.name), { withFileTypes: true })) {
          if (version.isDirectory()) dirs.push(path.join(ctx.store, zone.name, version.name, "static"));
        }
      }
    } catch {}
    stored = { at: Date.now(), dirs };
    return dirs;
  };
  /** The file a URL names among the zones' files, or null (the shell's own, or nothing). `searchParams` (the URL's
      query) makes a public file immutable when it names the file by content (the zone's hashQuery). */
  function zoneAsset(pathname, searchParams) {
    let decoded;
    try { decoded = decodeURIComponent(pathname); } catch { return null; }
    if (decoded.startsWith("/_next/static/")) {
      const rel = decoded.slice("/_next/static/".length);
      /* A stopped zone's too: a tab opened before it stopped may still ask for them. */
      for (const z of [...ctx.zones.values(), ...ctx.stopped.values()]) {
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
      for (const root of storedStatic()) {
        const file = path.join(root, rel);
        if (inside(root, file) && fs.existsSync(file) && fs.statSync(file).isFile()) return { file, contentType: contentTypeOf(file), cacheControl: IMMUTABLE };
      }
      return null;
    }
    const zone = ctx.zoneOfRoute(decoded);
    if (!zone?.publicDir) return null;
    /* The zone's public files, listed once per installed version (an image never changes): a page's request asks no
       file system. */
    zone.publicFiles ??= listFiles(zone.publicDir);
    if (!zone.publicFiles.has(decoded)) return null;
    const file = path.join(zone.publicDir, decoded);
    /* Its precompressed siblings (logo.svg.br, logo.svg.gz), found in the same listing: send.cjs picks one by the
       request's Accept-Encoding. */
    const encodings = siblingsOf(file, (sibling) => zone.publicFiles.has(decoded + sibling.slice(file.length)));
    /* Next's default for public/, unless the URL names the file by content (?h=<hash>): then it never changes. */
    const cacheControl = contentAddressed(searchParams, zone.hashQuery ?? DEFAULT_HASH_QUERY) ? IMMUTABLE : "public, max-age=0";
    return { file, contentType: contentTypeOf(file), cacheControl, encodings };
  }
  return { zoneAsset };
}

module.exports = { createAssets };
