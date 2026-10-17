/*
 * zonecsssingle.mjs's check on the static site of mode "single" with output: "export".
 */
process.env.NEXT_OUTPUT = "export";
await import("./zonecsssingle.mjs");
