#!/usr/bin/env node
/*
 * The package as it is published: dist/, built from src/ file by file (no bundle: the code loads its own files by
 * path, its worker threads among them, and a standalone build copies them whole). Each module is minified with swc
 * (chosen by benchmark against esbuild, terser and oxc: the smallest output, raw and gzipped; spikes/zones/RESULTS.md,
 * "The published package") and keeps its directives ("use client", "use strict"). Names are not mangled, and no source
 * map is shipped: a stack trace names the functions it went through, for 8.6 KB more gzipped, where source maps would
 * add 125 KB. Type declarations are copied as they are.
 *
 *   node tools/build-dist.mjs        (npm run build; npm pack and npm publish run it first)
 */
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { createRequire } from "node:module";

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const src = path.join(root, "src"), out = path.join(root, "dist");
const swc = createRequire(import.meta.url)("@swc/core");

/* The directive prologue a module starts with ("use client", "use strict"), which the minifier may drop. */
function directives(code) {
  const found = [];
  let rest = code.replace(/^#![^\n]*\n/, ""), m;
  while ((m = /^(?:\s|\/\*[\s\S]*?\*\/|\/\/[^\n]*\n)*(["'])(use [a-z ]+)\1;?/.exec(rest))) { found.push(m[2]); rest = rest.slice(m[0].length); }
  return found;
}

export async function buildDist() {
  fs.rmSync(out, { recursive: true, force: true });
  let bytes = 0, files = 0;
  for (const rel of fs.readdirSync(src, { recursive: true }).map(String).sort()) {
    const from = path.join(src, rel), to = path.join(out, rel);
    if (fs.statSync(from).isDirectory()) continue;
    fs.mkdirSync(path.dirname(to), { recursive: true });
    if (!/\.(mjs|cjs)$/.test(rel) || /\.d\.[mc]ts$/.test(rel)) { fs.copyFileSync(from, to); continue; }
    const code = fs.readFileSync(from, "utf8");
    const result = await swc.minify(code, {
      module: rel.endsWith(".mjs"), ecma: 2024, compress: { passes: 2, keep_fnames: true, keep_classnames: true }, mangle: false,
      format: { comments: false },
    });
    let text = result.code;
    const kept = directives(code).filter((d) => !directives(text).includes(d));
    if (kept.length) text = `${kept.map((d) => `"${d}";`).join("")}${text}`;
    fs.writeFileSync(to, `${text}\n`);
    bytes += Buffer.byteLength(text); files++;
  }
  /* The command keeps its shebang and stays executable. */
  const cli = path.join(out, "cli.mjs");
  const cliText = fs.readFileSync(cli, "utf8");
  if (!cliText.startsWith("#!")) fs.writeFileSync(cli, `#!/usr/bin/env node\n${cliText}`);
  fs.chmodSync(cli, 0o755);
  return { files, bytes };
}

if (process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  const { files, bytes } = await buildDist();
  console.log(`dist/: ${files} modules, ${(bytes / 1024).toFixed(1)} KB`);
}
