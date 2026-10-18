/* The warm-up's option (zones/warm.cjs): what createZones({ warm }) takes, and --warm / NEXT_ZONES_WARM as text. */
import { test } from "node:test";
import assert from "node:assert/strict";
import { createRequire } from "node:module";

const { warmOptions, warmFromText } = createRequire(import.meta.url)("../src/zones/warm.cjs");

test("warm: on by default, each mount rendered; false is none; a list of paths, or bundles only", () => {
  assert.deepEqual(warmOptions(undefined), { routes: "mounts", timeoutMs: 10_000 });
  assert.deepEqual(warmOptions(true), { routes: "mounts", timeoutMs: 10_000 });
  assert.equal(warmOptions(false), null);
  assert.deepEqual(warmOptions({ routes: ["/", "/blog"], timeoutMs: 500 }), { routes: ["/", "/blog"], timeoutMs: 500 });
  assert.deepEqual(warmOptions({ routes: false }), { routes: false, timeoutMs: 10_000 });
});

test("warm: a wrong value is refused", () => {
  assert.throws(() => warmOptions("on"), /warm is false, true/);
  assert.throws(() => warmOptions({ routes: ["blog"] }), /warm.routes/);
  assert.throws(() => warmOptions({ routes: "all" }), /warm.routes/);
});

test("--warm and NEXT_ZONES_WARM: off, on, mounts, or comma-separated paths", () => {
  assert.equal(warmFromText(undefined), undefined);
  assert.equal(warmFromText(""), undefined);
  assert.equal(warmFromText("off"), false);
  assert.equal(warmFromText("on"), true);
  assert.deepEqual(warmFromText("mounts"), { routes: "mounts" });
  assert.deepEqual(warmFromText("/, /blog"), { routes: ["/", "/blog"] });
  assert.throws(() => warmOptions(warmFromText("blog")), /warm.routes/);
});
