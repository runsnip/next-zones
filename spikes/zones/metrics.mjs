/*
 * The metrics store (zoneConfig({ metrics: true }) on the shell): Zones measures every request by zone, version and
 * status class, its installs and the process, and a zone's code writes its own (blog's /blog/metric: a counter and a
 * timed piece of work, through @runsnip/next-zones/metrics), all into one store, read as Prometheus text at
 * <base>/metrics.
 */
const BASE = "http://127.0.0.1:3900";
await fetch(`${BASE}/_next-zones/images/blog/1/install`, { method: "POST" });
for (let i = 0; i < 3; i++) await (await fetch(`${BASE}/blog/metric`)).text();
await (await fetch(`${BASE}/blog/42`)).text();
await (await fetch(`${BASE}/`)).text();
await (await fetch(`${BASE}/blog/no/such/page`)).text();
const res = await fetch(`${BASE}/_next-zones/metrics`);
const text = await res.text();
const value = (re) => Number((re.exec(text) ?? [])[1] ?? NaN);
const found = {
  status: res.status,
  contentType: res.headers.get("content-type"),
  blogOk: value(/^nextzones_requests_total\{code="2xx",version="1",zone="blog"\} (\d+)$/m),
  blog4xx: value(/^nextzones_requests_total\{code="4xx",version="1",zone="blog"\} (\d+)$/m),
  shellOk: value(/^nextzones_requests_total\{code="2xx",version="",zone="shell"\} (\d+)$/m),
  durationCount: value(/^nextzones_request_duration_seconds_count\{zone="blog"\} (\d+)$/m),
  installs: value(/^nextzones_install_seconds_count\{outcome="ok",zone="blog"\} (\d+)$/m),
  active: value(/^nextzones_zone_active\{version="1",zone="blog"\} (\d+)$/m),
  rss: value(/^process_resident_memory_bytes (\d+)$/m),
  zoneViews: value(/^blog_metric_views_total\{page="metric"\} (\d+)$/m),
  zoneWork: value(/^blog_metric_work_seconds_count\{outcome="ok",step="sum"\} (\d+)$/m),
};
const wrong = {};
if (found.status !== 200 || !/^text\/plain; version=0\.0\.4/.test(found.contentType ?? "")) wrong.response = { status: found.status, contentType: found.contentType };
if (!(found.blogOk >= 4)) wrong.blogOk = found.blogOk;
if (!(found.blog4xx >= 1)) wrong.blog4xx = found.blog4xx;
if (!(found.shellOk >= 1)) wrong.shellOk = found.shellOk;
if (!(found.durationCount >= 5)) wrong.durationCount = found.durationCount;
if (found.installs !== 1) wrong.installs = found.installs;
if (found.active !== 1) wrong.active = found.active;
if (!(found.rss > 1e7)) wrong.rss = found.rss;
if (found.zoneViews !== 3) wrong.zoneViews = found.zoneViews;
if (found.zoneWork !== 3) wrong.zoneWork = found.zoneWork;
console.log(JSON.stringify({ ...found, wrong }, null, 2));
process.exit(Object.keys(wrong).length ? 1 : 0);
