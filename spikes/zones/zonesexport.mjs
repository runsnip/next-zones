/*
 * Mode "zones" with Next's output: "export": zones exported separately, linked into one static site (singleexport.mjs's
 * checks, with NEXT_ZONES_MODE=zones).
 */
process.env.NEXT_ZONES_MODE = "zones";
await import("./singleexport.mjs");
