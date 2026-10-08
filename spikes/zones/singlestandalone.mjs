/*
 * Mode "single" with Next's output: "standalone": single.mjs's checks, served by the standalone server.js.
 */
process.env.NEXT_OUTPUT = "standalone";
await import("./single.mjs");
