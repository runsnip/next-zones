/* doctor clears `next dev`'s types before the type check (Next 16.3.8 rewrites .next/dev/types/validator.ts without
   truncating it: a shorter file over a longer one keeps the old tail). */
import { test } from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { clearDevTypes } from "../src/doctor.mjs";

test("a zone's .next/dev/types goes, .next/types and the rest stay", () => {
  const zone = fs.mkdtempSync(path.join(os.tmpdir(), "nz-devtypes-"));
  try {
    const dev = path.join(zone, ".next", "dev", "types"), built = path.join(zone, ".next", "types");
    fs.mkdirSync(dev, { recursive: true });
    fs.mkdirSync(built, { recursive: true });
    /* What the dev server left: a shorter list written over a longer one, the old tail after it. */
    fs.writeFileSync(path.join(dev, "validator.ts"), 'type A = "/a"\n}\n  "/old/route": true,\n}\n');
    fs.writeFileSync(path.join(dev, "routes.d.ts"), "export {}\n");
    fs.writeFileSync(path.join(built, "validator.ts"), 'type A = "/a"\n');
    fs.writeFileSync(path.join(zone, ".next", "dev", "build-manifest.json"), "{}");
    assert.equal(clearDevTypes(zone), true);
    assert.equal(fs.existsSync(dev), false);
    assert.equal(fs.readFileSync(path.join(built, "validator.ts"), "utf8"), 'type A = "/a"\n');
    assert.equal(fs.existsSync(path.join(zone, ".next", "dev", "build-manifest.json")), true, "only the types folder");
    assert.equal(clearDevTypes(zone), false, "nothing to clear the second time");
  } finally {
    fs.rmSync(zone, { recursive: true, force: true });
  }
});

test("a zone never run in dev: nothing to clear", () => {
  const zone = fs.mkdtempSync(path.join(os.tmpdir(), "nz-devtypes-"));
  try {
    assert.equal(clearDevTypes(zone), false);
  } finally {
    fs.rmSync(zone, { recursive: true, force: true });
  }
});
