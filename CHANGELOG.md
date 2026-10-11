# Changelog

What changed in each version of `@runsnip/next-zones` on npm. The versions follow [semver](https://semver.org); before
1.0, a minor version may change what the package does.

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
