# @runsnip/next-zones

Zones for Next.js, without Next's Multi-Zones limits.

Next's Multi-Zones serve one domain from several Next apps. Each zone is a separate server, and moving between
zones is a hard navigation: the page reloads and client state is lost. Links across zones must be plain `<a>`
tags, and shared code must be published as packages. This project removes those limits:

- **Composer (build time).** You register zones with a config function. Each zone is a package with its own `app/`
  tree, its own version and a mount path. The main app is the primary zone: it keeps the root layout, the client
  state and the proxy. The composer checks the routes with Next's own route discovery, then emits **one standard
  Next app**: one process, soft navigation between zones, and each zone still released under its own version.
- **Zones (run time).** A zone built separately, against the same Next and React versions, is registered into a
  **running** server without a restart. This works because App Router navigation is server-driven: the client asks
  the server for the next URL's RSC payload, and each route's client reference manifest names its chunks by URL.
  The client never needs a route list at build time.

## Status

Pre-release. The risky claims were measured first, in `spikes/`, and Zones is now the package's `createZones`:

1. **Zones.** Register a separately built route in a running `next start` (16.3.6). Measure:
   - Is it served without a restart?
   - Does a page of the main app reach it with a soft navigation?
   - Is there exactly one React?
2. **Composer.** Compose two zones and a shell into one standard build, with route conflicts refused. Done for
   `next-zones dev` and for `mode: "single"` (`next-zones build`, `spikes/zones/single.mjs`).

Each spike ends with its numbers and a verdict: it works, or exactly where in Next it stops.

**The package (pre-release).**
- **Exports:** `@runsnip/next-zones/config` (`zoneConfig`), `/client` (`<ZoneUpdates />`), `/Zones` (`createZones`),
  `/build` (`buildZone`), each with its type declarations; and `/tsconfig/zone.json`, which every zone's tsconfig
  extends.
- **CLI:** `next-zones init | add | check | doctor | dev | build | start | serve | install | pack | pull | prune | watch`.
- **Zones keeps the active versions** in the store's `state.json` across restarts. Its admin endpoints need a
  token, or a local request.
- **Usage:** [`docs/`](docs/README.md).

**Zones: it works** ([spikes/zones/RESULTS.md](spikes/zones/RESULTS.md)). On Next 16.3.6, Node 24.18.0, Apple M1 Pro:
- **Live installs.** A zone is installed into a running server, with no restart.
  - The switch takes **3.0–3.2 µs p50** (8.8–10.2 µs p95), with a 29-route zone in an app of 248 routes (75 of them
    dynamic). It is atomic.
  - Under load (32 concurrent clients, 18 swaps), no answer was wrong.
- **Navigation.** `<Link>` is soft between any zones, client state is kept, and there is one React.
  - An open tab sees a swapped version at once (`<ZoneUpdates />`).
- **Modules.** A module shared by the shell and the zones runs once, on the server and in the browser.
  - Concurrent renders across zones are safe.
  - A zone's externals resolve from the shell's `node_modules`, wherever its build is stored.
- **What a zone can use:** routing, route handlers, metadata routes, server actions, prerendering, ISR and
  `generateStaticParams`, revalidation across zones, the shell's proxy, its own `headers`/`redirects`/`rewrites`,
  intercepting routes, fonts, images and `public/` files.
- **Memory.** Two real apps and their shell on one Zones: **291.6 MB RSS**, against 500.3 MB for three `next start`,
  with the same latency (p50 3.6–4.2 ms against 3.4–4.4 ms).
- **Next's internals, checked.** Zones runs only on the Next versions the whole suite has passed on (16.3.6, 16.3.7, 16.3.8, 16.4.0). Before
  anything is hooked, it checks every module and function it relies on, and hooks each module by its file, whatever
  path Next requires it by; otherwise it refuses to start and lists what moved (`contract.mjs`).
