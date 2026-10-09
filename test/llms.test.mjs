/* llms-full.txt is llms.txt's head and every page of docs/ (tools/llms.mjs): it must be current. */
import { test } from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import { llmsFull } from "../tools/llms.mjs";

test("llms-full.txt is current with llms.txt and docs/ (run npm run llms)", () => {
  assert.equal(fs.readFileSync(new URL("../llms-full.txt", import.meta.url), "utf8"), llmsFull());
});

test("llms.txt links every page docs/README.md lists", () => {
  const llms = fs.readFileSync(new URL("../llms.txt", import.meta.url), "utf8");
  const index = fs.readFileSync(new URL("../docs/README.md", import.meta.url), "utf8");
  for (const [, page] of index.slice(index.indexOf("## Pages")).matchAll(/^\d+\. \[[^\]]+\]\(([a-z0-9-]+\.md)\)/gm)) {
    assert.ok(llms.includes(`/docs/${page})`), `llms.txt lacks docs/${page}`);
  }
});
