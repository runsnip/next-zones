/*
 * Loaded into each Zones rollout.mjs starts (NODE_OPTIONS=--require): one line per request received ("in") and per
 * answer finished ("out") to NZ_COUNT_LOG, so the check counts what each process was sent, whatever a proxy says.
 */
const fs = require("node:fs");
const http = require("node:http");

const file = process.env.NZ_COUNT_LOG;
const emit = http.Server.prototype.emit;
http.Server.prototype.emit = function (event, req, res) {
  if (event === "request" && file) {
    const line = (what) => fs.appendFileSync(file, `${JSON.stringify({ pid: process.pid, what, method: req.method, url: req.url, t: Date.now() })}\n`);
    line("in");
    res.once("finish", () => line("out"));
  }
  return emit.apply(this, arguments);
};
