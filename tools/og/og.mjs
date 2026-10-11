#!/usr/bin/env node
/*
 * The site's social image (og:image), 1200×630, no text: next-zones as an isometric scene. One slab is the one process
 * and its shell; the blocks standing on it are zones, of their own heights and colours; arcs between their tops are
 * soft navigations; one socket is empty, its zone's new version coming down into it, the version it replaces lifting
 * away as a ghost.
 *
 *   node tools/og/og.mjs          (writes tools/og/og.svg and tools/og/og.png; tools/site.mjs copies the png)
 *
 * Rendered by Chromium (playwright) and packed to a palette PNG (sharp), both from the spike's node_modules.
 */
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { createRequire } from "node:module";

const here = path.dirname(fileURLToPath(import.meta.url));
const spike = createRequire(path.join(here, "..", "..", "spikes", "zones", "package.json"));
const W = 1200, H = 630;

/* Isometric projection: x to the right and down, y to the left and down, z up. */
const S = 52, C = Math.cos(Math.PI / 6), N = Math.sin(Math.PI / 6);
const O = { x: 535, y: 150 };
const P = (x, y, z) => [O.x + (x - y) * C * S, O.y + (x + y) * N * S - z * S];
const pts = (list) => list.map((p) => P(...p).map((v) => v.toFixed(1)).join(",")).join(" ");

/* A box: its top, its +x face (lit), its +y face (shaded). */
function box(x, y, z, w, d, h, [top, right, left], extra = "") {
  return `<g ${extra}>
  <polygon points="${pts([[x, y + d, z], [x + w, y + d, z], [x + w, y + d, z + h], [x, y + d, z + h]])}" fill="${left}"/>
  <polygon points="${pts([[x + w, y, z], [x + w, y + d, z], [x + w, y + d, z + h], [x + w, y, z + h]])}" fill="${right}"/>
  <polygon points="${pts([[x, y, z + h], [x + w, y, z + h], [x + w, y + d, z + h], [x, y + d, z + h]])}" fill="${top}"/>
</g>`;
}
const topCenter = (x, y, z, w, d) => P(x + w / 2, y + d / 2, z);

/* Colours: the site's blue, and a zone palette, each as top, lit side, shaded side. */
const BG = "#0b1324";
const SLAB = ["#1b2c52", "#14213f", "#0f1a33"];
const ZONES = {
  blue: ["#4f7cff", "#3a63e0", "#2a4cb8"],
  teal: ["#2fd3b5", "#21b096", "#178a76"],
  violet: ["#9b7bff", "#7f5ee6", "#6447c2"],
  amber: ["#ffbf4d", "#e9a32c", "#c4831b"],
  rose: ["#ff7a9c", "#e65e81", "#c04667"],
};

/* The slab: the one process, the shell. 10 × 7, 0.7 high. */
const slab = { x: 0, y: 0, w: 10, d: 7, h: 0.7 };
const Z0 = slab.h;
/* The zones on it: [x, y, w, d, height, colour]. */
const zones = [
  [0.9, 0.9, 2, 2, 2.4, "blue"],
  [4.1, 0.8, 2, 2, 1.5, "teal"],
  [7.2, 0.9, 1.9, 1.9, 2.9, "violet"],
  [1.0, 4.2, 1.9, 1.9, 1.3, "amber"],
];
/* The socket whose zone is being replaced, at the front, and its new version coming down into it. */
const socket = { x: 6.8, y: 4.4, w: 2, d: 2 };
const incoming = { ...socket, z: Z0 + 1.7, h: 1.6, colour: "rose" };

