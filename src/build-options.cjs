"use strict";
/*
 * What a build for Zones needs (docs/configuration.md, "Build options for Zones"), separately built zones sharing one instance of
 * each module they have in common:
 * - turbopackScopeHoisting: a hoisted factory writes other modules' exports, which a module shared across builds
 *   cannot allow;
 * - turbopackRemoveUnusedExports: Turbopack drops the exports a build does not use, so one module (a library's
 *   context, say) differs between the shell's build and a zone's, and is loaded twice: two contexts;
 * - turbopackRemoveUnusedImports: Turbopack requires it off when unused exports are kept.
 * zoneConfig fills them in for a build for Zones (config.mjs); Zones refuses a shell or a zone image built without them.
 */
const BUILD_OPTIONS = Object.freeze({ turbopackScopeHoisting: false, turbopackRemoveUnusedExports: false, turbopackRemoveUnusedImports: false });

/** The build options a resolved Next config lacks (from its experimental), as "key: expected" strings. */
const missingBuildOptions = (experimental = {}) => Object.entries(BUILD_OPTIONS).filter(([key, value]) => experimental[key] !== value).map(([key, value]) => `experimental.${key}: ${value}`);

module.exports = { BUILD_OPTIONS, missingBuildOptions };
