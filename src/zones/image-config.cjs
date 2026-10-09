"use strict";
/*
 * The image optimizer runs with the shell's images config, for every zone. A zone is refused only for what it set of
 * its own that differs from the shell's: a key left at Next's default (unset in the source; filled in by Next in a
 * build) asks for nothing, so a zone without an images config fits any shell. The defaults are Next's
 * imageConfigDefault, and the localPatterns Next's config loader fills in when it is unset (server/config.js).
 */
const IMAGE_KEYS = ["remotePatterns", "domains", "localPatterns", "unoptimized", "dangerouslyAllowSVG", "dangerouslyAllowLocalIP"];
const DEFAULTS = { remotePatterns: [], domains: [], localPatterns: [{ pathname: "**", search: "" }], unoptimized: false, dangerouslyAllowSVG: false, dangerouslyAllowLocalIP: false };

const same = (a, b) => JSON.stringify(a) === JSON.stringify(b);
const valueOf = (images, key) => images?.[key] ?? DEFAULTS[key];

/** The keys of `zone`'s images config it set of its own (not Next's default) that differ from `shell`'s. */
function imageKeysDiffering(zone, shell) {
  return IMAGE_KEYS.filter((key) => {
    const own = zone?.[key];
    if (own === undefined || own === null || same(own, DEFAULTS[key])) return false;
    return !same(own, valueOf(shell, key));
  });
}

module.exports = { IMAGE_KEYS, imageKeysDiffering };
