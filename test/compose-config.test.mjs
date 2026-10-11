import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { mergeConfigs } from "../src/compose-config.mjs";

/* A workspace: shell/, docx/ (with resolveAlias), .zones-dev/ beside them. */
function workspace(docxAlias, shellAlias = {}) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "nz-compose-config-"));
  const write = (zone, alias) => {
    fs.mkdirSync(path.join(dir, zone));
    fs.writeFileSync(path.join(dir, zone, "next.config.mjs"), `export default { turbopack: { resolveAlias: ${JSON.stringify(alias)} } };`);
    return path.join(dir, zone, "next.config.mjs");
  };
  return {
    dir,
    args: { shell: write("shell", shellAlias), zones: [{ name: "docx", mount: "/docx", file: write("docx", docxAlias), aliases: [] }], root: dir, scoped: [], loader: "x", out: path.join(dir, ".zones-dev") },
  };
}

test("a zone's turbopack.resolveAlias reaches the composed config, relative targets rebased", async () => {
  const { args } = workspace({
    "@runsnip/docx": "../node_modules/@runsnip/docx/src/index.ts",
    "@runsnip/local": "./src/local.ts",
    "fs-shim": "some-package",
    "@runsnip/both": { browser: "./src/browser.ts", default: ["./src/a.ts", "pkg"] },
  }, { "@app/shared": "./lib/shared.ts" });
  const config = await mergeConfigs(args);
  assert.deepEqual(config.turbopack.resolveAlias, {
    "@app/shared": "../shell/lib/shared.ts",
    "@runsnip/docx": "../node_modules/@runsnip/docx/src/index.ts",
    "@runsnip/local": "../docx/src/local.ts",
    "fs-shim": "some-package",
    "@runsnip/both": { browser: "../docx/src/browser.ts", default: ["../docx/src/a.ts", "pkg"] },
  });
});

test("one alias with two targets is refused", async () => {
  const { args } = workspace({ "@x/y": "./a.ts" }, { "@x/y": "./a.ts" });
  await assert.rejects(mergeConfigs(args), /resolveAlias @x\/y differs/);
});

test("the same target from two zones is kept once", async () => {
  const { args } = workspace({ "@x/y": "pkg" }, { "@x/y": "pkg" });
  assert.deepEqual((await mergeConfigs(args)).turbopack.resolveAlias, { "@x/y": "pkg" });
});
