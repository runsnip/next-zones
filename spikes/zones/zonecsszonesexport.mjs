/*
 * zonecsssingle.mjs's check on the static site of mode "zones" with output: "export": zones exported separately, linked
 * into one site.
 */
process.env.NEXT_OUTPUT = "export";
process.env.NEXT_ZONES_MODE = "zones";
await import("./zonecsssingle.mjs");
