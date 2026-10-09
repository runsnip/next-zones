/*
 * Mode "single" with Next's output: "standalone" and zones on the Pages Router: singlepages.mjs's checks, served by the
 * standalone server.js.
 */
process.env.NEXT_OUTPUT = "standalone";
await import("./singlepages.mjs");
