# Changelog

What changed in each version of `@runsnip/next-zones` on npm. The versions follow [semver](https://semver.org); before
1.0, a minor version may change what the package does.

## 0.1.2 (unreleased)

### Added

- **Zones: a stop drains.** `next-zones serve` and `start` drain on `SIGTERM` or `SIGINT` (`docker stop`, a rolling
  deploy): no new connection is taken, the requests in flight are answered with `Connection: close`, `<base>/health`
  answers `503`, and the open tabs' event streams end with `retry: 1000`, so they reconnect through the proxy to a Zones
  that stays; then it exits 0. `--drain-timeout` (or `NEXT_ZONES_DRAIN_TIMEOUT_MS`, 25 s by default) bounds the wait.
  `zones.drain({ timeoutMs })` does the same from code; `zones.close()` is it. Before, a stop cut what was in flight.
- **Zones: a tab learns that a deploy replaced the process.** Every `<base>/events` stream begins with a `hello` event
  naming what the process serves (the shell's build, each zone's version and build); `<ZoneUpdates />` refreshes, as
  on a swap, when it reconnects to a process serving something else. See [rolling deploys](docs/zones.md#rolling-deploys).
- **Zones: a zone's public files, precompressed.** A file with a `.br` or `.gz` sibling (`fonts/a.ttf.br`) is sent as
  that sibling when the request's `Accept-Encoding` allows it (q-values read, brotli first on a tie), with
  `Content-Encoding`, the original's `Content-Type`, the sibling's `Content-Length` and `Vary: Accept-Encoding`. A
  `Range` request gets the plain file's bytes (`206`, `If-Range`, `416`). See [public files](docs/assets.md#public-files).
- **Zones: immutable caching for a content-addressed URL.** A public file asked for with `?h=<hash>` or `?v=<hash>` is
  served `Cache-Control: public, max-age=31536000, immutable`; the names are the zone's new `hashQuery` option.

### Fixed

- **Zones**: a zone's files carry `ETag` and `Last-Modified` and answer `If-None-Match` and `If-Modified-Since` with
  `304`; `HEAD` answers carry `Content-Length`. Before, every revalidation sent the whole file again.
- **Zones: a zone's Web Workers run.** A worker's runtime chunk (and a SharedWorker's) is written again when the chunks
  it waits for are, with their new names and remapped ids, and the module that starts the worker names it so. Before,
  only the page's runtime chunk was: a worker whose chunks were written again waited for chunks under their old names
  and never ran its entry. Every list of chunks a zone's code holds (an async loader's, a worker's, a runtime's
  registration) now names a chunk by its new name, whichever was written again first.
- **Zones: a zone's stylesheets load after a soft navigation**, and the shell's after one back from a zone. The shell
  and every zone have their own root layout at the segment `""`, so Next rendered a navigation between them from below
  the root and left the root layout's stylesheets out (a zone's `globals.css`, say): only a full load had them. The
  root layout's stylesheets are now named by the segments below it too: in each route's client reference manifest (the
  shell's and the zones'), and in the flight data and segments of a page prerendered before, as Zones reads them from
  its cache (and as `mode: "single"` and `output: "export"` link them). A stylesheet stays loaded after the navigation
  away, as Next keeps a layout's.

## 0.1.1 (2026-10-11)

### Fixed

- **`next-zones dev`**: a zone's `turbopack.resolveAlias` reaches the composed app. Before, only the shell's was kept,
  so a zone that aliases packages to their sources ran on their built output instead. A relative target (`./`, `../`)
  is read from the zone's folder, as when the zone runs alone; one alias with two targets is refused.
- **Zones**: a client chunk written again under a new name is named so everywhere it is loaded from, async loaders
  (a dynamic `import()`) and the `react-loadable` manifest included. Before, a chunk a lazy component loaded kept its
  old name, and the page failed with "module factory is not available".
- **Zones on Next 16.4.0**: the runtime's registration, inline in the page from 16.4, names the chunks written again
  and the remapped module ids, so a zone's page hydrates.
- **`mode: "single"` and `output: "export"`**: the link writes the zone's main chunk again.

### Changed

- The package declares its types at the top level (`types`, `typesVersions`), so npm marks it as typed and
  TypeScript's `node10` resolution finds each entry point's types.

## 0.1.0 (2026-10-11)

The first release.

- **Zones** (`createZones`, `next-zones start`, `serve`): every zone in one Node process, soft `<Link>` navigation
  between zones' App Router pages, one React, a module the zones share loaded once.
- **Live installs**: a new version of a zone installed, swapped or rolled back while Zones runs (`next-zones install`),
  about 3 µs for the switch; stop and resume a zone (`next-zones stop`, `resume`), and every zone with its state
  (`next-zones zones`).
- **Zone images**: built by `next-zones build`, pulled from a folder, a URL template or service-connector (streamed,
  `.tgz` or `.zip`, resumed on a dropped connection, checked against the build's integrity), pruned.
- **One app** (`mode: "single"`): every zone linked into one Next app for `next start`, with `output: "standalone"`
  and `"export"` in both modes.
- **The Pages Router** in a zone, in every mode.
- **`next-zones dev`**: every zone in one `next dev`, with HMR; `init`, `add`, `check` and `doctor`.
- **`<ZoneUpdates />`** and `useZoneState()` (`@runsnip/next-zones/client`).
- **Metrics** as Prometheus text (`@runsnip/next-zones/metrics`).
- **Zones as an MCP server** (`@runsnip/next-zones/mcp`): Zones' tools and yours, skills, Bearer and OAuth.
- Next.js 16.3.6, 16.3.7, 16.3.8 and 16.4.0; Node.js 24.
