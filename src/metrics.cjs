"use strict";
/*
 * Metrics: one store for the whole Zones process, which the shell opens with zoneConfig({ metrics: true }), and the
 * functions that write to it, for Zones itself and for any zone's code (`@runsnip/next-zones/metrics`).
 *
 * The store lives on globalThis: the shell and every zone are separate builds, each bundling this module, and they all
 * write to the one store Zones opened. With metrics off (no store), every function does nothing: a zone's code can
 * measure unconditionally.
 *
 * Prometheus' model, as text: counters only go up, gauges are set, histograms count observations into cumulative
 * buckets (in base units: seconds, bytes). No client library and no push: Zones serves the store's text at
 * <base>/metrics (endpoints.cjs).
 *
 *   const { counter, gauge, histogram, time } = require("@runsnip/next-zones/metrics");
 *   const exports = counter("blog_exports_total", { help: "Exports started" });
 *   exports.inc({ format: "pdf" });
 *   const queue = gauge("blog_queue_length", { help: "Jobs waiting" });
 *   queue.set(12);
 *   await time("blog_render_seconds", () => render(post), { kind: "post" });
 */

const STORE = Symbol.for("@runsnip/next-zones/metrics");
const NAME = /^[a-zA-Z_:][a-zA-Z0-9_:]*$/;
const LABEL = /^[a-zA-Z_][a-zA-Z0-9_]*$/;
/* Seconds, from a millisecond to a minute: request handling, renders, installs. */
const DEFAULT_BUCKETS = Object.freeze([0.001, 0.005, 0.01, 0.025, 0.05, 0.1, 0.25, 0.5, 1, 2.5, 5, 10, 30, 60]);

/** The store, when the shell turned metrics on; null otherwise. */
const store = () => globalThis[STORE] ?? null;

/** Opens the store (Zones, when the shell declares metrics). Idempotent. */
function open() {
  return (globalThis[STORE] ??= { metrics: new Map(), collectors: new Set() });
}

/** Closes the store: every function does nothing again (tests). */
function close() {
  delete globalThis[STORE];
}

/* A series' key: its labels in name order, so { a, b } and { b, a } are one series. */
const keyOf = (labels) => {
  const names = Object.keys(labels ?? {}).sort();
  for (const n of names) if (!LABEL.test(n) || n.startsWith("__")) throw new Error(`next-zones metrics: label name ${JSON.stringify(n)} is not valid`);
  return JSON.stringify(names.map((n) => [n, String(labels[n])]));
};

function metricOf(name, type, { help = "", buckets } = {}) {
  if (!NAME.test(name)) throw new Error(`next-zones metrics: name ${JSON.stringify(name)} is not valid (letters, digits, _ and :)`);
  const s = store();
  if (!s) return null;
  let m = s.metrics.get(name);
  if (!m) {
    const b = type === "histogram" ? [...(buckets ?? DEFAULT_BUCKETS)].sort((x, y) => x - y) : null;
    if (b && (b.length === 0 || b.some((x) => !Number.isFinite(x)))) throw new Error(`next-zones metrics: ${name}'s buckets must be finite numbers`);
    m = { name, type, help, buckets: b, series: new Map() };
    s.metrics.set(name, m);
  } else if (m.type !== type) {
    throw new Error(`next-zones metrics: ${name} is a ${m.type}, not a ${type}`);
  }
  return m;
}

function seriesOf(m, labels, make) {
  const key = keyOf(labels);
  let v = m.series.get(key);
  if (!v) { v = make(); m.series.set(key, v); }
  return v;
}

/** A counter: only goes up. `inc(labels?)`, or `inc(n, labels?)`. */
function counter(name, options) {
  return {
    inc(n = 1, labels) {
      if (typeof n === "object") { labels = n; n = 1; }
      if (!(n >= 0)) throw new Error(`next-zones metrics: ${name} is a counter; it only goes up (got ${n})`);
      const m = metricOf(name, "counter", options);
      if (m) seriesOf(m, labels, () => ({ value: 0 })).value += n;
    },
  };
}

