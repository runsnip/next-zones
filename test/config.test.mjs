import { test } from "node:test";
import assert from "node:assert/strict";
import { zoneConfig, checkZone, readZone, BUILD_OPTIONS, projectRoot } from "../src/config.mjs";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";

test("zoneConfig leaves the zone's Next config untouched outside a build for Zones, and attaches the declaration", () => {
  const nextConfig = { reactStrictMode: true, output: "standalone", experimental: { other: 1, turbopackRemoveUnusedExports: true } };
  const config = zoneConfig({ mount: "/blog" }, nextConfig);
  assert.equal(config.reactStrictMode, true);
  assert.equal(config.output, "standalone");
  assert.deepEqual(config.experimental, nextConfig.experimental);
  assert.deepEqual(config[Symbol.for("@runsnip/next-zones/zones")], { mount: "/blog", aliases: [] });
});

test("in a build for Zones, zoneConfig fills in the build options the zone left unset", () => {
  process.env.NEXT_ZONES_BUILD = "zones";
  try {
    const config = zoneConfig({ mount: "/blog" }, { output: "standalone", experimental: { other: 1 } });
    assert.deepEqual(config.experimental, { other: 1, ...BUILD_OPTIONS });
    assert.equal(config.output, "standalone");
  } finally { delete process.env.NEXT_ZONES_BUILD; }
});

test("in a build for Zones, a zone that sets a build option otherwise is told so, never overridden", () => {
  process.env.NEXT_ZONES_BUILD = "zones";
  try {
    assert.throws(() => zoneConfig({ mount: "/blog" }, { experimental: { turbopackRemoveUnusedExports: true } }), /needs experimental\.turbopackRemoveUnusedExports: false/);
    assert.equal(zoneConfig({ mount: "/blog" }, { experimental: { turbopackScopeHoisting: false } }).experimental.turbopackScopeHoisting, false);
  } finally { delete process.env.NEXT_ZONES_BUILD; }
});

test("Next keys beside the declaration are kept in both two-argument forms, under the second's", async () => {
  const fromFunction = await zoneConfig({ mount: "/blog", transpilePackages: ["shared"], reactStrictMode: false }, () => ({ reactStrictMode: true }))("phase-production-build", {});
  assert.deepEqual(fromFunction.transpilePackages, ["shared"]);
  assert.equal(fromFunction.reactStrictMode, true);
  const fromObject = zoneConfig({ mount: "/blog", transpilePackages: ["shared"] }, { output: "standalone" });
  assert.deepEqual(fromObject.transpilePackages, ["shared"]);
  assert.equal(fromObject.output, "standalone");
  assert.equal(fromObject.mount, undefined);
});

test("a config function is wrapped and keeps its declaration", async () => {
  const wrapped = zoneConfig({ mount: "/blog" }, async (phase) => ({ env: { PHASE: phase } }));
  assert.equal(typeof wrapped, "function");
  assert.equal(wrapped[Symbol.for("@runsnip/next-zones/zones")].mount, "/blog");
  assert.equal((await wrapped("phase-production-build", {})).env.PHASE, "phase-production-build");
});

test("aliases are the zone's own rewrites when it runs alone, and left to Zones in a build for Zones", async () => {
  const aliases = [{ source: "/post/:id", destination: "/blog/:id" }];
  const own = { rewrites: async () => ({ beforeFiles: [{ source: "/blog/a", destination: "/blog/b" }] }) };
  const alone = await zoneConfig({ mount: "/blog", aliases }, own).rewrites();
  assert.deepEqual(alone.beforeFiles.map((r) => r.source), ["/post/:id", "/blog/a"]);
  process.env.NEXT_ZONES_BUILD = "zones";
  try {
    const forZones = await zoneConfig({ mount: "/blog", aliases }, own).rewrites();
    assert.deepEqual(forZones.beforeFiles.map((r) => r.source), ["/blog/a"]);
  } finally { delete process.env.NEXT_ZONES_BUILD; }
});

test("checkZone refuses a bad mount and aliases outside the mount", () => {
  assert.throws(() => checkZone({ mount: "/a/b" }), /one URL segment/);
  assert.throws(() => checkZone({ mount: "blog" }), /one URL segment/);
  assert.throws(() => checkZone({ mount: "/blog", aliases: [{ source: "/:x", destination: "/blog" }] }), /fixed segment/);
  assert.throws(() => checkZone({ mount: "/blog", aliases: [{ source: "/p/:x", destination: "/shop/:x" }] }), /must point under \/blog/);
  assert.deepEqual(checkZone({ mount: "/" }), { mount: "/", aliases: [] });
});

test("readZone reads a declaration back, or null for an app that is not a zone", async () => {
  assert.equal(await readZone(new URL("..", import.meta.url).pathname), null);
});

test("livePull is declared by the zone, off by default, and must be a boolean", () => {
  assert.equal(checkZone({ mount: "/blog" }).livePull, undefined);
  assert.equal(checkZone({ mount: "/blog", livePull: true }).livePull, true);
  assert.equal(checkZone({ mount: "/blog", livePull: false }).livePull, undefined);
  assert.throws(() => checkZone({ mount: "/blog", livePull: "yes" }), /livePull must be true or false/);
});

