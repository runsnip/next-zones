/*
 * A workspace of zones, read from source: the zones found in one or more folders, and what their declarations must
 * agree on. Used by `next-zones check`, `next-zones doctor` and the composer.
 */
import fs from "node:fs";
import path from "node:path";
import { readZone } from "./config.mjs";

const SKIP = new Set(["node_modules", ".next", ".zones-dev", ".zones-store", ".zones-cache", ".git"]);

/**
 * The zones in each folder: every sub-folder (or link to one) whose next.config uses zoneConfig. A folder that fails
 * to load its next.config is reported in `failed`, not thrown.
 * @returns {Promise<{ zones: { name, dir, mount, aliases }[], failed: { name, error }[] }>}
 */
export async function findZones(dirs) {
  const zones = [], failed = [];
  for (const parent of dirs) {
    for (const entry of fs.readdirSync(parent, { withFileTypes: true })) {
      if (SKIP.has(entry.name) || entry.name.startsWith(".") || entry.name.includes("@")) continue;
      let dir;
      try { dir = fs.realpathSync(path.join(parent, entry.name)); } catch { continue; }
      if (!fs.statSync(dir).isDirectory()) continue;
      try {
        const zone = await readZone(dir);
        if (zone) zones.push({ name: entry.name, dir, ...zone });
      } catch (error) {
        failed.push({ name: entry.name, error: error.message });
      }
    }
  }
  return { zones, failed };
}

/** What the zones' declarations must agree on: mounts, one shell, aliases. Returns the problems found. */
export function declarationProblems(zones) {
  const problems = [];
  const owners = new Map();
  for (const z of zones) {
    if (z.mount !== "/" && !/^\/[a-z0-9][a-z0-9-]*$/.test(z.mount ?? "")) {
      problems.push(`${z.name}: mount must be "/" or one URL segment like "/blog", got ${JSON.stringify(z.mount)}`);
      continue;
    }
    owners.set(z.mount, [...(owners.get(z.mount) ?? []), z.name]);
  }
  for (const [mount, names] of owners) {
    if (names.length > 1) problems.push(`${mount} is claimed by ${names.length} zones: ${names.join(", ")}`);
  }
  const aliasOwners = new Map();
  for (const z of zones) {
    for (const a of z.aliases ?? []) {
      const first = `/${a.source.split("/")[1]}`;
      if (owners.has(first)) problems.push(`${z.name}: alias ${a.source} lands on the mount of ${owners.get(first).join(", ")}`);
      aliasOwners.set(first, [...(aliasOwners.get(first) ?? []), z.name]);
    }
  }
  for (const [first, names] of aliasOwners) {
    if (new Set(names).size > 1) problems.push(`aliases under ${first} are claimed by ${[...new Set(names)].join(", ")}`);
  }
  if (!owners.has("/")) problems.push(`no zone owns "/": exactly one zone, the shell, must declare "mount": "/"`);
  return problems;
}

/**
 * The not-found page a zone has of its own, from its sources, as a page of its build, the one Next renders a 404 with
 * when the zone runs alone: with an app/ folder, the App Router's ("/_not-found/page", from app/not-found or
 * app/global-not-found; Next then renders no pages/404), else the Pages Router's ("/404" from pages/404, "/_error" from
 * pages/_error). null when it has none: Next's default would render, and the shell's answers for it instead.
 */
export function ownNotFound(dir) {
  const app = notFoundFile(dir, "app", "not-found") ?? notFoundFile(dir, "app", "global-not-found");
  if (routerDir(dir, "app")) return app ? "/_not-found/page" : null;
  if (!routerDir(dir, "pages")) return null;
  return notFoundFile(dir, "pages", "404") ? "/404" : notFoundFile(dir, "pages", "_error") ? "/_error" : null;
}

/** A zone's app/ or pages/ folder (or under src/), if it has one. */
export const routerDir = (dir, router) => ["", "src"].map((sub) => path.join(dir, sub, router)).find((d) => fs.existsSync(d)) ?? null;

/** The file of one of a zone's own pages at the top of its app/ or pages/ ("not-found", "404"…), if it has it. */
export function notFoundFile(dir, router, name) {
  const at = routerDir(dir, router);
  if (!at) return null;
  return ["tsx", "ts", "jsx", "js", "mjs", "mdx"].map((ext) => path.join(at, `${name}.${ext}`)).find((f) => fs.existsSync(f)) ?? null;
}
