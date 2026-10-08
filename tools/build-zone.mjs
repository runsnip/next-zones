#!/usr/bin/env node
/* The spikes' entry to src/build.mjs: node tools/build-zone.mjs <zones dir> <zone> <version> [--store <dir>] */
import path from "node:path";
import { buildZone } from "../src/build.mjs";

const args = process.argv.slice(2);
const at = args.indexOf("--store");
const store = at >= 0 ? args.splice(at, 2)[1] : undefined;
const [zonesDir, zone, version = "1"] = args;
if (!zonesDir || !zone) { console.error("usage: build-zone.mjs <zones dir> <zone> <version> [--store <dir>]"); process.exit(2); }
const target = await buildZone({ zonesDir, zone, version, store });
console.log(`stored ${path.relative(process.cwd(), target)}`);
