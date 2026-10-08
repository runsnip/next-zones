/*
 * Never loaded. client.mjs imports it behind a condition that is never true, so the shell's build holds one async
 * module (a top-level await) in a chunk of its own: Turbopack then gives the shell's browser runtime its async-module
 * support, the one part of the runtime a build gets only when it uses it (Next 16.3.6). A document has one runtime, the
 * shell's, so a zone with an async module needs it there. The shell's own chunks stay as they were.
 */
export const asyncModule = await Promise.resolve(true);
