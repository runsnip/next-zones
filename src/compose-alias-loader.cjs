"use strict";
/*
 * A loader of the composed dev app (compose.mjs): one zone's path alias, resolved for that zone's files only.
 * Composed, the zones share one tsconfig, so `@/*` could point to one zone's folder only; Turbopack runs this loader
 * on each zone's files (a rule with a path condition) and turns `"@/x"` into the zone's own `"<zone>/src/x"`. Only
 * string literals that start with the alias are touched: import and export specifiers, import() and require().
 */
const path = require("node:path");

module.exports = function composeAliasLoader(source) {
  const { aliases } = this.getOptions();
  /* Turbopack resolves relative specifiers, not absolute paths: the target is given relative to this file. */
  const from = path.dirname(path.resolve(this.rootContext ?? "", this.resourcePath));
  let out = source;
  for (const { prefix, target } of aliases) {
    let relative = path.relative(from, target).split(path.sep).join("/");
    if (!relative.startsWith(".")) relative = `./${relative}`;
    const escaped = prefix.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
    out = out.replace(new RegExp(`(["'])${escaped}([^"'\\n]*)\\1`, "g"), (all, quote, rest) => `${quote}${relative}/${rest}${quote}`);
  }
  return out;
};