/** A gauge: a value that goes up and down. `set(v, labels?)`, `inc(n?, labels?)`, `dec(n?, labels?)`. */
function gauge(name, options) {
  const add = (n, labels) => {
    const m = metricOf(name, "gauge", options);
    if (m) seriesOf(m, labels, () => ({ value: 0 })).value += n;
  };
  return {
    set(v, labels) {
      const m = metricOf(name, "gauge", options);
      if (m) seriesOf(m, labels, () => ({ value: 0 })).value = Number(v);
    },
    inc(n = 1, labels) { if (typeof n === "object") { labels = n; n = 1; } add(n, labels); },
    dec(n = 1, labels) { if (typeof n === "object") { labels = n; n = 1; } add(-n, labels); },
  };
}

/** A histogram: `observe(v, labels?)`, in base units (seconds, bytes). Buckets: `options.buckets`, else seconds. */
function histogram(name, options) {
  return {
    observe(v, labels) {
      const m = metricOf(name, "histogram", options);
      if (!m) return;
      const h = seriesOf(m, labels, () => ({ counts: new Array(m.buckets.length).fill(0), sum: 0, count: 0 }));
      for (let i = 0; i < m.buckets.length; i++) if (v <= m.buckets[i]) h.counts[i]++;
      h.sum += v; h.count++;
    },
  };
}

/**
 * Runs `fn` and observes how long it took, in seconds, into the histogram `name` (its result returned as is, a promise
 * awaited first). An error still counts, labelled `outcome: "error"` (else "ok").
 */
function time(name, fn, labels = {}, options) {
  if (!store()) return fn();
  const h = histogram(name, options);
  const start = process.hrtime.bigint();
  const done = (outcome) => h.observe(Number(process.hrtime.bigint() - start) / 1e9, { ...labels, outcome });
  let result;
  try { result = fn(); } catch (error) { done("error"); throw error; }
  if (result && typeof result.then === "function") return result.then((v) => { done("ok"); return v; }, (e) => { done("error"); throw e; });
  done("ok");
  return result;
}

/** A function run before each read of the store, to set gauges from the current state (process memory, say). */
function collect(fn) {
  const s = store();
  if (s) s.collectors.add(fn);
  return () => s?.collectors.delete(fn);
}

const CONTENT_TYPE = "text/plain; version=0.0.4; charset=utf-8";
const escapeLabel = (v) => v.replace(/\\/g, "\\\\").replace(/\n/g, "\\n").replace(/"/g, '\\"');
const escapeHelp = (v) => v.replace(/\\/g, "\\\\").replace(/\n/g, "\\n");
const labelText = (pairs) => (pairs.length ? `{${pairs.map(([n, v]) => `${n}="${escapeLabel(v)}"`).join(",")}}` : "");
const num = (v) => (Number.isFinite(v) ? String(v) : v > 0 ? "+Inf" : v < 0 ? "-Inf" : "NaN");

/** The store as Prometheus' text format (0.0.4); "" with metrics off. */
function render() {
  const s = store();
  if (!s) return "";
  for (const fn of s.collectors) { try { fn(); } catch { /* a collector that fails leaves its gauges as they were */ } }
  const out = [];
  for (const m of [...s.metrics.values()].sort((a, b) => (a.name < b.name ? -1 : 1))) {
    if (m.help) out.push(`# HELP ${m.name} ${escapeHelp(m.help)}`);
    out.push(`# TYPE ${m.name} ${m.type}`);
    for (const [key, v] of m.series) {
      const pairs = JSON.parse(key);
      if (m.type !== "histogram") { out.push(`${m.name}${labelText(pairs)} ${num(v.value)}`); continue; }
      for (let i = 0; i < m.buckets.length; i++) out.push(`${m.name}_bucket${labelText([...pairs, ["le", num(m.buckets[i])]])} ${v.counts[i]}`);
      out.push(`${m.name}_bucket${labelText([...pairs, ["le", "+Inf"]])} ${v.count}`);
      out.push(`${m.name}_sum${labelText(pairs)} ${num(v.sum)}`);
      out.push(`${m.name}_count${labelText(pairs)} ${v.count}`);
    }
  }
  return out.length ? `${out.join("\n")}\n` : "";
}

/** Whether the store is open (the shell turned metrics on). */
const enabled = () => store() !== null;

module.exports = { counter, gauge, histogram, time, collect, render, enabled, open, close, CONTENT_TYPE, DEFAULT_BUCKETS };
