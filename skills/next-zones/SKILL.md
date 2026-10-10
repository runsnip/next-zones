---
name: next-zones
description: Use when a project depends on @runsnip/next-zones, or the task is about zones of Next.js apps served as one app (zoneConfig, a shell mounted at "/", next-zones build/start/serve/install/pull, zone images, Zones' /_next-zones endpoints, ZoneUpdates, next-zones metrics). Not Next.js Multi-Zones.
---

# next-zones

`@runsnip/next-zones` serves several Next.js apps (zones) as one app in one Node process, with soft navigation
between them and live installs of a zone's new version. It is **not** Next.js Multi-Zones: never answer with a
`basePath` per zone, `rewrites` to other servers or `assetPrefix`.

## Read first

The package ships its documentation for models:

- `node_modules/@runsnip/next-zones/llms.txt`: the essentials an assistant most often gets wrong. Read it whole
  before writing any config or command.
- `node_modules/@runsnip/next-zones/llms-full.txt`: every page of the docs in one file, each page after a
  `<!-- docs/<page>.md -->` line. Read the page for the task (configuration, cli, zones, metrics, support…) before
  answering from memory.

If they are not installed, the same files are at `https://next-zones.runsnip.net/llms.txt` and
`https://next-zones.runsnip.net/llms-full.txt`.

## Before you answer

- Check the installed version (`node_modules/@runsnip/next-zones/package.json`) and the project's Next version:
  Zones runs only on the Next versions the docs list.
- Take facts from the docs, not from Multi-Zones or other Next.js knowledge. When the docs do not say, say so.
- After changing a workspace, run `next-zones doctor <dir>` (or `next-zones check <dir>`) and act on what it reports.
