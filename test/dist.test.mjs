import { test } from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";
import { createRequire } from "node:module";
import { fileURLToPath, pathToFileURL } from "node:url";
import { buildDist } from "../tools/build-dist.mjs";

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const pkg = JSON.parse(fs.readFileSync(path.join(root, "package.json"), "utf8"));

test("the published package is dist/, built from src/: every export and the command exist, directives kept", async () => {
  await buildDist();
  const targets = Object.values(pkg.exports).flatMap((v) => (typeof v === "string" ? [v] : Object.values(v)));
  for (const target of targets) assert.ok(fs.existsSync(path.join(root, target)), `${target} exists`);
  assert.ok(pkg.files.includes("dist") && !pkg.files.includes("src"), "dist is published, src is not");
  assert.match(fs.readFileSync(path.join(root, "dist", "client.mjs"), "utf8"), /^"use client";/);
  const cli = path.join(root, pkg.bin["next-zones"]);
  assert.match(fs.readFileSync(cli, "utf8"), /^#!\/usr\/bin\/env node\n/);
  assert.ok(fs.statSync(cli).mode & 0o111, "the command is executable");
});

test("each entry of dist/ loads by require and by import", async () => {
  const require = createRequire(import.meta.url);
  for (const sub of ["config", "build", "zones", "metrics", "sources"]) {
    const target = pkg.exports[`./${sub}`].default;
    const required = require(path.join(root, target));
    const imported = await import(pathToFileURL(path.join(root, target)).href);
    assert.ok(Object.keys(required).length > 0 && Object.keys(imported).length > 0, sub);
  }
});
