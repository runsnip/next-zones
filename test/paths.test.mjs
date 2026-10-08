/*
 * Every relative require/import in the package names its file with the exact case on disk. macOS finds "./Zones/x.cjs"
 * for "./zones/x.cjs"; Linux, where Zones serves, does not.
 */
import { test } from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const SPEC = /(?:require\(|import\(|from\s+|createRequire\([^)]*\)\()\s*["'](\.{1,2}\/[^"']+)["']/g;

/** Whether `target` exists with exactly this case, segment by segment from `root`. */
function existsExactly(target) {
  let dir = root;
  for (const segment of path.relative(root, target).split(path.sep)) {
    if (segment === "..") { dir = path.dirname(dir); continue; }
    if (!fs.existsSync(dir) || !fs.readdirSync(dir).includes(segment)) return false;
    dir = path.join(dir, segment);
  }
  return true;
}

function sources(dir) {
  return fs.readdirSync(dir, { withFileTypes: true }).flatMap((e) => {
    const full = path.join(dir, e.name);
    if (e.isDirectory()) return e.name === "node_modules" ? [] : sources(full);
    return /\.(c|m)?js$/.test(e.name) ? [full] : [];
  });
}

test("relative requires and imports match the case on disk", () => {
  const wrong = [];
  for (const file of [...sources(path.join(root, "src")), ...sources(path.join(root, "tools"))]) {
    for (const [, spec] of fs.readFileSync(file, "utf8").matchAll(SPEC)) {
      const target = path.resolve(path.dirname(file), spec);
      if (!existsExactly(target)) wrong.push(`${path.relative(root, file)}: ${spec}`);
    }
  }
  assert.deepEqual(wrong, []);
});