test("output is the shell's to declare: images or single", () => {
  assert.equal(checkZone({ mount: "/" }).mode, undefined);
  assert.equal(checkZone({ mount: "/", mode: "single" }).mode, "single");
  assert.equal(checkZone({ mount: "/", mode: "zones" }).mode, undefined);
  assert.throws(() => checkZone({ mount: "/", mode: "bundle" }), /mode must be "zones" or "single"/);
  assert.throws(() => checkZone({ mount: "/blog", mode: "single" }), /the shell's to declare/);
  assert.throws(() => checkZone({ mount: "/", output: "standalone" }), /output is Next's option/);
});

test("the build options a build lacks are named, for Zones' refusals", async () => {
  const { missingBuildOptions } = (await import("node:module")).createRequire(import.meta.url)("../src/build-options.cjs");
  assert.deepEqual(missingBuildOptions({ ...BUILD_OPTIONS }), []);
  assert.deepEqual(missingBuildOptions({ turbopackScopeHoisting: false }), ["experimental.turbopackRemoveUnusedExports: false", "experimental.turbopackRemoveUnusedImports: false"]);
  assert.equal(missingBuildOptions(undefined).length, 3);
});

test("composed by next-zones dev (NEXT_ZONES_BUILD=dev), a zone's config gets no build options, and its aliases are the composer's", async () => {
  process.env.NEXT_ZONES_BUILD = "dev";
  try {
    const config = zoneConfig({ mount: "/blog", aliases: [{ source: "/p/:id", destination: "/blog/:id" }] }, { output: "standalone", experimental: { turbopackRemoveUnusedExports: true } });
    assert.deepEqual(config.experimental, { turbopackRemoveUnusedExports: true });
    assert.equal(config.output, "standalone");
    assert.equal(config.rewrites, undefined);
  } finally { delete process.env.NEXT_ZONES_BUILD; }
});

test("a build for Zones pins the project root: where next is installed, not the topmost lockfile; the zone's own kept", () => {
  const top = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), "nz-root-")));
  const workspace = path.join(top, "workspace"), app = path.join(workspace, "shell");
  fs.mkdirSync(path.join(workspace, "node_modules", "next"), { recursive: true });
  fs.writeFileSync(path.join(workspace, "node_modules", "next", "package.json"), "{}");
  fs.mkdirSync(app);
  fs.writeFileSync(path.join(top, "package-lock.json"), "{}");          // what Next would take as the root
  const cwd = process.cwd();
  process.env.NEXT_ZONES_BUILD = "zones";
  try {
    process.chdir(app);
    assert.equal(projectRoot(), workspace);
    const config = zoneConfig({ mount: "/blog" }, {});
    assert.equal(config.turbopack.root, workspace);
    assert.equal(config.outputFileTracingRoot, workspace);
    assert.equal(zoneConfig({ mount: "/blog" }, { turbopack: { root: top } }).turbopack.root, top);
    process.env.NEXT_ZONES_ROOT = top;
    assert.equal(zoneConfig({ mount: "/blog" }, {}).turbopack.root, top);
  } finally {
    process.chdir(cwd); delete process.env.NEXT_ZONES_BUILD; delete process.env.NEXT_ZONES_ROOT;
    fs.rmSync(top, { recursive: true, force: true });
  }
});

test("the pinned root holds a node_modules linked from elsewhere", () => {
  const top = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), "nz-root-")));
  const bed = path.join(top, "bed"), other = path.join(bed, ".export", "app");
  fs.mkdirSync(path.join(bed, "node_modules", "next"), { recursive: true });
  fs.writeFileSync(path.join(bed, "node_modules", "next", "package.json"), "{}");
  fs.mkdirSync(other, { recursive: true });
  fs.symlinkSync(path.join(bed, "node_modules"), path.join(other, "node_modules"));
  const outside = path.join(top, "elsewhere");
  fs.mkdirSync(outside); fs.symlinkSync(path.join(bed, "node_modules"), path.join(outside, "node_modules"));
  try {
    assert.equal(projectRoot(other), bed);
    assert.equal(projectRoot(outside), top);
  } finally { fs.rmSync(top, { recursive: true, force: true }); }
});

test("zoneConfig takes one object: the declaration's keys out, the rest Next's", () => {
  const merged = zoneConfig({ mount: "/blog", aliases: [{ source: "/p/:slug", destination: "/blog/p/:slug" }], livePull: true, reactStrictMode: true, output: "standalone", experimental: { other: 1 } });
  const apart = zoneConfig({ mount: "/blog", aliases: [{ source: "/p/:slug", destination: "/blog/p/:slug" }], livePull: true }, { reactStrictMode: true, output: "standalone", experimental: { other: 1 } });
  const zone = (c) => c[Symbol.for("@runsnip/next-zones/zones")];
  assert.deepEqual(zone(merged), zone(apart));
  assert.equal(merged.reactStrictMode, true);
  assert.equal(merged.output, "standalone");
  assert.equal(merged.mount, undefined);
  assert.equal(merged.livePull, undefined);
  assert.deepEqual(merged.experimental, { other: 1 });
  /* A function config still comes second. */
  const fn = zoneConfig({ mount: "/blog" }, () => ({ reactStrictMode: true }));
  assert.equal(typeof fn, "function");
  assert.deepEqual(zone(fn), { mount: "/blog", aliases: [] });
});