function scene() {
  const out = [];
  /* Background: a faint grid of points, and a glow behind the slab. */
  out.push(`<rect width="${W}" height="${H}" fill="${BG}"/>`);
  out.push(`<defs>
  <radialGradient id="glow" cx="50%" cy="58%" r="55%"><stop offset="0" stop-color="#2357d6" stop-opacity=".45"/><stop offset="1" stop-color="#2357d6" stop-opacity="0"/></radialGradient>
  <pattern id="dots" width="24" height="24" patternUnits="userSpaceOnUse"><circle cx="2" cy="2" r="1.1" fill="#ffffff" fill-opacity=".06"/></pattern>
  <linearGradient id="beam" x1="0" y1="0" x2="0" y2="1"><stop offset="0" stop-color="#ff7a9c" stop-opacity="0"/><stop offset="1" stop-color="#ff7a9c" stop-opacity=".55"/></linearGradient>
</defs>`);
  out.push(`<rect width="${W}" height="${H}" fill="url(#dots)"/>`);
  out.push(`<ellipse cx="600" cy="380" rx="560" ry="250" fill="url(#glow)"/>`);
  /* The slab, and its edge line. */
  out.push(box(slab.x, slab.y, 0, slab.w, slab.d, slab.h, SLAB));
  out.push(`<polygon points="${pts([[0, 0, Z0], [10, 0, Z0], [10, 7, Z0], [0, 7, Z0]])}" fill="none" stroke="#3b5bb0" stroke-opacity=".55" stroke-width="1.5"/>`);
  /* A grid on the slab's top, the cells zones take. */
  for (let i = 1; i < 10; i++) out.push(`<polyline points="${pts([[i, 0, Z0], [i, 7, Z0]])}" stroke="#ffffff" stroke-opacity=".05" fill="none"/>`);
  for (let j = 1; j < 7; j++) out.push(`<polyline points="${pts([[0, j, Z0], [10, j, Z0]])}" stroke="#ffffff" stroke-opacity=".05" fill="none"/>`);
  /* The socket: a dashed outline, and the beam the new version comes down. */
  out.push(`<polygon points="${pts([[socket.x, socket.y, Z0], [socket.x + socket.w, socket.y, Z0], [socket.x + socket.w, socket.y + socket.d, Z0], [socket.x, socket.y + socket.d, Z0]])}" fill="#ff7a9c" fill-opacity=".12" stroke="#ff7a9c" stroke-width="2" stroke-dasharray="7 6"/>`);
  out.push(`<polygon points="${pts([[socket.x, socket.y + socket.d, Z0], [socket.x + socket.w, socket.y + socket.d, Z0], [socket.x + socket.w, socket.y + socket.d, incoming.z], [socket.x, socket.y + socket.d, incoming.z]])}" fill="url(#beam)" opacity=".5"/>`);
  out.push(`<polygon points="${pts([[socket.x + socket.w, socket.y, Z0], [socket.x + socket.w, socket.y + socket.d, Z0], [socket.x + socket.w, socket.y + socket.d, incoming.z], [socket.x + socket.w, socket.y, incoming.z]])}" fill="url(#beam)" opacity=".35"/>`);
  /* Zones, drawn back to front (by x + y). */
  const items = zones.map(([x, y, w, d, h, c]) => ({ x, y, w, d, h, c }));
  for (const z of [...items].sort((a, b) => a.x + a.y - (b.x + b.y))) out.push(box(z.x, z.y, Z0, z.w, z.d, z.h, ZONES[z.c]));
  /* The version being replaced, lifting away as a ghost, and the new one coming down. */
  out.push(box(socket.x + 0.9, socket.y - 1.4, Z0 + 4.6, 1.5, 1.5, 1.2, ["#ff7a9c", "#e65e81", "#c04667"], `opacity=".18"`));
  out.push(box(incoming.x, incoming.y, incoming.z, incoming.w, incoming.d, incoming.h, ZONES[incoming.colour]));
  /* Motion ticks under the new version. */
  const [cx, cy] = P(incoming.x + incoming.w / 2, incoming.y + incoming.d / 2, incoming.z - 0.25);
  for (const [dx, len] of [[-34, 26], [0, 38], [34, 26]]) out.push(`<line x1="${(cx + dx).toFixed(1)}" y1="${(cy + 34).toFixed(1)}" x2="${(cx + dx).toFixed(1)}" y2="${(cy + 34 + len).toFixed(1)}" stroke="#ff7a9c" stroke-opacity=".6" stroke-width="3" stroke-linecap="round"/>`);
  /* Soft navigations: arcs between the zones' tops, a dot travelling on each. */
  const tops = items.map((z) => topCenter(z.x, z.y, Z0 + z.h, z.w, z.d));
  const arcs = [[0, 1], [1, 2], [0, 3], [3, 1]];
  for (const [a, b] of arcs) {
    const [x1, y1] = tops[a], [x2, y2] = tops[b];
    const mx = (x1 + x2) / 2, my = Math.min(y1, y2) - 70;
    out.push(`<path d="M${x1.toFixed(1)},${y1.toFixed(1)} Q${mx.toFixed(1)},${my.toFixed(1)} ${x2.toFixed(1)},${y2.toFixed(1)}" fill="none" stroke="#9fb8ff" stroke-opacity=".7" stroke-width="2.2" stroke-linecap="round"/>`);
    const t = 0.55, qx = (1 - t) ** 2 * x1 + 2 * (1 - t) * t * mx + t * t * x2, qy = (1 - t) ** 2 * y1 + 2 * (1 - t) * t * my + t * t * y2;
    out.push(`<circle cx="${qx.toFixed(1)}" cy="${qy.toFixed(1)}" r="5" fill="#ffffff"/>`);
  }
  for (const [x, y] of tops) out.push(`<circle cx="${x.toFixed(1)}" cy="${y.toFixed(1)}" r="4.5" fill="#ffffff" fill-opacity=".9"/>`);
  return `<svg xmlns="http://www.w3.org/2000/svg" width="${W}" height="${H}" viewBox="0 0 ${W} ${H}">\n${out.join("\n")}\n</svg>\n`;
}

const svg = scene();
fs.writeFileSync(path.join(here, "og.svg"), svg);
const { chromium } = spike("playwright");
const browser = await chromium.launch();
const page = await browser.newPage({ viewport: { width: W, height: H } });
await page.setContent(`<!doctype html><html><body style="margin:0">${svg}</body></html>`);
const raw = await page.screenshot({ type: "png" });
await browser.close();
const sharp = spike("sharp");
const png = await sharp(raw).png({ palette: true, quality: 90, effort: 10, compressionLevel: 9 }).toBuffer();
fs.writeFileSync(path.join(here, "og.png"), png);
console.log(`tools/og/og.png: ${W}×${H}, ${(png.length / 1024).toFixed(1)} KB (from ${(raw.length / 1024).toFixed(1)} KB)`);
