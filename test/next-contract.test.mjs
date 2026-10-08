import { test } from "node:test";
import assert from "node:assert/strict";
import { createRequire } from "node:module";

const { locateNext, NextContractError, SUPPORTED } = createRequire(import.meta.url)("../src/zones/next-contract.cjs");
const fakeNext = (version, missing = []) => Object.assign((id) => {
  if (id === "next/package.json") return { version };
  throw new Error(`not loaded in this test: ${id}`);
}, { resolve: (id) => { if (missing.some((m) => id.endsWith(m))) { const e = new Error("gone"); e.code = "MODULE_NOT_FOUND"; throw e; } return `/fake/${id}`; } });

test("a supported Next is located", () => {
  const located = locateNext({ requireNext: fakeNext(SUPPORTED[0]), options: {} });
  assert.equal(located.version, SUPPORTED[0]);
  assert.equal(located.files.filesystem, "/fake/next/dist/server/lib/router-utils/filesystem");
});

test("an unchecked Next is refused, unless unsupportedNext", () => {
  assert.throws(() => locateNext({ requireNext: fakeNext("99.0.0"), options: {} }), (e) => e instanceof NextContractError && /Next 99\.0\.0 has not been checked/.test(e.message));
  assert.equal(locateNext({ requireNext: fakeNext("99.0.0"), options: { unsupportedNext: true } }).version, "99.0.0");
});

test("every problem is listed at once", () => {
  assert.throws(() => locateNext({ requireNext: fakeNext("99.0.0", ["router-utils/filesystem", "lib/lru-cache"]), options: {} }),
    (e) => /99\.0\.0 has not been checked/.test(e.message) && /filesystem: cannot be resolved/.test(e.message) && /lru-cache: cannot be resolved/.test(e.message));
});
