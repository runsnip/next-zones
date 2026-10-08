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
