# CLI

| Command | What it does |
|---|---|
| `next-zones init <dir> [zone…] [--no-install]` | A new workspace: a shared package, the shell and its zones, installed ([getting started](getting-started.md#the-quick-way)) |
| `next-zones add <zone> [--mount /<segment>]` | One more zone in the workspace of the current folder |
| `next-zones check <dir> [more dirs…]` | Checks the zones' declarations: mounts, the shell, aliases (below) |
| `next-zones doctor <dir> [more dirs…] [--store <dir>] [--url <zones url>] [--fast]` | Checks a workspace from source for everything Zones and `dev` need, with what to do (below) |
| `next-zones build [--dir .] [--version <v>] [--store <dir>] [--pack] [--out <dir>]` | Builds the workspace as its shell declares ([build and start](#build-and-start)): with `mode: "zones"`, the shell as an app, every zone as an image, and `zones.json` pinning the versions built |
| `next-zones build <zone>… [--dir .] [--version <v>] [--store <dir>] [--pack] [--out <dir>]` | Builds only these zones' images, to release what changed. The shell is not built |
| `next-zones start [--dir .] [--store <dir>] [--source <url template \| dir>]… [serve's options]` | Runs what `build` made: Zones, the shell, the pinned images |
| `next-zones serve --shell <dir> [--store <dir>] [--cache <dir>] [--pins zones.json] [--policy zones.config.json] [--source <url template \| dir>]… [--connector <origin> --connector-owner <owner>] [--keep 2] [--no-prune] [--min-free <MB>] [--port 3000] [--host 0.0.0.0]` | Runs the [Zones](zones.md), installing the pinned versions of `zones.json` (if present) under the store's `state.json`. `--source` (repeatable): where it pulls zone images from. `--keep`: the rollback window [pruning](zones.md#pruning) keeps; `--no-prune` turns it off. `--min-free`: what a pull leaves free on the disk (1024 MB by default) |
| `next-zones pack <zone image dir> [--out <file.tgz \| file.zip>]` | Packs a zone image into one `.tgz`, the form a source serves (see [zone images](zones.md#zone-images)) |
| `next-zones pull <zone> <version> --store <dir> (--source <url template \| dir>… \| --connector <origin> --connector-owner <owner>) [--min-free <MB>]` | Pulls a zone image into a store, on the server side (any zone): streamed, checked, then moved in. A deploy step |
| `next-zones pull <zone> <version> --url <zones url> [--base /_next-zones]` | Pings a running Zones to pull it from its sources: only a zone that allows [live pulls](zones.md#live-pulls) |
| `next-zones prune --store <dir> [--keep 2] [--pins zones.json] [--cache <dir>] [--dry-run]` | [Prunes](zones.md#pruning) a store no Zones runs on (refused while one does) |
| `next-zones prune --url <zones url> [--base /_next-zones] [--keep 2] [--dry-run]` | Asks a running Zones to prune its store |
| `next-zones install <zone> <version> [--url http://127.0.0.1:3000] [--base /_next-zones]` | Asks a running Zones service to install, swap to or roll back to a version |
| `next-zones dev <zones dir> [--port 3000]` | Develops every zone at once: one `next dev`, with HMR and soft navigation (below) |
| `next-zones watch <zones dir> <zone> [more zones…] [--url http://127.0.0.1:3000] [--base /_next-zones] [--store <dir>]` | Rebuilds zones on every change and installs them on a running Zones service (below) |

`start`, `serve`, `install`, `pull`, `prune` and `watch` read the admin token from `NEXT_ZONES_ADMIN_TOKEN`. When the
server has a token, a command must send the same one, even from the same machine: the loopback rule holds only with
no token configured.

- **Sources** (`serve`, `start`, `pull`): `--source`, repeatable, is an `http(s)` URL template with `{zone}` and
  `{version}` (`https://images.example.com/{zone}/{version}.tgz`), or a folder. `--connector <origin>
  --connector-owner <owner>` adds a service-connector source, its token read from `NEXT_ZONES_CONNECTOR_TOKEN` (never
  from the command line). `zones.js` reads `NEXT_ZONES_SOURCES`: URL templates and folders, separated by commas; and a connector from
  `NEXT_ZONES_CONNECTOR`, `NEXT_ZONES_CONNECTOR_OWNER` and `NEXT_ZONES_CONNECTOR_TOKEN`.
- **`--shell <dir>`** (`serve`) is the shell's folder after `next-zones build`: its `next.config` and its `.next`. On a
  server, deploy that folder (or, with the shell's `output: "standalone"`, the standalone folder `build` makes, run
  with `node zones.js`); CI that builds only zone images leaves the shell's deploy as it is.
- **Publishing an image** (the `.tgz` of `build --pack`) is yours to do with any tool that puts a file where a source
  reads it (an object store behind the URL template, a folder): next-zones never uploads, and Zones accepts no upload.
- **Versions** are any of letters, digits, `.`, `_` and `-` (`12`, `1.4.0`, `2026-10-09.1`). A command always names
  the version it means.
- **`--format zip`** (`build --pack`): packs each image as a `.zip` instead of a `.tgz`.
- **`next-zones pull --store` beside a running Zones** is safe: the image is written to a folder of its own and moved in
  by one rename, and nothing active changes. The running Zones installs it when asked (`install --url`). `prune
  --store`, which deletes, is refused while a Zones runs on the store (its `zones.pid`, for a process that is still
  alive: a pid left by a crash does not block). `pull --store` prunes nothing (short of disk room, it is
  refused): a running Zones prunes after its own pulls and installs, and at boot.
- **Pins and the store's state.** `zones.json` (`--pins`) names the versions a build made; the store's `state.json`
  records what a running Zones installed since (live installs and rollbacks). At start, `state.json` wins, unless
  `zones.json` was written after it (its file time is later than `state.json`'s `updatedAt`): then a new build's pins
  win. `createZones({ pins })` given as an object has no file time: pass `pinsAt` (milliseconds) with it to say when
  they were made, or `state.json` wins. Make it the time the pins were written (at deploy), never `Date.now()` at start:
  that would undo every live install at each restart.
- **The instrumentation policy** (`zones.config.json`, see [instrumentation](instrumentation.md#the-policy)) is read
  by `start` from the workspace's folder, by `serve` from the current folder (`--policy` names another file), and by
  `zones.js` from its own folder (`build` copies it there), all when they start. Mode `"single"` reads it when it
  builds, into the one app's `instrumentation` file. `POST <base>/policy` replaces it in the running Zones
  only: the file is not written.

## Build and start

Like `next build` and `next start`, for a workspace of zones (run in the workspace's folder, or with `--dir`). The
shell declares what the workspace builds to, with `zoneConfig({ mount: "/", mode })`:

| | Command | Output | Then |
|---|---|---|---|
| **The workspace**, `mode: "zones"` (default) | `next-zones build` | The shell built as an app (`shell/.next`); every other zone as an [image](zones.md#zone-images) in `.zones-store/<zone>/<version>/`, or packed into `.zones-images/<zone>/<version>.tgz` with `--pack`; `zones.json` pinning the versions built | `next-zones start` |
| **One zone, or a few** | `next-zones build blog` | `blog`'s image only (`--pack`: a `.tgz`). The shell is not built | A running Zones installs it: `next-zones install blog 1.4.0`, or [pulls](zones.md#how-an-image-enters-the-store-a-pull) it from where you published the `.tgz` |
| **One app**, `mode: "single"` | `next-zones build` | Every zone built once, as on Zones, then each zone's image linked into one standard Next app, following the shell's Next `output` (below). No `zones.json`, no Zones at run time | `next-zones start`: `next start` of that app; see the outputs below |

- **An image's version** is the `version` in the zone's `package.json`; `--version` gives one to every zone built.
- **Images are immutable.** A version already built is kept by `next-zones build` (and said so), and refused by
  `next-zones build <zone>`: bump the zone's version.
- **One app** (`mode: "single"`) is linked from the same zone images Zones runs: one zone format, built once. The
  shell's build and every image are linked into one `.next` (`link-app.mjs`): each zone's server files, routes under
  its mount, aliases, headers, redirects and rewrites, prerendered pages, server actions, fonts, public files, its own
  packages, and instrumentation as on Zones. Each zone keeps its own build, so its own `@/*` and its own `tsconfig`
  hold as they were built. Nothing is rebuilt: a zone changed is built again alone, then linked.
- **Next's `output`, in mode `"single"`,** is each zone's own Next config's, and the link follows the shell's:
  - none: `.zones-app/.next`, served by `next start` (`next-zones start` runs it);
  - `"standalone"`: the zones linked into the shell's standalone folder (`shell/.next/standalone/…/server.js`), with
    `.next/static` and `public/` copied in, as Next's docs say a deploy must, and each zone's server files traced
    with Next's own `@vercel/nft`. The folder is the whole deploy: copied anywhere, its `server.js` serves every zone
    (`singlestandalone.mjs` runs it from outside the workspace). `next-zones start` runs it;
  - `"export"`: a static site in `.zones-export`, every zone's export linked into the shell's; links between zones
    stay soft (`singleexport.mjs`). `next-zones start` says where it is, as `next start` does not serve an export.
    Rewrites, redirects, headers and aliases do not apply to an export, as in Next.
- **Next's `output: "standalone"`, in mode `"zones"`:**
  - **The shell's config says it:** `next-zones build` makes the shell's standalone folder
    (`shell/.next/standalone/…`) the whole deploy. It adds:
    - what Next leaves to the deploy (`.next/static`, `public/`);
    - next-zones, and the files of Next that Zones uses, traced with Next's own `@vercel/nft`;
    - the shell's declaration;
    - the images built, and `zones.json`;
    - `zones.js`, which starts Zones the way Next's `server.js` starts Next.

    Copied anywhere, `node zones.js` serves every zone (`PORT`, `HOSTNAME`, `NEXT_ZONES_STORE`,
    `NEXT_ZONES_ADMIN_TOKEN`, `NEXT_ZONES_SOURCES`, `NEXT_ZONES_CONNECTOR`, `NEXT_ZONES_CONNECTOR_OWNER`,
    `NEXT_ZONES_CONNECTOR_TOKEN`, see **Sources** above). `next-zones start` runs it. Pruning keeps 2 and
    pulls leave 1024 MB free, as `serve`'s defaults.
  - **A zone's config says it:** its image carries the packages its server traces need, Next and React aside, so it
    runs where the workspace's `node_modules` is not. Zones resolves a zone's packages from the shell first (one copy
    of each), then from the image.
- **Next's `output: "export"`, in mode `"zones"`:** the shell's config and every zone's say it (each zone is exported on
  its own; next-zones never sets it). `next-zones build` exports the shell and each zone as an image (which keeps its
  `out/`), then links them into one static site, `.zones-export/`, for any static host. Linking does once what Zones
  does at install: clashing client module ids are remapped, each zone's main chunk is written, and its pages carry the
  shell's build id, so links between zones stay soft. A zone whose image has no export stops the build with the reason.
  Rebuilding one zone and linking again leaves the others as they were built.
- **`next-zones start`** runs Zones with the shell, installs the versions `zones.json` pins (newer pins replace the
  versions a previous run left live), and pulls a pinned version the store lacks from `.zones-images` or `--source`.
  `.zones-images` stays a source while it runs, so `next-zones build <zone> --pack` then a ping installs the new one.

**About `build`.** It builds each zone where it is, as `next build` would (Turbopack's cache is reused from one version
to the next). Two versions may give one id to different modules; Zones tells them apart by what each module is, its
dependencies included: an open tab runs the new version's client code after a swap, and the server never hands one
version another's module. The store defaults to `NEXT_ZONES_STORE`, else `<zones dir>/.zones-store`.

## `next-zones check`

```sh
next-zones check <dir> [more dirs…]
```

It reads every sub-folder of each `<dir>` whose `next.config` uses `zoneConfig`, and checks the set as a whole.

| Check | Error |
|---|---|
| Each mount is `/` or one segment | `blog: mount must be "/" or one URL segment like "/blog"` |
| A mount has one owner | `/ is claimed by 2 zones: a, b` |
| Exactly one shell | `no zone owns "/": exactly one zone, the shell, must declare "mount": "/"` |
| An alias does not land on a mount | `shop: alias /blog/:x lands on the mount of blog` |
| Two zones do not share an alias segment | `aliases under /post are claimed by blog, shop` |

It exits with `0` when everything holds and `1` otherwise, so it can gate a build:

```json
{ "scripts": { "zones:check": "next-zones check .", "build": "npm run zones:check && npm run build --workspaces" } }
```

> With yarn 1, do not name the script `check`: `yarn check` is a built-in command.

## `next-zones doctor`

```sh
next-zones doctor . --store .zones-store --url http://127.0.0.1:3000
next-zones doctor . --fast            # without Next's and React's checks (lint, types)
```

It reads the workspace from source, before anything is built, and reports every finding with what to do. It exits
with `1` on an error.
- `✗` **an error:** Zones would refuse the zone at install, or `next-zones dev` would not run.
- `!` **a warning:** it works, with a cost or a surprise.
- `✓` **a check that holds.**

| Check | Why |
|---|---|
| The declarations, as `check` | One shell, one owner per mount and alias segment |
| One `next`, `react` and `react-dom` for every zone | Zones loads each once |
| `basePath`, `i18n`, `trailingSlash`, `assetPrefix`, `skipTrailingSlashRedirect`, `cacheComponents`, `partialPrefetching` equal to the shell's | They shape every URL |
| `images` equal to the shell's | The shell's image optimizer serves every zone |
| A zone's `headers`, `redirects` and `rewrites` under its mount or aliases | Root rules belong to the shell |
| No `proxy`/`middleware` or `instrumentation-client` in a zone | They would not run when the zone is reached from the shell |
| A zone's `app/` holds its mount, plus root files used alone (`layout`, `not-found`, `global-error`, `global-not-found`, `error`, `loading`, `template`, `default`, CSS) | Routes outside the mount are refused |
| No zone's mount or alias on a segment the shell's `app/` serves (route groups included) | A segment has one owner; refused at install |
| No edge runtime in a zone | Not served by Zones yet |
| A zone's `pages/` holds its mount (`pages<mount>/`, `pages<mount>.tsx`), plus `_app`, `_document`, `_error`, `404`, `500` | Pages outside the mount, `pages/api/` among them (served at `/api/…`), are refused |
| A zone's `public/` holds only `public/<mount>/` | Public files are served at the root, beside other zones' |
| `env` keys with one value across zones (warning) | Composed by `dev`, a key has one value |
| A path alias that differs between zones has the form `"prefix/*": ["folder/*"]` | The form `dev` gives each zone |
| `.next/`, `node_modules/`, `.zones-dev/`, `.zones-store/`, `.zones-images/`, `.zones-cache/`, `.zones-app/`, `.zones-export/` ignored by git (errors); `next-env.d.ts`, `*.tsbuildinfo` (warnings) | Asked of git itself (`git check-ignore`), so any `.gitignore` in the repository, or a global one, counts |
| **Next's and React's checks** (not with `--fast`): `eslint-config-next`'s rules on each zone's sources, or the zone's own ESLint config; then `next typegen` and `tsc --noEmit` | Neither Next nor React ships a doctor. These are their official checks: Next's plugin, React's hooks and compiler rules, and the type check `next build` runs. They run from the workspace's installs (`eslint` 9, `eslint-config-next`, `typescript`); nothing is downloaded |
| With `--store`: `state.json` pins versions in the store, built with the shell's Next and React | Zones refuses them otherwise |
| With `--url`: a Zones answers at that URL (a warning when it does not) | |

## `next-zones dev`

```sh
next-zones dev . --port 3000          # then open http://localhost:3000
```

It composes the shell and every zone into one Next app, `<zones dir>/.zones-dev/`, and runs `next dev` on it:
- **HMR everywhere:** in every zone, and in shared packages. An edit shows in under 0.1 s, and the page keeps its
  state.
- **Soft navigation between zones,** with one React, as on Zones.

**What it writes.** Nothing is copied: the app is made of links to the zones' own files, and Next sees every edit.
- `app/`: the shell's `app/`, and each zone's `app/<mount>/` under its mount, as real folders of links to files.
  Next's route discovery does not enter linked folders.
- `next.config.mjs`: the shell's config, with each zone's `transpilePackages`, `env`, `headers`, `redirects` and
  `rewrites` added, and the zones' aliases as rewrites.
- `postcss.config.mjs`: the shell's, with Tailwind scanning the zones dir.
- `tsconfig.json`: the shell's, with the `paths` every zone agrees on.
- **Each zone keeps its own path aliases.** Next reads one tsconfig per app, so an alias that zones point to different
  folders (each zone's `@/*` → its own `src/`) is given to each zone's files by a loader rule instead.
  `@/x` in a zone's file becomes the path to that zone's `src/x`.

**What zones must agree on, composed:**
- **A path alias that differs between zones** must have the form `"prefix/*": ["folder/*"]`, which is what `@/*` is.
- **An `env` key has one value** across zones.
- **The shell's root files serve everyone.** A zone's own root layout and root `not-found` serve it when it runs alone,
  as on Zones.

## `next-zones watch`

```sh
next-zones serve --shell shell --port 3000 &        # Zones, with the shell (its folder)
next-zones watch . blog shop                         # production builds, installed on every change
```

Zones runs production builds, so this is the way to try a change exactly as it will be served. It builds each zone
once, then watches the zones dir:
- **A change inside a zone** rebuilds that zone.
- **A change in a shared package** (any folder that is not a zone) rebuilds every zone it watches.
- **Each build** is a version `dev-<time>`. It is installed on Zones at once, so an open tab with
  [`<ZoneUpdates />`](updates.md) refreshes.
- **Old versions** are collected on Zones and removed from the store. The one before is kept, for a rollback.
- **The shell is not rebuilt.** It is Zones' own build: rebuild it with `next-zones build` (never plain `next build`,
  which leaves out the [build options](configuration.md#build-options-for-zones) Zones requires) and restart Zones.

A zone build takes 6–7 s for a small zone, and installing it about 200 ms.
