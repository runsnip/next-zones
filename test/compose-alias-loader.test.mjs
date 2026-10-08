import { test } from "node:test";
import assert from "node:assert/strict";
import { createRequire } from "node:module";

const loader = createRequire(import.meta.url)("../src/compose-alias-loader.cjs");
const run = (source, resourcePath, aliases) => loader.call({ getOptions: () => ({ aliases }), rootContext: "/w", resourcePath }, source);

test("a zone's @/ becomes a path relative to the file, to that zone's folder", () => {
  const out = run(`import a from "@/lib/a";\nexport { b } from '@/b';\nconst c = import("@/c");`, "/w/code/app/code/page.tsx", [{ prefix: "@/", target: "/w/code/src/" }]);
  assert.equal(out, `import a from "../../src/lib/a";\nexport { b } from '../../src/b';\nconst c = import("../../src/c");`);
});

test("other specifiers and lookalikes are left alone", () => {
  const source = `import x from "@scope/pkg";\nconst s = "a@/b";\nimport y from "./@/z";`;
  assert.equal(run(source, "/w/code/a.ts", [{ prefix: "@/", target: "/w/code/src/" }]), source);
});
