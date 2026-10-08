"use strict";
/*
 * Runs in a worker thread: checks a stored zone build against the integrity its zone.json recorded at build time
 * (describe.cjs, digestBuild), off Zones' event loop.
 */
const { parentPort, workerData } = require("node:worker_threads");
const { digestBuild } = require("./describe.cjs");

const { dist } = workerData;
parentPort.postMessage(digestBuild(dist));