- **Next's options are never changed.** `zoneConfig` passes a zone's Next config through as it is. Only in a build for
  Zones does it fill in, where unset, the three Turbopack options separately built zones need (scope hoisting, unused
  exports and imports removal off); a config that sets them otherwise stops that build with the reason. JS grows by
  2–9% ([docs](docs/configuration.md#build-options-for-zones), debt D8).
- **Declaring a zone.** It declares itself with `zoneConfig({ mount, aliases })`.
  - `next-zones check` validates a workspace.
  - Overlaps, mismatched Next or React versions, and URL-shaping config that differs from the shell's are refused at
    install.
- **Instrumentation.** The shell's covers every zone, and each zone's own covers its routes, under a policy.
- **Tests.**
  - `npm test`: 49 unit tests of the pure parts (module identity, `zoneConfig`, declarations, build digests, the
    Next contract, the composer's alias loader, zone image packing), under a second.
  - `npm run test:zones`: the 45 browser and HTTP checks of `spikes/zones`, each on a fresh Zones service. The builds must exist
    (`spikes/zones/build-zone.sh`).
  - `npm run test:upgrade <next version>`: all of it on another Next, installed from scratch (the upgrade guard).

What is supported, area by area, and how: [`SUPPORT.md`](SUPPORT.md).

**Documentation for users of next-zones:** [`docs/`](docs/README.md).

**Behaviours that look like gaps but are Next's** (compared with a zone running alone with `next start`), kept to
see later whether next-zones should improve on them: [`SUPPORT.md`](SUPPORT.md#behaviours-that-are-nexts-compared-with-the-zone-alone).

**Tools for developing next-zones** (building zone images into a store, the activation and latency benchmarks):
[`tools/`](tools/README.md).
- Navigation from the shell into the zone is soft, and the shell's client state is kept.
- There is one React.
- An open tab sees a v1 → v2 swap on its next navigation.

## Debt ledger

The ledger holds only what **cannot be solved for good** with what Next, Turbopack or the platform offer today
(the bottleneck is upstream, or inherent), **and does not affect a release**: a workaround is in place and checked.
Anything next-zones can solve itself is work, and lives in the roadmap; anything that affects a release is fixed before
it. Each entry states:
- its status: why it is accepted, how it is checked, and what it waits on;
- what it costs today, with the measurement it comes from;
- the bottleneck that stops the thorough fix;
- the thorough fix, and what should bring us back to it.

An entry leaves the ledger when its bottleneck is gone and it is fixed, or when it is proven that it cannot go lower.
Either way it leaves with numbers.

| # | Area | Status | Cost today | Bottleneck | Thorough fix | Come back when | Evidence |
|---|---|---|---|---|---|---|---|
| D8 | Zones: build options turned off | Accepted: documented; filled in only by `next-zones build`, never over a zone's own value; Zones and the links refuse a build without them. Waits on Turbopack (keeping a shared package whole while trimming the rest) | In `next-zones build` (both modes), `turbopackScopeHoisting`, `turbopackRemoveUnusedExports` and `turbopackRemoveUnusedImports` are `false`. Measured: scope hoisting off, server JS of the test shell +16% (520 → 604 KB); unused exports kept, on two real apps client JS +1.9% and +3.4%, server JS +8.6% and +4.4% | A hoisted factory writes other modules' exports; a trimmed module differs per build (it keeps only what that build uses), so a library's context loads twice | Zones are released on their own, so no build can know what a later one will use from a shared library: a union of exports decided at build time does not hold. Upstream, a per-package switch (packages shared across builds kept whole and unhoisted, the app's own code trimmed), then turn the options back on for the rest | When bundle size or cold start matters (serverless, many zones) | [RESULTS.md, One module](spikes/zones/RESULTS.md#one-module-loaded-once), [A library's context across builds](spikes/zones/RESULTS.md#a-librarys-context-across-builds) |
| D9 | Zones: a shared module stays on its first build | Accepted, inherent: a live instance cannot move to another build; its disk cache is collected (D5) | A module the registry shares lives in the runtime of the build that first ran it, so that build's code stays loaded while any version shares the module (its disk cache is collected). In steady state, one pinned build per zone image that introduced still-shared modules | A live module instance cannot move to another build's runtime | None within a process; a restart reloads everything from the active versions only | If heap grows with pinned builds on the VPS (D14 measures it) | [RESULTS.md, One module](spikes/zones/RESULTS.md#one-module-loaded-once) |
| D10 | Zones: versioned build path | Accepted, checked by every test. Waits on Turbopack (a module id salt) | Each version builds from `<zone>@<version>` (`tools/build-zone.mjs`) so its module ids are its own. This relies on Turbopack deriving ids from the path | Turbopack has no id salt (`turbopackModuleIds` is only `named` or `deterministic`) | A per-zone id salt upstream in Turbopack; until then `next-zones build` owns the build path | When Turbopack changes how ids are derived, or upstream accepts a salt | [RESULTS.md, One module](spikes/zones/RESULTS.md#one-module-loaded-once) |
| D12 | Zones: a zone's main chunk | Accepted, checked by every test. Waits on Turbopack (per-route chunk lists) | The modules a zone's root main chunks hold and the shell's lack go into one synthesized chunk, built by running the zone's chunks in a sandbox. Dependencies are followed through each module's requires, from its parse | A build's main chunks load only with its own documents | Zones are released on their own, so a zone cannot be built against a later shell's entry. Upstream, per-route chunk lists that include what a route needs from the entry | When a zone's main modules need more than the shell's, or when Turbopack's chunk format changes | [RESULTS.md, A zone's main chunks](spikes/zones/RESULTS.md#a-zones-main-chunks-and-its-client-runtime) |


**Settled** (left the ledger with numbers):
- **D3, the LRU generations' memory.** Each of Next's LRUs, as Zones keeps them (`src/zones/kept-lru.cjs`), remembers
  one generation number per entry it holds, kept in step with the cache: so it is bounded by the LRU's own bound. One
  leak was found and fixed: an entry Next's LRU refuses (larger than its bound) left its generation behind
  (`test/kept-lru.test.mjs` fails on the old order). Under 10 rounds of 1000 distinct missing URLs across two zones and
  the root, each followed by a swap (`lrumem.mjs`): every LRU's generations equal its entries, the miss cache held
  10002 entries in 1.4 MB of its 8 MB bound, and the heap after a full collection did not grow (34.5 → 32.7 MB).
  To confirm under real traffic on the VPS.
- **D14, RSS across many versions.** The heap a full collection kept was not the versions' code (collected versions
  are unloaded: only Node's path caches still name them, about 20 KB a version) but V8's compilation cache, which keeps
  the scripts of every chunk ever loaded, and the heap's pages, grown to an install's peak. No ordinary collection hands
  them back; V8's last-resort collection (the one a heap snapshot runs) does, in 27–75 ms. Zones runs it once idle
  after a version is collected (`src/zones/reclaim.cjs`; `createZones({ reclaim })`). 120 versions of the test blog
  installed and collected one after another (M1, Node 24): RSS 161 → 337 MB before, 127 → 117 MB with reclaim; the
  heap 38 → 270 MB before, 40 → 52 MB with it. `reclaim.mjs`. To confirm on the VPS when Zones serves there.
- **D11, the client runtime.** A document has one Turbopack runtime, the shell's, and each build's is trimmed to what
  it uses. Both sides are now exact: the shell's module context is read from its runtime itself, run in a sandbox with
  one probe module that records the context it is handed, and a zone's uses (calls and reads) come from each module's
  parse. In Next 16.3.6's browser runtime one feature is per build, async-module support (`a`; the source in Next's
  binary lists every other method as always there, or Node only). `@runsnip/next-zones/client`, which the shell imports
  for `<ZoneUpdates />`, holds an `import()` that never runs of a module with a top-level await, so the shell's runtime
  has it: its other chunks are byte for byte the same (same content hashes), the runtime grows by 1225 bytes (450
  gzipped), and the extra chunk is never loaded. `features.mjs`: a blog client module with a top-level await, refused
  on the shell built without it ("lacks (a)"), served in the browser with it. A shell that does not import the client
  still gets the exact refusal, naming the fix.
- **D7, the build-id rewrite.** A zone's prerendered payloads get the shell's build id row by row, as React's flight
  client reads them (`src/zones/payload.cjs`): a text row's byte length is written again, binary rows are passed
  through, and inline flight data in HTML is joined across its `__next_f` chunks, edited and put back in them. So build
  ids of any length work (a `generateBuildId` returning a git SHA): the length check is gone. Proved with React's own
  client reading the result (`test/payload.test.mjs`; the old plain replace fails there with "Connection closed"), and
  end to end with a 40-character blog id in one app, standalone and export (`single.mjs`, `singleexport.mjs`), and
  a 40-character id shared by both shop versions under Zones (every check). What next-zones names after a build (its
  renamed chunks, remapped ids, main chunk, caches) now uses a build key (zone, version, build id, digest), since two
  builds may share a build id. Cost (`tools/bench/payload.mjs`, M1, p50): 67 real prerendered files of the test blog
  (371 KB), 1.26 ms against 0.82 ms for the plain replace, once per install, in a worker; a 1 MB RSC payload 1.3 ms
  against 1.8 ms; a 1 MB page 4.0 ms against 1.8 ms. **What is left** on a page is decoding and encoding its inline
  chunks (about 2 ms per MB): a row whose content changes must be decoded, as React counts its length in decoded bytes.
  Come back if seeding many large pages shows in install time: edit in the escaped text with a map to decoded offsets.
- **D1, `prepare` grows with the app.** The dynamic route lists are no longer sorted again on each install: the zone's
  routes are sorted alone (Next's `getSortedRoutes`, which also checks them) and merged into the rest, already in
  Next's order, by a comparator (`src/zones/route-order.cjs`) checked equal to `getSortedRoutes` on generated route
  sets (`test/route-order.test.mjs`); a list found out of order falls back to a full sort. The manifest and
  `appPathRoutes` are copied in one pass, without `delete`. `prepare`, p50 over 300 swaps
  (`tools/bench/activation.mjs`, M1): 248 routes 554 → 355 µs; 2036 routes 3150 → 1075 µs, of which the two
  sorts went from 1717 to 164 µs. **What is left** is the two object copies (about 300 µs each at 2036 routes): Next's
  server reads plain objects, and an atomic switch replaces them whole; a Proxy over a shared base would avoid the copy
  but add a cost to every request's lookup.
- **D6, a shell with its own `cacheHandler`.** Zones wraps it (`src/zones/zones-cache-handler.cjs`): a zone's pages and
  route handlers (keys under its mount) go to Zones' per-version cache, every other key (the shell's pages, fetch and
  `unstable_cache` data) to the shell's handler, and a revalidation reaches both. `ownhandler.mjs`.
- **D15, client module identity by a tokenizer.** Client modules are now read with a parser (Next's acorn,
  `src/zones/module-code.cjs`): identity is alpha-equivalence over a scope analysis (bindings, hoisting, blocks, Annex
  B functions, labels, private names; `with` and direct `eval` keep their names), and requires are calls on the
  factory's own context with a numeric id, found and remapped by position. The tokenizer took `top` and `foo`, or
  `o.f(3)` and `o.f(4)` on a local, for the same code, and a long local name for a different one. On a real app
  (797 client modules against a shell of 373): 17 conflicting modules instead of 68, 7 chunks rewritten instead of
  21; every remaining conflict is a real difference or an importer of one. The analysis takes 0.85 s cold against
  0.39 s, and 0.16 s once its module reads are cached on disk (a zone's next version shares most modules), in a
  worker (`tools/bench/identity.mjs`).
- **D2, `stage` on the event loop.** `next-zones build` writes what Zones needs into `zone.json`
  (`src/zones/describe.cjs`), so a stage reads that one file, asynchronously. Its work on the main thread went from
  3.7–8.9 ms to 0.15–1.55 ms (8 installs of the test blog). The build's integrity is checked in a worker: about
  270 ms the first time a build is installed (663 files), then remembered. The event loop was held at most 0–2.9 ms
  per install. `integrity.mjs`: a build changed after it was stored is refused.
- **D5, zone image caches.** `collect()` removes a collected version's disk cache (seeded pages, ISR writes, client
  analysis), even when its code stays pinned (D9), and never a kept version's (`collect.mjs`: v1's 3 cache folders
  removed, v2's 4 untouched, and a rollback to v1 installs it again). `keep: 0` kept every version (`slice(-0)`):
  fixed.
- **D13, `'use cache'`, Cache Components / PPR.** Proved on a `cacheComponents` shell and zone (`cc.mjs`): the cached
  value from the build is served while the dynamic hole follows each request, `revalidateTag` renews it on the next
  read, and a soft navigation renders both. A zone whose `cacheComponents` differs from the shell's is refused.
- **D4, open tabs after a swap.** `<ZoneUpdates />` refreshes the router on Zones' swap event (`signal.mjs`). A
  cached static page shows the new version on the next soft navigation, in the same document.

**Floor reached:**
- The switch takes 3.0–3.2 µs p50, from 1264 µs in v0. It assigns what `prepare` built, and bumps one generation per
  first path segment of the zone (cached misses are dropped lazily).
- Nothing in it grows with the app, and nothing with the zone's routes.
- Every phase is under 1 µs, so most of what remains is the cost of timing the phases (`performance.now()` per phase).
  Its p95 (8.8–10.2 µs) and max are GC and JIT pauses.

## License

Apache-2.0 — see `LICENSE` and `NOTICE`.
