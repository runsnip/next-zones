import { test } from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { declarationProblems, ownNotFound } from "../src/workspace.mjs";

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

test("a zone's own not-found page is the one Next renders a 404 with when it runs alone", () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "nz-notfound-"));
  const make = (name, files) => {
    const dir = path.join(root, name);
    for (const file of files) { fs.mkdirSync(path.dirname(path.join(dir, file)), { recursive: true }); fs.writeFileSync(path.join(dir, file), "export default function P() { return null; }\n"); }
    return dir;
  };
  try {
    assert.equal(ownNotFound(make("app", ["app/not-found.tsx", "app/shop/page.tsx"])), "/_not-found/page");
    assert.equal(ownNotFound(make("global", ["src/app/global-not-found.tsx", "src/app/shop/page.tsx"])), "/_not-found/page");
    /* With an app/ folder, Next never shows pages/404: the zone has none of its own. */
    assert.equal(ownNotFound(make("mixed", ["app/docs/api/route.ts", "pages/404.tsx", "pages/docs/index.tsx"])), null);
    assert.equal(ownNotFound(make("pages", ["pages/404.tsx", "pages/_error.tsx", "pages/wiki/index.tsx"])), "/404");
    assert.equal(ownNotFound(make("error", ["pages/_error.jsx", "pages/wiki/index.jsx"])), "/_error");
    assert.equal(ownNotFound(make("none", ["app/blog/page.tsx", "app/blog/not-found.tsx"])), null);
  } finally {
    fs.rmSync(root, { recursive: true, force: true });
  }
});
