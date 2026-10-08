/*
 * Zones refuses a Next it was not checked against, naming what does not hold: an unknown version, a module that
 * moved, a function that is gone. The real Next of this spike passes (every other check starts a Zones service on it).
 */
import { createRequire } from "node:module";
import path from "node:path";

const require = createRequire(import.meta.url);
const { locateNext, checkNext, SUPPORTED, NextContractError } = require("../../src/zones/next-contract.cjs");
const realNext = createRequire(path.resolve("shell/package.json"));
const realResolve = realNext.resolve;
realNext("next/dist/server/node-environment");          // what Next sets up before its server loads, as Zones has
const results = {}, wrong = {};
const refusal = (fn) => { try { fn(); return null; } catch (e) { return e instanceof NextContractError ? e.message : `not a contract error: ${e.message}`; } };

/* An unknown version is refused, and accepted with unsupportedNext (the upgrade guard). */
const fakeVersion = Object.assign((id) => (id === "next/package.json" ? { version: "99.0.0" } : realNext(id)), { resolve: realResolve });
/* The upgrade guard admits the Next it checks through NEXT_ZONES_UNSUPPORTED_NEXT, which locateNext honours: the
   refusals below are checked without it. */
const guardRun = process.env.NEXT_ZONES_UNSUPPORTED_NEXT === "1";
delete process.env.NEXT_ZONES_UNSUPPORTED_NEXT;
results.unknownVersion = refusal(() => locateNext({ requireNext: fakeVersion, options: {} }));
if (!/Next 99\.0\.0 has not been checked/.test(results.unknownVersion ?? "")) wrong.unknownVersion = results.unknownVersion;
results.unsupportedNext = refusal(() => locateNext({ requireNext: fakeVersion, options: { unsupportedNext: true } }));
if (results.unsupportedNext !== null) wrong.unsupportedNext = results.unsupportedNext;

/* A module that moved is refused at once. */
const moved = Object.assign((id) => realNext(id), { resolve: (id) => (id.endsWith("router-utils/filesystem") ? (() => { const e = new Error("gone"); e.code = "MODULE_NOT_FOUND"; throw e; })() : realResolve(id)) });
results.moved = refusal(() => locateNext({ requireNext: moved, options: {} }));
if (!/router-utils\/filesystem: cannot be resolved \(MODULE_NOT_FOUND\)/.test(results.moved ?? "")) wrong.moved = results.moved;

/* A function that is gone: the "load-manifest" file located at another of Next's modules, which lacks its functions. */
const located = locateNext({ requireNext: realNext, options: { unsupportedNext: true } });
located.files.loadManifest = realResolve("next/dist/shared/lib/router/utils/app-paths");
results.missingFunction = refusal(() => checkNext({ requireNext: Object.assign((id) => realNext(id.endsWith("load-manifest.external") ? "next/dist/shared/lib/router/utils/app-paths" : id), { resolve: realResolve }), options: {} }, located));
if (!/loadManifestFromRelativePath is missing/.test(results.missingFunction ?? "")) wrong.missingFunction = results.missingFunction;

/* This spike's Next passes both (under the upgrade guard, as a Next being checked). */
const guard = { unsupportedNext: guardRun };
results.thisNext = refusal(() => checkNext({ requireNext: realNext, options: guard }, locateNext({ requireNext: realNext, options: guard })));
if (results.thisNext !== null) wrong.thisNext = results.thisNext;

console.log(JSON.stringify({ supported: SUPPORTED, results, wrong }, null, 2));
