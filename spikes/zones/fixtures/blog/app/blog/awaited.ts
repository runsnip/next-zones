/* An async module (a top-level await): the zone's code uses the runtime's async-module support, which the shell's
   runtime has only through @runsnip/next-zones/client (runtime-features.mjs). */
export const awaited = await Promise.resolve("awaited in the zone");
