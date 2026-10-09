# Metrics

One store of metrics for the whole Zones process: what Zones measures of itself, and what any zone's code measures,
read as Prometheus text. Off unless the shell turns it on.

```js
// shell/next.config.mjs
export default zoneConfig({ mount: "/", metrics: true });
```

`createZones({ metrics })` overrides the shell's declaration.

## Reading it

`GET <base>/metrics` (`/_next-zones/metrics` unless the shell's endpoints declare another base), to an admin: a request
with `Authorization: Bearer <adminToken>`, or from the same machine when no token is configured. The body is
Prometheus' text format (`text/plain; version=0.0.4`): point a Prometheus scraper, an OpenTelemetry collector or
any tool that reads that format at it. Nothing is pushed anywhere.

## What Zones measures

| Metric | Type | Labels | |
|---|---|---|---|
| `nextzones_requests_total` | counter | `zone`, `version`, `code` (`2xx`…`5xx`) | Every request; `zone` is `shell` for the shell's pages and `static` for `/_next/…` files |
| `nextzones_request_duration_seconds` | histogram | `zone` | Time to the end of each response |
| `nextzones_install_seconds` | histogram | `zone`, `outcome` | Installs, from staging to serving |
| `nextzones_install_blocked_seconds` | histogram | `zone` | The longest the event loop was held during an install |
| `nextzones_pull_seconds` | histogram | `zone`, `via`, `outcome` | Pulls of a zone image from a source |
| `nextzones_pruned_images_total`, `nextzones_pruned_bytes_total` | counter | | What pruning removed |
| `nextzones_zone_active` | gauge | `zone`, `version` | 1 for the version that serves; 0 once a swap replaced it |
| `nextzones_registry_modules` | gauge | | Server modules shared across builds |
| `nextzones_registry_shared_total` | counter | | Times a build used a module another build had loaded |
| `nextzones_reclaims_total` | counter | | Last-resort collections after a version was collected |
| `process_resident_memory_bytes`, `nodejs_heap_used_bytes`, `nodejs_heap_total_bytes`, `nodejs_external_memory_bytes` | gauge | | The process |
| `nodejs_eventloop_delay_seconds` | gauge | `quantile` (`0.5`, `0.99`, `1`) | Event loop delay since the last read |
| `process_uptime_seconds` | gauge | | |

## Measuring in a zone

```ts
import { counter, gauge, histogram, time } from "@runsnip/next-zones/metrics";

const exportsStarted = counter("blog_exports_total", { help: "Exports started" });
const queue = gauge("blog_queue_length", { help: "Jobs waiting" });
const size = histogram("blog_export_bytes", { help: "Export sizes", buckets: [1e4, 1e5, 1e6, 1e7] });

exportsStarted.inc({ format: "pdf" });
queue.set(12);
size.observe(file.byteLength);
const html = await time("blog_render_seconds", () => render(post), { kind: "post" });   // labelled outcome "ok" or "error"
```

- **One store for every zone.** The shell and each zone are separate builds, and each bundles this module; they all
  write to the one store Zones opened. Two zones may write one metric (with labels of their own).
- **Off, they do nothing.** With metrics off, or in the browser, or when the zone runs alone with `next start`, every
  function returns without a trace, so a zone's code can measure unconditionally.
- **Prometheus' rules:** a name is letters, digits, `_` and `:`; a counter only goes up; values in base units (seconds,
  bytes). A name keeps the type it was first used with: using it as another type throws.
- `collect(fn)` runs `fn` before each read, to set gauges from the current state.
