import { test } from "node:test";
import assert from "node:assert/strict";
import { declarationProblems } from "../src/workspace.mjs";

const zone = (name, mount, aliases = []) => ({ name, mount, aliases });

test("one shell, one owner per mount: holds", () => {
  assert.deepEqual(declarationProblems([zone("shell", "/"), zone("blog", "/blog"), zone("shop", "/shop")]), []);
});

test("two zones on one mount, no shell, two shells", () => {
  assert.match(declarationProblems([zone("shell", "/"), zone("a", "/x"), zone("b", "/x")]).join("\n"), /\/x is claimed by 2 zones: a, b/);
  assert.match(declarationProblems([zone("blog", "/blog")]).join("\n"), /no zone owns "\/"/);
  assert.match(declarationProblems([zone("a", "/"), zone("b", "/")]).join("\n"), /\/ is claimed by 2 zones/);
});

test("an alias on another zone's mount, and an alias segment two zones claim", () => {
  const problems = declarationProblems([zone("shell", "/"), zone("blog", "/blog", [{ source: "/shop/:x", destination: "/blog/:x" }]),
    zone("shop", "/shop", [{ source: "/p/:x", destination: "/shop/:x" }]), zone("docs", "/docs", [{ source: "/p/:y", destination: "/docs/:y" }])]).join("\n");
  assert.match(problems, /blog: alias \/shop\/:x lands on the mount of shop/);
  assert.match(problems, /aliases under \/p are claimed by shop, docs/);
});
