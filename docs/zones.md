# Zones: live installs

Zones is a Next production server that starts with the shell. It loads zone images from a **store** while it runs,
with no restart.

## Running it

On one machine (development, or a server that builds), in the workspace's folder (see [build and start](cli.md#build-and-start)):

```sh
next-zones build                                            # the shell, every zone as an image, zones.json pins
next-zones start --port 3000
next-zones build blog && next-zones install blog 12         # a new version of one zone: install, swap or roll back, live
```

With images built elsewhere (CI), published to a source, and pulled by the server (see [zone images](#zone-images)):

```sh
# CI
next-zones build blog --pack          # .zones-images/blog/<version>.tgz: upload it where the source points
# the server
next-zones serve --shell ./zones/app --store /srv/zones --source "https://images.example.com/{zone}/{version}.tgz"
next-zones install blog 12 --url http://127.0.0.1:3000      # Zones pulls blog 12 from the source, then installs it
```

Or from code:

```js
const { createZones } = require("@runsnip/next-zones/zones");

const zones = createZones({
  shell: "./zones/app",                       // the zone mounted at "/"
  store: process.env.NEXT_ZONES_STORE,        // <store>/<zone>/<version>/, built with next-zones build
  pins: { blog: "12", shop: "4" },             // installed at boot, under the store's state.json
  adminToken: process.env.NEXT_ZONES_ADMIN_TOKEN,
});
await zones.listen(3000);
await zones.install("blog", "13");
```

**Rules for the process:**
- One Zones per process, created before anything else requires Next. It hooks Node's module loader and Next's internals.
- `zones.handleRequest(req, res)` mounts it in a server of your own, after `zones.prepare()`.

## The store

- **`<store>/<zone>/<version>/`** holds what `next-zones build` wrote:
  - the zone's `.next` output and its `public/`;
  - `zone.json`:
    - its name, version, mount and aliases;
    - the Next and React it was built with;
    - its **integrity**, a sha256 over every file of the build;
    - **what Zones needs to install it** (routes, rules, actions, prerendered pages, config), read from the build
      once, at build time.
- **A build is checked before it is installed.** The first time Zones installs a stored build, it hashes it in a
  worker thread and refuses it if it differs from the build that was stored: copied in part, or changed since.
  Nothing changes on a refusal. A build is checked once per process.
- **`zones.json`** (read by `next-zones serve`, or `createZones({ pins })`) pins the versions a deploy starts with:
  `{ "zones": { "blog": "12", "shop": "4" } }`. It is read-only; installs since are kept in `state.json`, which is
  read over it.
- **`<store>/state.json`** holds the active version of each zone, and the last installs of each (the rollback window
  [pruning](#pruning) keeps).
  - Zones writes it after every install (to a temporary file, then renamed).
  - It reads it at boot, over `pins`, so a restart keeps the versions that were live.
  - A zone that fails at boot is reported (`zones.boot()`) and skipped. Zones still starts.
- **`<store>/zones.pid`** names the Zones serving from the store, so `next-zones prune` never works under it.
- **The store can live anywhere** (a volume, another disk). A zone's dependencies resolve from the shell's
  `node_modules`.

## Endpoints

Zones serves **no URL of its own unless the project declares it**, in the shell's `next.config`, under one base path
(`/_next-zones` unless changed):

```js
export default zoneConfig({
  mount: "/",
  endpoints: { base: "/_next-zones", events: true, health: true, admin: true },   // each group off unless set
});
```

`createZones({ endpoints })` overrides the shell's declaration (`false` for none). The base may not be a path the
shell serves, or a zone's mount.

| Group | Endpoint | What it does |
|---|---|---|
| `events` | `GET <base>/events` | The swap events [`<ZoneUpdates />`](updates.md) listens to: only zone names and versions. Public |
| `health` | `GET <base>/health` | 200 `{ ok, degraded }` once Zones serves, for a supervisor such as Docker's `HEALTHCHECK`. A zone that failed at boot makes it `degraded`, not unhealthy: a restart would not fix its build. An admin also gets the active versions, the boot failures, uptime and RSS |
| `admin` | `GET <base>/images` | The zone images in the store, by zone: version, active or not, live pull, built with, integrity |
| | `GET <base>/images/<zone>/<version>` | One zone image |
| | `POST <base>/images/<zone>/<version>/pull` | Asks Zones to pull it from its sources into the store, without installing it: 200 `{ pulledFrom }` (`null` when it was there). A ping: only for a zone that allows [live pulls](#live-pulls) |
| | `POST <base>/images/<zone>/<version>/install` | Installs, swaps to or rolls back to it, pulled first (as a ping) when the store lacks it: 200 with the timings; 409 with the reason when refused (nothing changes) |
| | `DELETE <base>/images/<zone>/<version>` | Removes it from the store. Never the active version; one whose code other versions still share is refused until a restart |
| | `POST <base>/prune?keep=2[&dry=1]` | [Prunes](#pruning) the store: `{ removed, held, kept, freedBytes }`. `dry=1` only says what it would do |
| | `POST <base>/collect?keep=2` | Collects old versions' loaded code and disk caches (not their images), keeping the active one and `keep` before it per zone |
| | `POST <base>/policy` | Replaces the instrumentation policy |

**A zone image never travels over these endpoints.** There is no upload: they ask Zones to pull, and Zones fetches
the image from its own sources.

**Admin** means `Authorization: Bearer <adminToken>` (`createZones({ adminToken })`, or `NEXT_ZONES_ADMIN_TOKEN` for
`next-zones serve`), or, with no token configured, a request from the same machine. A token never goes in
`next.config`.

## What happens on an install

1. **Stage.** Zones reads the zone build: its routes, server actions and prerendered pages. Then it checks the
   rules: the mount, the aliases, no zone-level `proxy.ts`, the same Next version.
2. **Prepare.** Everything that grows with the size of the app is computed **before** the switch.
3. **Switch.** One synchronous step, so no request ever sees half an install. It takes about **3 µs** (median, an app
   of 248 routes, 75 of them dynamic, and a zone of 29 routes).

The heavy work of a first install (seeding the zone's cache, analysing its chunks) runs in worker threads, so the
server keeps answering while it runs. Reinstalling a version, for a rollback, takes about 4 ms.

Under load, with 32 clients and 18 swaps, no request got a wrong answer.

A rollback is the same operation with the previous version. Installs can run at the same time: their heavy work
runs in parallel, and their switches take turns.

## What a user notices

- **Nothing reloads.** `<Link>` between zones is soft, and client state is kept.
- **After a swap,** the next navigation renders the new version, its client code included. With
  [`<ZoneUpdates />`](updates.md) in the shell, that holds even for a static page the tab had cached.

## What is shared

- **One React, and one copy of every module the zones share** (a layout, a UI kit, a database client), on the server
  and in the browser.
- **Each zone's own modules stay its own,** and so does each version's: v1 and v2 never mix.
- **A module is shared only when it is the same module:** the same code, whatever ids the builds gave it (a bigger
  build has longer ids). A zone built against another version of a package than the shell gets its own copy of that
  package's modules. That is right for code without state; a module with state (a context, a singleton) then exists
  twice, and the zone does not see what the shell set up in it (a provider in the shell's layout, a client). The
  install names such modules in its `warnings` (and the log); `createZones({ strictModules: true })` refuses the zone
  instead. Build the shell and the zones against the same versions of what they share.
- **One project root for every build:** Zones refuses a zone image built from another root than the shell's
  ([configuration](configuration.md#the-project-root)).

## What works inside a zone

All of App Router's routing (dynamic and catch-all routes, groups, parallel and intercepting routes, `loading`,
`error`, `not-found`), route handlers and metadata routes, server actions, prerendering, ISR and
`generateStaticParams`, revalidation across zones, `next/font`, `next/image`, [public files](assets.md), the shell's
`proxy.ts`, the zone's [routing rules](routing-rules.md), [aliases](aliases.md), [instrumentation](instrumentation.md).

See [What is supported](support.md) for the full list.

## Zone images

A **zone image** is one version of a zone as `next-zones build` stores it: `<store>/<zone>/<version>/`, the build
with `zone.json`. It holds only what serving needs (no build cache, traces or generated types): 18 MB for the test
blog, 3.5 MB packed. A real app's image can weigh hundreds of MB. `next-zones pack <zone image dir>` packs one into a
single `.tgz`, the form a source serves.

### How an image enters the store: a pull

An image enters a store only by being **pulled**: the server fetches it from a **source**, checks it, and moves it into
the store in one rename. Nothing is uploaded to Zones. (A store can also be built into directly, with
`next-zones build --store`, on a machine that builds.)

- **Sources** are given to Zones (`createZones({ sources })`, `next-zones serve --source`), tried in order.
  `@runsnip/next-zones/sources` has three:
  - `fromHttp("https://…/{zone}/{version}.tgz", { headers, stallMs, retries })`;
  - `fromConnector({ origin, owner, token })`: service-connector, an image gateway that checks who may pull what
    (`GET /api/connector/images/zones/<owner>/<zone>@<version>`; `next-zones serve --connector <origin>
    --connector-owner <owner>`, the token from `NEXT_ZONES_CONNECTOR_TOKEN`). A refusal fails the pull with the reason
    it gives (`401 sign_in_required`, `403 plan_limit`);
  - `fromDirectory(root)`: a folder or a mounted volume holding `<zone>/<version>/`, `<zone>/<version>.tgz` or
    `<zone>/<version>.zip`.

  A source of your own is `{ name, fetch({ zone, version, into, signal }) }`: it writes the image's files into `into`
  and resolves `true`, or resolves `false` when it does not have that version. It should stream, and pass `signal` on.
- **Two formats.** An image arrives as a `.tgz` (`next-zones pack`) or a `.zip` (`next-zones pack --out x.zip`,
  `build --pack --format zip`: the format of an image gateway's store), told apart by its first bytes. An archive whose
  files sit in one top-level folder, as a repository's archive of a tag does (`<repo>-<ref>/zone.json`), is unwrapped.
- **Streamed.** Both formats are unpacked as they arrive, with nothing spooled to disk. A `.zip`'s files are inflated
  and written in parallel as the next ones arrive (up to 4 at once, 16 MB in flight), each checked against its CRC-32,
  and its central directory, at its end, must agree with what was written. Nothing holds the whole image in memory: a
  300 MB image pulls in about 0.3–0.4 s at 160 MB peak RSS as `.tgz`, 0.5 s at about 210 MB as `.zip` (see
  [the numbers](#the-numbers)).
- **Over a shared link.** A response that sends nothing for `stallMs` (30 s) is dropped, and a dropped or stalled
  response is resumed from the byte reached (`Range`, with `If-Range` so a changed file is never spliced), up to
  `retries` (3) times. Only the wait on the network counts toward a stall, not the time the disk takes. A server that
  cannot resume fails the pull, and the store is unchanged.
- **Checked.** A pulled image must name the zone and version asked for, and match the integrity recorded at build
  time. Anything else is refused, and the store and the active version are unchanged.

**Who asks for a pull:**
- **The server side, for any zone:** `next-zones pull <zone> <version> --store <dir> --source …` (a deploy step),
  `zones.pull()` and `zones.install()` from code, and a version pinned at boot that the store lacks.
- **A ping, for a zone that allows it:** an admin request, `POST <base>/images/<zone>/<version>/pull` (or `/install`
  of a version the store lacks; `next-zones pull … --url`, `next-zones install … --url`). See below.

### Live pulls

A ping can make Zones pull only a zone that declares it: `zoneConfig({ mount, livePull: true })`, recorded in every
image's `zone.json`.
- Zones reads the flag from the zone's latest image in the store **before anything is fetched**, so a ping for a zone
  without it costs nothing. The pulled image must declare it too.
- A zone's **first image** is pulled on the server side: before it, there is nothing to read the flag from.
- Without `livePull`, the zone's images are pulled on the server side only, by the deploy.

### The disk

A pull leaves **`minFree`** bytes free on the store's disk (`createZones({ minFree })`, `--min-free <MB>`; 1 GiB by
default).
- **Before it starts,** the image's size is estimated from the zone's latest image (`zone.json` records the build's
  bytes). Short of room, Zones prunes the store first; if it still does not fit, the pull is refused, with the numbers.
- **While it runs,** the free space is read every 250 ms. The pull stops as soon as it falls below `minFree`, and
  what it wrote is removed. A source's sizes are never trusted.

### Pruning

Every pull adds an image, so a store left alone fills its disk. **Pruning removes the images no longer needed**, with
their disk caches. For each zone with an active version, it keeps:
- the **active** version;
- the version **pinned** for it (`zones.json`, `createZones({ pins })`);
- the **`keep`** versions installed last before the active one (2 by default): the rollback window, from the install
  history in `state.json`, so it holds across restarts;
- images **pulled but not installed yet** (added after the zone's last install);
- images being installed, and images whose loaded code other versions still share (reported as `held`; they go after a
  restart).

Every other version of that zone is removed. A zone with no active version is left alone. Folders a crashed pull left
behind are removed too.

**When it runs:**
- **automatically**, after every pull and install, and at boot (`createZones({ prune: { keep: 2, auto: true } })`;
  `{ auto: false }` or `prune: false` to turn it off; `next-zones serve --keep <n>` or `--no-prune`);
- **on request:** `POST <base>/prune?keep=…`, `zones.prune({ keep, dryRun })`, `next-zones prune --url …`;
- **on a store no Zones runs on:** `next-zones prune --store <dir> [--keep 2] [--pins zones.json] [--dry-run]`. It is
  refused while a Zones serves from that store (`zones.pid`): that Zones must unload what is removed, so prune it
  through Zones.

**Memory.** When a version is collected, its code is unloaded, and once Zones has been idle for a second it hands
back what V8 still keeps of it (its compilation cache, the heap's grown pages) with a last-resort collection: tens of
ms, at most once per collect, and never while a request is in flight unless 30 s have passed
(`createZones({ reclaim: { idleMs, maxWaitMs } })`, or `false`). Over 120 versions of a test zone, RSS stays flat.

Pruning is distinct from **collecting** (`POST <base>/collect`): collecting frees what a running Zones holds for an
old version (loaded code, disk caches) and leaves its image in the store; pruning removes images.

### The numbers

Pulling one zone image over HTTP (`fromHttp` into an empty folder), each run in a fresh process: a synthetic,
build-shaped image (files of 4 KB to 2 MB, 60% random bytes, 40% repetitive JavaScript), median of 3 runs, Node
24.16, Apple M1. Peak RSS includes Node's own ~45 MB. Repeat it with `node tools/bench/pull.mjs --mb 300 --against <git ref>`.

| Image | Peak RSS, streamed | Time, streamed | Peak RSS, held in memory (the previous reader) | Time, held in memory |
|---|---|---|---|---|
| 300 MB (180 MB packed) | 154 MB | 3.1 s | 756 MB | 7.0 s |
| 600 MB | 164 MB | 6.8 s | | |

The 10 MB between 300 and 600 MB is garbage not yet collected, not the image: memory stays flat as images grow.

## Supported Next versions

Zones works on Next's internals, so it runs only on the Next versions next-zones has been checked against (today
16.3.6, 16.3.7, 16.3.8 and 16.4.0; 16.3.8 fixes security issues in Next, among them SSRF in the image optimizer and
cache poisoning: use 16.3.8 or 16.4.0). On any other version, or on a Next where a module or function it hooks has moved, `createZones` throws before
anything is hooked, and lists every difference:

```
next-zones: this Next does not match what Zones relies on (next 16.5.0):
  - Next 16.5.0 has not been checked with next-zones (checked: 16.3.6, 16.3.7, 16.3.8, 16.4.0); run tools/upgrade-guard.mjs 16.5.0, …
```

`createZones({ unsupportedNext: true })` runs anyway. It is meant for the upgrade guard, which runs the whole check
suite on the new version before it is added.

