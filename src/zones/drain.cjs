"use strict";
/*
 * Stopping without failing a request (drain), and the CLI's stop on a signal. A drain loses no request a proxy has sent,
 * which matters for a POST: a proxy does not send one again once sent (nginx, without `non_idempotent`).
 * - closing(ctx, handler): the request handler. Once the drain has stopped listening, every response closes its
 *   connection: one that arrives then, and one in flight whose headers are not sent yet (Node reads shouldKeepAlive as
 *   it writes them). A proxy then opens a new connection for its next request, is refused (never sent: it may send
 *   it elsewhere) and marks this process down.
 * - createDrain(ctx, { server, close }): health answers 503 and the open tabs' event streams end with `retry: 1000`
 *   (they reconnect, through the proxy, to a Zones still serving); it stops listening at a quiet moment
 *   (stopListening); the requests in flight are answered; every kept-alive connection is left to close (by the
 *   client, or its keep-alive timeout); then close(). `server()` is the http.Server, or null when Zones is mounted in a
 *   server of yours.
 * - stopOnSignal({ drain, timeoutMs, lingerMs, exit, log }): the first signal drains, then exits 0 lingerMs later,
 *   refusing connections meanwhile (a proxy balancing over several Zones marks it down before its address goes); a
 *   second signal, or one before Zones serves, exits at once.
 */
const net = require("node:net");

const closing = (ctx, handler) => (req, res) => {
  if (ctx.closeConnections) res.shouldKeepAlive = false;
  else { ctx.inflight.add(res); res.once("close", () => ctx.inflight.delete(res)); }
  return handler(req, res);
};

/*
 * Stops listening (net.Server's close: http.Server's would close the idle kept-alive connections too, below) at a quiet
 * moment, and resolves then. When a listener closes, the kernel resets the connections it has set up and Node has not
 * accepted yet, and a proxy may have written a request on one (lost: 8 of 2,215 POSTs through nginx, in 3 of 8
 * rolling deploys of spikes/zones/rollout.mjs, never received). Node accepts them in its poll phase, a few a turn, and
 * a busy turn (a render) lets them queue. So the listener closes at the first turn of the event loop that accepted
 * none and came round in under 2 ms, having taken what was queued; at most `quietMs` after the drain began, whatever
 * the load (a loop busy that long still leaves the window of its last turn). Until then the connections stay kept
 * alive (closing): a proxy reuses its pool rather than opening new ones, so few queue and a quiet turn comes soon.
 */
function stopListening(http, quietMs = 5000) {
  return new Promise((resolve) => {
    let accepted = 0, before = -1, turn = performance.now();
    const until = turn + quietMs, count = () => accepted++;
    http.on("connection", count);
    const check = () => {
      if (!http.listening) return void resolve();
      const now = performance.now(), quick = now - turn < 2;
      turn = now;
      if ((accepted === before && quick) || now > until) {
        http.off("connection", count);
        net.Server.prototype.close.call(http);
        return void resolve();
      }
      before = accepted;
      setImmediate(check);
    };
    setImmediate(check);
  });
}

function createDrain(ctx, { server, close }) {
  let drained = null;
  return function drain({ timeoutMs = Infinity } = {}) {
    if (drained) return drained;
    ctx.draining = true;
    drained = (async () => {
      const started = performance.now(), http = server();
      const streams = ctx.listeners.size;
      /* Every connection closed, the listener first: the server's close event. */
      const closed = http ? new Promise((resolve) => http.once("close", () => resolve(true))) : Promise.resolve(true);
      /* `retry`: the tab's EventSource reconnects after 1 s (its default is the browser's, 3 s in Chrome). */
      for (const res of ctx.listeners) { res.write("retry: 1000\n\n"); res.end(); }
      let timer = null;
      const limit = Number.isFinite(timeoutMs) ? new Promise((resolve) => { timer = setTimeout(() => resolve(false), timeoutMs); }) : null;
      if (http) await Promise.race([stopListening(http), ...(limit ? [limit] : [])]);
      /* Not listening: every answer from now on closes its connection, the ones in flight whose headers are not sent
         too, so the proxy stops using this process. A connection kept alive is not closed under the proxy, which may
         be writing a request on it this moment (closing it would lose that request; measured: 4 of 67 POSTs through
         nginx answered 502, never received, rollout.mjs): a request still sent on one is answered; one left idle
         closes by its keep-alive timeout (Node's 5 s), which a proxy undercuts (nginx's keepalive_timeout 4s), so
         the proxy closes it first. The drain ends once every connection has. */
      ctx.closeConnections = true;
      for (const res of ctx.inflight) if (!res.headersSent) res.shouldKeepAlive = false;
      if (http?.listening) net.Server.prototype.close.call(http);
      const outcome = await Promise.race([closed, ...(limit ? [limit] : [])]);
      clearTimeout(timer);
      if (!outcome) http.closeAllConnections();
      await close();
      return { streams, ms: Math.round(performance.now() - started), timedOut: !outcome };
    })();
    return drained;
  };
}

function stopOnSignal({ drain, timeoutMs, lingerMs = 0, exit = process.exit, log = console.log, error = console.error }) {
  let listening = false, stopping = false;
  return {
    listening() { listening = true; },
    signal(name) {
      if (stopping || !listening) return void exit(listening ? 1 : 0);
      stopping = true;
      log(`next-zones: ${name}, draining (at most ${timeoutMs} ms)`);
      return drain({ timeoutMs }).then(
        (r) => {
          log(`next-zones: drained in ${r.ms} ms (${r.streams} event streams ended${r.timedOut ? ", requests still in flight closed" : ""})${lingerMs ? `, exiting in ${lingerMs} ms` : ""}`);
          setTimeout(() => exit(0), lingerMs);
        },
        (e) => { error(e); exit(1); });
    },
  };
}

module.exports = { closing, createDrain, stopOnSignal };
