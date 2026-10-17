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
next-zones serve --shell ./shell --store /srv/zones --source "https://images.example.com/{zone}/{version}.tgz"
next-zones pull blog 12 --store /srv/zones --source "https://images.example.com/{zone}/{version}.tgz"   # on the server: into the store
next-zones install blog 12 --url http://127.0.0.1:3000      # the running Zones installs it
```

`next-zones pull` runs beside a serving Zones: it writes a new folder of the store, and the running Zones reads it
when asked to install. A zone that declares `livePull: true` may skip that step: `install --url` of a version the
store lacks then asks the running Zones to pull it from its own sources first. Without `livePull`, that install is
refused, and says the image must be pulled first.

Or from code:

```js
const { createZones } = require("@runsnip/next-zones/zones");

const zones = createZones({
  shell: "./shell",                           // the shell's folder, after next-zones build
  store: process.env.NEXT_ZONES_STORE,        // <store>/<zone>/<version>/, built with next-zones build
  pins: { blog: "12", shop: "4" },             // installed at boot, under the store's state.json
  adminToken: process.env.NEXT_ZONES_ADMIN_TOKEN,
});
await zones.listen(3000);
await zones.install("blog", "13");
```

**Rules for the process:**
- One Zones per process, created before anything else requires Next. It hooks Node's module loader (`require` and, through
  Node's module hooks, `import`) and Next's internals.
- `NODE_ENV` is set to `"production"` when it is unset, as `next start` does: packages read it once, as they load.
- `zones.handleRequest(req, res)` mounts it in a server of your own, after `await zones.prepare(port, hostname)`
  (async: it readies Next and installs the pinned versions; `listen()` does both and listens). `port` and `hostname`
  are where your server listens, which Next needs to know. `handleRequest` returns a promise, and answers every
  request itself, a 404 included: catch its rejection to answer a 500.

```js
// server.mjs
import http from "node:http";
import { createZones } from "@runsnip/next-zones/zones";   // before anything imports Next
const zones = createZones({ shell: "./shell", store: "/srv/zones", adminToken: process.env.NEXT_ZONES_ADMIN_TOKEN });
await zones.prepare(3000, "0.0.0.0");
http.createServer((req, res) => zones.handleRequest(req, res).catch(() => { res.statusCode = 500; res.end(); })).listen(3000, "0.0.0.0");
```

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
  `{ "zones": { "blog": "12", "shop": "4" } }`; `createZones({ pins })` takes the inner object, `{ blog: "12" }`. It is
  read-only; installs since are kept in `state.json`.
- **`<store>/state.json`** holds the active version of each zone, and the last installs of each (the rollback window
  [pruning](#pruning) keeps).
  - Zones writes it after every install (to a temporary file, then renamed).
  - It reads it at boot, over the pins, so a restart keeps the versions that were live; unless the pins are newer
    (a `zones.json` written after `state.json`'s `updatedAt`, or `createZones({ pins, pinsAt })` with a later
    `pinsAt`, in milliseconds since the epoch): then the pins win. See the CLI's
    [pins and the store's state](cli.md).
  - A zone that fails at boot is reported (`zones.boot()`) and skipped. Zones still starts.
  - A version pruned out of the rollback window is gone from the store: rolling back to it means pulling it again
    first (`next-zones pull … --store`, or a ping for a zone with `livePull`).
- **`next-zones start` and new builds.** `start` serves the workspace's `.zones-store`, so `next-zones build blog`
  (into that store) and `build blog --pack` (into `.zones-images`, one of its sources) are both installable at once.
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

One more URL needs no group: with the shell's `metrics: true`, `GET <base>/metrics` serves the
[metrics](metrics.md) to an admin, whether `endpoints` is declared or not. `endpoints: { admin: true }` is not needed
for it.

**An admin** is a request with `Authorization: Bearer <token>`, the token being `createZones({ adminToken })` or, for
the CLI and `zones.js`, `NEXT_ZONES_ADMIN_TOKEN`. When no token is configured, an admin is any request from the same
machine (a loopback address).

| Group | Endpoint | What it does |
|---|---|---|
| `events` | `GET <base>/events` | The swap events [`<ZoneUpdates />`](updates.md) listens to: only zone names and versions, after a `hello` naming what the process serves ([rolling deploys](#rolling-deploys)). Public |
| `health` | `GET <base>/health` | Public: 200 `{ ok, degraded }` once Zones serves (503 `{ ok: false, draining: true }` while it [drains](#rolling-deploys)), for a supervisor such as Docker's `HEALTHCHECK`. A zone that failed at boot makes it `degraded`, not unhealthy: a restart would not fix its build. An admin also gets every zone and its state ([below](#zones-and-their-state)), the boot failures, uptime and RSS |
| `admin` (every endpoint of the group needs the admin token) | `GET <base>/zones` | Every zone and its state: `{ zones }` ([below](#zones-and-their-state)) |
| | `POST <base>/zones/<zone>/stop` | [Stops](#stopping-a-zone) the zone: its URLs answer 404, it stays installed. 200 `{ name, version, state, changed, ms }` |
| | `POST <base>/zones/<zone>/resume` | Resumes it: the version it has installed serves again, with no install. 200, as for stop |
| | `GET <base>/images` | The zone images in the store, by zone: version, installed or not (`active`), live pull, built with, integrity |
| | `GET <base>/images/<zone>/<version>` | One zone image |
| | `POST <base>/images/<zone>/<version>/pull` | Asks Zones to pull it from its sources into the store, without installing it: 200 `{ pulledFrom }` (`null` when it was there); 409 with the reason when refused. A ping: only for a zone that allows [live pulls](#live-pulls) |
| | `POST <base>/images/<zone>/<version>/install` | Installs, swaps to or rolls back to it, pulled first (as a ping) when the store lacks it: 200 with the timings; 409 with the reason when refused (nothing changes) |
| | `DELETE <base>/images/<zone>/<version>` | Removes it from the store. Never the installed version (serving or stopped); one whose code other versions still share is refused until a restart |
| | `POST <base>/prune?keep=2[&dry=1]` | [Prunes](#pruning) the store: `{ removed, held, kept, freedBytes }`. `dry=1` only says what it would do |
| | `POST <base>/collect?keep=2` | Collects old versions' loaded code and disk caches (not their images), keeping the active one and `keep` before it per zone |
| | `POST <base>/policy` | Replaces the instrumentation policy in the running Zones (not the file): the body is the JSON of [`zones.config.json`](instrumentation.md#the-policy), `{ "instrumentation": { … } }`, and replaces the whole policy (what it leaves out is back to the default); 200 with the policy now in force |

**A zone image never travels over these endpoints.** There is no upload: they ask Zones to pull, and Zones fetches
the image from its own sources.

A request that is not an admin's gets 401 `{ error }`, and nothing changes. A token never goes in `next.config`.

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

## Stopping a zone

A zone can be taken out of serving while Zones runs, and brought back, with no install and no restart:

```sh
next-zones stop blog          # every URL of blog answers 404
next-zones resume blog        # blog serves again, the version it has installed
next-zones zones              # every zone and its state
```

From code, `zones.stop("blog")` and `zones.resume("blog")`; over HTTP, `POST <base>/zones/blog/stop` and `/resume`
(admin); for an assistant, the MCP tools `zones_stop` and `zones_resume` ([Zones as an MCP server](mcp.md)).

- **Every URL of the zone answers 404:** under its mount, its aliases, its route handlers and server actions, its
  Pages Router pages and their `/_next/data`. The page is the shell's not-found (to an RSC request, its payload, so a
  soft navigation shows it). The zone's code does not run, its own not-found page included.
- **Where the 404 comes from** is on the response: `x-next-zones-state: stopped` and `x-next-zones-zone: blog` (for
  logs, a proxy, `curl -I`), and the same in `Server-Timing`, which the browser hands to the page. The shell's
  not-found page tells the two 404s apart with `useZoneState()`, and stays static:

  ```tsx
  // shell/app/not-found.tsx
  "use client";
  import { useZoneState } from "@runsnip/next-zones/client";

  export default function NotFound() {
    const zone = useZoneState();          // { zone: "blog", state: "stopped" }, or null
    return zone ? <p>{zone.zone} is not available right now.</p> : <p>This page could not be found.</p>;
  }
  ```

  It reads the response the page came with (a page load), or the one a soft navigation fetched, once the page has
  hydrated. The two headers are also on the request the not-found page renders for, but reading them there
  (`headers()`) makes every route of the shell dynamic: Next renders the root not-found inside every route, and a
  build with it turned `/`, `/login` and an ISR page of the test shell from static (`○`) to dynamic (`ƒ`). Only Zones
  sets these headers: a client's own `x-next-zones-*` are removed.
- **One switch,** the install's, with nothing in the zone's place: its routes, rules, aliases and segments go out in
  one synchronous step, about 4 µs; resuming switches the same build back in, about 5 µs
  ([measured](#stop-and-resume-measured)). Open tabs with [`<ZoneUpdates />`](updates.md) are told: their next navigation
  into the zone shows the 404.
- **It stays installed:** its build stays loaded, its image is never pruned, and its static files are still served,
  for a tab that loaded the zone before it stopped.
- **The shell's proxy** runs, for `/_not-found`: a rule matching the zone's path does not see the request. A URL the
  proxy (or a rewrite) sends into a stopped zone answers the same 404, marked.
- **A version installed while the zone is stopped** replaces the stopped one and stays stopped (the install's result
  says `state: "stopped"`); resuming serves it. A rollback works the same way.
- **Across restarts:** `state.json` records the stopped zones, and a restart keeps them stopped, unless newer pins
  replace the state ([pins and the store's state](cli.md)).
- **Measured:** `nextzones_zone_stopped{zone}` is 1 while a zone is stopped; `nextzones_stopped_requests_total{zone}`
  counts the requests answered 404 for it ([metrics](metrics.md)).

### Zones and their state

`zones.zones()`, `GET <base>/zones`, the admin part of `<base>/health`, `next-zones zones --json` and the MCP tool
`zones_status` tell every zone the same way:

```json
{
  "blog": { "state": "serving", "version": "1.4.0", "mount": "/blog", "aliases": ["/post/:id"], "livePull": true,
            "since": "2026-10-10T10:12:03.000Z", "previous": "1.3.2" },
  "shop": { "state": "stopped", "version": "4", "mount": "/shop", "aliases": [], "livePull": false,
            "since": "2026-10-10T11:02:40.000Z", "previous": null },
  "docs": { "state": "failed", "version": "2", "error": "zone \"docs\" 2 was not built for Zones (…)" },
  "wiki": { "state": "available", "versions": ["1", "2"] }
}
```

| `state` | |
|---|---|
| `serving` | Its URLs are served. `since`: when it last started serving; `previous`: the version installed before, a rollback's target |
| `stopped` | Its URLs answer 404; it stays installed. `since`: when it stopped |
| `failed` | It failed to install at boot, with the reason; Zones serves the rest |
| `available` | Images in the store, never installed in this process |

### Stop and resume, measured

Node 24.16, Apple M1, measured 2026-10-10 with `node tools/bench/stop.mjs` against the test workspace's Zones (the
shell, blog, shop and wiki serving; blog stopped and resumed 200 times after 20), on a machine busy with other work
(load average 65 to 100). The reference is an install's switch, measured the same way at the same time (40 installs
alternating two versions already loaded):

| The switch | p50 | p99 |
|---|---|---|
| Stop | 4 µs | 10 µs |
| Resume | 5 µs | 91 µs |
| An install (the reference) | 9.7 µs | 16.9 µs |

**What a stopped zone costs every other request.** While a zone is stopped, Zones asks each request's path whether a
stopped zone owns it (`node tools/bench/stopped-lookup.mjs`, median of 15 batches of 100 000 calls, three aliases per
stopped zone):

| Stopped zones | Per request |
|---|---|
| 0 | about 5 ns (nothing is asked) |
| 1 | 35 to 45 ns |
| 10 | 45 to 80 ns |

The path's first segment is walked in a trie by character code, so a path no stopped zone owns usually stops at its
first character. Matching every alias's pattern instead, the first version, cost 367 ns with one zone stopped and
2.7 µs with ten. What remains is a map lookup per character of the first segment and the alias patterns of a segment
that does match.

## Rolling deploys

A live install changes a zone inside one process. A deploy of a new image replaces the process, and two things make
that invisible to users: a proxy in front of more than one Zones for the time of the swap, and a stop that drains.

- **A stop drains.** On `SIGTERM` or `SIGINT`, `next-zones serve` (and `start`) stops taking connections, answers the
  requests it has with `Connection: close`, answers `<base>/health` with 503, ends the open tabs' event streams with
  `retry: 1000`, then exits 0. `--drain-timeout <ms>` (`NEXT_ZONES_DRAIN_TIMEOUT_MS`, 25 000 by default) bounds the
  wait; requests still running then have their connections closed. Give the supervisor a longer grace than that
  (compose: `stop_grace_period: 30s`), or it kills the process mid-drain. From code: `await zones.drain({ timeoutMs })`.
- **It leaves after the proxy has stopped sending.** In a container, the exit takes the address away with it: a
  connection opened to it after that is not refused but lost, until the proxy's connect timeout. `--drain-linger <ms>`
  (`NEXT_ZONES_DRAIN_LINGER_MS`) keeps the process refusing connections that long after the drain, so a proxy that
  marks a server down on one refusal (nginx: `max_fails=1 fail_timeout=10s`) has stopped using it before it goes; a
  short connect timeout (nginx: `proxy_connect_timeout 1s`) bounds what is left.
- **The proxy retries what is safe.** A connection the leaving process refuses was never sent, so a proxy may send any
  request to the other process; a request that failed after it was sent is retried only when it is idempotent. nginx:
  the processes as servers of one `upstream`, `proxy_next_upstream error timeout http_502 http_503` (nginx never sends
  a POST twice unless told `non_idempotent`).
- **Two versions serve for a moment.** While the old process drains and the new one serves, a page from one may ask the
  other for a chunk it does not have. Let the proxy try the other process on a 404 under `/_next/static/`.
- **Open tabs follow.** Each events stream begins with `event: hello` and an opaque value naming the shell's build and
  each zone's version and build. `<ZoneUpdates />` keeps the first, and when a reconnection brings another one (the
  new process serves something else) it refreshes as on a swap; the same image again changes nothing.
- **What is not shared.** Two Zones processes share nothing at run time: each has its store (with its `state.json`,
  the live installs since boot), its cache directory and its pid file. Give each its own; a store shared by two would
  have both write `state.json`. A version installed live on one is not on the other: install it on each, or deploy it
  in the image.

## What a user notices

- **Nothing reloads.** `<Link>` between zones' App Router pages is soft, and client state is kept. A zone's Pages
  Router pages load in documents of their own ([Zones on the Pages Router](pages-router.md)).
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
`error`, `not-found`, and the zone's own [not-found page](concepts.md#not-found) for a URL under its mount that
nothing serves), route handlers and metadata routes, server actions, prerendering, ISR and
`generateStaticParams`, revalidation across zones, `next/font`, `next/image`, [public files](assets.md), the shell's
`proxy.ts`, the zone's [routing rules](routing-rules.md), [aliases](aliases.md), [instrumentation](instrumentation.md).
And the [Pages Router](pages-router.md): static pages, `getStaticProps`, `getServerSideProps`, its own `_app` and
`_document`.

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
  300 MB image pulls in about 0.4 s at 155 MB peak RSS as `.tgz`, 0.6 s at 210 MB as `.zip` (see
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

| Image | Format | Peak RSS | Time |
|---|---|---|---|
| 300 MB (176 MB packed) | `.tgz` | 155 MB | 0.4 s |
| 300 MB | `.zip` (`--format zip`) | 210 MB | 0.6 s |
| 600 MB | `.tgz` | 167 MB | 0.8 s |

Measured 2026-10-09. The 12 MB between 300 and 600 MB is garbage not yet collected, not the image: memory stays flat
as images grow. The reader before streaming held the whole image in memory: 756 MB peak and 7.0 s for the 300 MB
image, on the same machine when it was replaced.

## Supported Next versions

Zones works on Next's internals, so it runs only on the Next versions next-zones has been checked against (today
16.3.6, 16.3.7, 16.3.8 and 16.4.0; 16.3.8 fixes security issues in Next, among them SSRF in the image optimizer and
cache poisoning: use 16.3.8 or 16.4.0). On any other version, or on a Next where a module or function it hooks has moved, `createZones` throws before
anything is hooked, and lists every difference. That check is Zones' (mode `"zones"`); `next-zones build`, `dev`
and mode `"single"` run Next itself, with no hook. They check nothing more than the package manager does with the
peer range (`next` 16.3.6, 16.3.7, 16.3.8 or 16.4.0), which warns on another version; use one of those, since what
they build is what Zones runs:

```
next-zones: this Next does not match what Zones relies on (next 16.5.0):
  - Next 16.5.0 has not been checked with next-zones (checked: 16.3.6, 16.3.7, 16.3.8, 16.4.0); run tools/upgrade-guard.mjs 16.5.0, …
```

`createZones({ unsupportedNext: true })` runs anyway. It is meant for the upgrade guard, which runs the whole check
suite on the new version before it is added.

