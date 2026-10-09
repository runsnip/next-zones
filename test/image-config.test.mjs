import { test } from "node:test";
import assert from "node:assert/strict";
import { createRequire } from "node:module";

const { imageKeysDiffering } = createRequire(import.meta.url)("../src/zones/image-config.cjs");
const shell = { remotePatterns: [{ hostname: "images.example.com" }] };
const built = { remotePatterns: [], domains: [], localPatterns: [{ pathname: "**", search: "" }], unoptimized: false, dangerouslyAllowSVG: false, dangerouslyAllowLocalIP: false };

test("a zone without an images config fits a shell that has one, in its source and in its build", () => {
  assert.deepEqual(imageKeysDiffering(undefined, shell), []);
  assert.deepEqual(imageKeysDiffering(built, shell), []);
});

test("a zone's own images config is refused where it differs from the shell's, and accepted where it equals it", () => {
  assert.deepEqual(imageKeysDiffering({ ...built, remotePatterns: [{ hostname: "cdn.example.com" }] }, shell), ["remotePatterns"]);
  assert.deepEqual(imageKeysDiffering({ ...built, remotePatterns: shell.remotePatterns }, shell), []);
  assert.deepEqual(imageKeysDiffering({ dangerouslyAllowSVG: true }, {}), ["dangerouslyAllowSVG"]);
});
