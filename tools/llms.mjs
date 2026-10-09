#!/usr/bin/env node
/*
 * Writes llms-full.txt: llms.txt's summary and essentials, then every page of docs/ in the order docs/README.md lists
 * them (the overview first), relative links made absolute. Run after changing llms.txt or a page:
 *
 *   node tools/llms.mjs          (npm run llms; test/llms.test.mjs fails while the file is stale)
 */
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const RAW = "https://raw.githubusercontent.com/runsnip/next-zones/main/";

/** The text llms-full.txt should hold, from llms.txt and docs/. */
export function llmsFull() {
  const llms = fs.readFileSync(path.join(root, "llms.txt"), "utf8");
  const head = llms.slice(0, llms.indexOf("\n## Docs")).trimEnd();
  const index = fs.readFileSync(path.join(root, "docs", "README.md"), "utf8");
  const pages = [...index.slice(index.indexOf("## Pages")).matchAll(/^\d+\. \[[^\]]+\]\(([a-z0-9-]+\.md)\)/gm)].map((m) => m[1]);
  /* Links between pages, and to the package's files, made absolute: the file is read on its own. */
  const absolute = (text, dir) => text.replace(/\]\((?!https?:|#|mailto:)([^)\s]+)\)/g, (all, target) => {
    const resolved = path.posix.normalize(path.posix.join(dir, target));
    return `](${RAW}${resolved.replace(/^\.\//, "")})`;
  });
  const parts = [head, "", "The documentation follows, page by page.", ""];
  for (const page of ["README.md", ...pages]) {
    const text = fs.readFileSync(path.join(root, "docs", page), "utf8").trim();
    parts.push(`---`, ``, `<!-- docs/${page} -->`, ``, absolute(text, "docs"), ``);
  }
  return `${parts.join("\n").trimEnd()}\n`;
}

if (process.argv[1] && fileURLToPath(import.meta.url) === path.resolve(process.argv[1])) {
  fs.writeFileSync(path.join(root, "llms-full.txt"), llmsFull());
  console.log(`llms-full.txt: ${llmsFull().split(/\s+/).length} words`);
}
