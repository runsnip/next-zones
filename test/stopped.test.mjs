import { test } from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import { createRequire } from "node:module";

const require = createRequire(import.meta.url);
const { stoppedLookup } = require("../src/zones/server.cjs");
/* Next's own path matcher, as Zones uses it (the spike's Next). */
const pathMatch = new URL("../spikes/zones/node_modules/next/dist/shared/lib/router/utils/path-match.js", import.meta.url);
const next = fs.existsSync(pathMatch) ? require(pathMatch.pathname) : null;

test("a stopped zone's URLs: its mount, its aliases, its /_next/data; nothing else", { skip: !next && "the spike's Next is not installed" }, () => {
  const stopped = new Map();
  let revision = 0;
  const of = stoppedLookup(stopped, next.getPathMatch, () => revision);
  assert.equal(of("/blog/42"), null, "nothing stopped: nothing asked");
  const blog = { name: "blog", mount: "/blog", buildId: "b1", aliases: [{ source: "/post/:id", destination: "/blog/:id" }] };
  stopped.set("blog", blog);
  revision++;
  for (const p of ["/blog", "/blog/42", "/blog/a/b/c", "/post/7", "/_next/data/b1/blog/42.json"]) assert.equal(of(p), blog, p);
  for (const p of ["/", "/shop", "/blogs", "/post", "/post/7/8", "/_next/data/other/blog/42.json", "/_next/static/chunks/a.js"]) assert.equal(of(p), null, p);
  /* An alias whose first segment is a parameter is matched against every path. */
  const shop = { name: "shop", mount: "/shop", buildId: "s1", aliases: [{ source: "/:lang/cart", destination: "/shop/cart" }] };
  stopped.set("shop", shop);
  revision++;
  assert.equal(of("/en/cart"), shop);
  assert.equal(of("/post/7"), blog);
  stopped.delete("blog");
  revision++;
  assert.equal(of("/post/7"), null);
  assert.equal(of("/blog"), null);
});
