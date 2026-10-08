import { test } from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { createRequire } from "node:module";

const { digestBuild } = createRequire(import.meta.url)("../src/zones/describe.cjs");

test("a build's digest covers every file's path and content, zone.json aside", () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "nz-digest-"));
  try {
    fs.mkdirSync(path.join(dir, "server"));
    fs.writeFileSync(path.join(dir, "server", "a.js"), "a");
    fs.writeFileSync(path.join(dir, "BUILD_ID"), "x");
    const first = digestBuild(dir);
    assert.equal(first.files, 2);
    fs.writeFileSync(path.join(dir, "zone.json"), "{}");
    assert.equal(digestBuild(dir).digest, first.digest, "zone.json is not part of it");
    fs.writeFileSync(path.join(dir, "server", "a.js"), "b");
    assert.notEqual(digestBuild(dir).digest, first.digest, "content");
    fs.writeFileSync(path.join(dir, "server", "a.js"), "a");
    fs.renameSync(path.join(dir, "server", "a.js"), path.join(dir, "server", "c.js"));
    assert.notEqual(digestBuild(dir).digest, first.digest, "path");
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
  }
});
