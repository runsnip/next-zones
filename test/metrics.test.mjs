/* metrics.cjs: the store a shell opens, the functions a zone's code writes with, and the Prometheus text. */
import { test } from "node:test";
import assert from "node:assert/strict";
import { createRequire } from "node:module";

const require = createRequire(import.meta.url);
const metrics = require("../src/metrics.cjs");

test("with metrics off, every function does nothing and the text is empty", () => {
  metrics.close();
  metrics.counter("a_total").inc();
  metrics.gauge("b").set(3);
  metrics.histogram("c_seconds").observe(1);
  assert.equal(metrics.time("d_seconds", () => 42), 42);
  assert.equal(metrics.enabled(), false);
  assert.equal(metrics.render(), "");
});

test("counters, gauges and histograms render as Prometheus text, one series per label set", () => {
  metrics.close(); metrics.open();
  try {
    const c = metrics.counter("app_jobs_total", { help: "Jobs\nstarted" });
    c.inc(); c.inc(2, { kind: "pdf" }); c.inc({ kind: "pdf" });
    const g = metrics.gauge("app_queue", { help: "Waiting" });
    g.set(5); g.dec(2); g.inc({ lane: "a" });
    const h = metrics.histogram("app_render_seconds", { help: "Renders", buckets: [0.1, 1] });
    h.observe(0.05, { b: "2", a: "1" }); h.observe(0.5, { a: "1", b: "2" }); h.observe(3, { a: "1", b: "2" });
    const text = metrics.render();
    assert.match(text, /# HELP app_jobs_total Jobs\\nstarted\n# TYPE app_jobs_total counter\napp_jobs_total 1\napp_jobs_total\{kind="pdf"\} 3\n/);
    assert.match(text, /app_queue 3\napp_queue\{lane="a"\} 1\n/);
    /* Buckets are cumulative, the label order does not make another series. */
    assert.match(text, /app_render_seconds_bucket\{a="1",b="2",le="0.1"\} 1\napp_render_seconds_bucket\{a="1",b="2",le="1"\} 2\napp_render_seconds_bucket\{a="1",b="2",le="\+Inf"\} 3\napp_render_seconds_sum\{a="1",b="2"\} 3.55\napp_render_seconds_count\{a="1",b="2"\} 3\n/);
    assert.ok(text.indexOf("app_jobs_total") < text.indexOf("app_queue") && text.indexOf("app_queue") < text.indexOf("app_render_seconds"));
  } finally { metrics.close(); }
});

test("label values are escaped; bad names, negative counts and a name of two types are refused", () => {
  metrics.close(); metrics.open();
  try {
    metrics.counter("x_total").inc({ path: 'a"b\\c\nd' });
    assert.match(metrics.render(), /x_total\{path="a\\"b\\\\c\\nd"\} 1/);
    assert.throws(() => metrics.counter("bad name").inc(), /not valid/);
    assert.throws(() => metrics.counter("y_total").inc({ "bad-label": "1" }), /label name/);
    assert.throws(() => metrics.counter("y_total").inc(-1), /only goes up/);
    assert.throws(() => metrics.gauge("x_total").set(1), /is a counter, not a gauge/);
  } finally { metrics.close(); }
});

test("time observes a duration and an outcome, for a value, a promise and an error", async () => {
  metrics.close(); metrics.open();
  try {
    assert.equal(metrics.time("t_seconds", () => 1, { step: "a" }), 1);
    assert.equal(await metrics.time("t_seconds", async () => 2, { step: "a" }), 2);
    assert.throws(() => metrics.time("t_seconds", () => { throw new Error("x"); }, { step: "a" }), /x/);
    await assert.rejects(metrics.time("t_seconds", async () => { throw new Error("y"); }, { step: "a" }), /y/);
    const text = metrics.render();
    assert.match(text, /t_seconds_count\{outcome="ok",step="a"\} 2/);
    assert.match(text, /t_seconds_count\{outcome="error",step="a"\} 2/);
  } finally { metrics.close(); }
});

test("collectors run before each read; one that throws leaves its gauge as it was", () => {
  metrics.close(); metrics.open();
  try {
    let n = 0;
    const g = metrics.gauge("reads");
    metrics.collect(() => g.set(++n));
    metrics.collect(() => { throw new Error("broken"); });
    assert.match(metrics.render(), /reads 1/);
    assert.match(metrics.render(), /reads 2/);
  } finally { metrics.close(); }
});

test("the store is one for every copy of the module (each build bundles its own)", () => {
  metrics.close(); metrics.open();
  try {
    const path = require.resolve("../src/metrics.cjs");
    delete require.cache[path];
    const second = require("../src/metrics.cjs");
    second.counter("shared_total").inc();
    assert.match(metrics.render(), /shared_total 1/);
  } finally { metrics.close(); }
});
