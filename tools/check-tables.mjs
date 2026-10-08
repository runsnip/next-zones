#!/usr/bin/env node
/*
 * Checks the Markdown tables of the given files: every table row has as many cells as its header, and a table is not
 * split by a blank line (a row after a blank line that is not a new table with its own separator).
 *
 *   node tools/check-tables.mjs README.md SUPPORT.md docs/*.md
 */
import fs from "node:fs";

const cells = (line) => line.trim().replace(/^\||\|$/g, "").split(/(?<!\\)\|/).length;
let problems = 0;
for (const file of process.argv.slice(2)) {
  const lines = fs.readFileSync(file, "utf8").split("\n");
  let header = null;
  let inFence = false;
  lines.forEach((line, i) => {
    if (line.startsWith("```")) inFence = !inFence;
    if (inFence) return;
    const isRow = line.trim().startsWith("|");
    const next = lines[i + 1] ?? "";
    if (isRow && /^\s*\|?\s*:?-{3,}/.test(next)) { header = cells(line); return; }
    if (isRow && /^\s*\|?\s*:?-{3,}/.test(line)) return;
    if (isRow && header === null) { console.error(`${file}:${i + 1}: a table row outside a table (split by a blank line?)`); problems++; return; }
    if (isRow && cells(line) !== header) { console.error(`${file}:${i + 1}: ${cells(line)} cells, the header has ${header}`); problems++; }
    if (!isRow) header = null;
  });
}
if (problems) process.exit(1);
console.log("tables ok");
