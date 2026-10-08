"use strict";
/*
 * Handing memory back once old versions are gone (D14). Collecting a version (collect.cjs) unloads its code, but V8
 * keeps two things no ordinary collection gives back:
 * - its compilation cache: the scripts of every chunk ever loaded, sources included, the old versions' too
 *   (1.7 MB a version on the test blog: the heap after a full collection went 38 → 270 MB over 120 versions);
 * - the heap's committed pages, grown to an install's peak and kept.
 * V8's last-resort collection (the one a heap snapshot runs) clears both. It holds the event loop for tens of ms
 * (59 ms after 30 versions, 27 ms again), so it runs when Zones is idle: after a version is collected, once no request
 * has been in flight for `idleMs`, or after `maxWaitMs` however busy Zones is.
 */
const v8 = require("node:v8");
const vm = require("node:vm");

function createReclaim(ctx) {
  const options = ctx.options.reclaim === false ? null : { idleMs: 1000, maxWaitMs: 30_000, ...(ctx.options.reclaim ?? {}) };
  let inFlight = 0, lastActive = 0, pending = null, gc = null;
  ctx.reclaimed = { runs: 0, lastMs: null, lastFreedMB: null };

  const collectGarbage = () => {
    if (!gc) {
      if (typeof globalThis.gc === "function") gc = globalThis.gc;
      else { v8.setFlagsFromString("--expose-gc"); gc = vm.runInNewContext("gc"); }
    }
    const before = process.memoryUsage().rss, t = performance.now();
    gc({ type: "major", execution: "sync", flavor: "last-resort" });
    ctx.reclaimed = { runs: ctx.reclaimed.runs + 1, lastMs: +(performance.now() - t).toFixed(1), lastFreedMB: +((before - process.memoryUsage().rss) / 1048576).toFixed(1) };
  };

  /** Asks for a reclaim: once idle, or at the latest after maxWaitMs. Several asks make one reclaim. */
  function soon() {
    if (!options || pending) return;
    const asked = Date.now();
    const tick = () => {
      const idle = inFlight === 0 && Date.now() - lastActive >= options.idleMs;
      if (idle || Date.now() - asked >= options.maxWaitMs) { pending = null; collectGarbage(); return; }
      pending = setTimeout(tick, 100);
      pending.unref();
    };
    pending = setTimeout(tick, options.idleMs);
    pending.unref();
  }

  /** Wraps the request handler: what is in flight decides when Zones is idle. */
  function track(req, res) {
    inFlight++;
    let done = false;
    const end = () => { if (done) return; done = true; inFlight--; lastActive = Date.now(); };
    res.once("finish", end);
    res.once("close", end);
  }

  return { soon, track, now: () => collectGarbage() };
}

module.exports = { createReclaim };
