# Spike: a zone loaded into a running Next server

**Verdict: it works.** A zone built on its own was registered into a running Next 16.3.6 production server, with no
restart. It was then served, reached from the shell with a **soft navigation** that kept the shell's client state,
and swapped from v1 to v2 and back while a tab stayed open.

Setup:
- Next 16.3.6 (Turbopack build), React 19.3.0, Node 24.18.0, Apple M1 Pro.
- `shell/` and the test zones in `fixtures/` (`blog`, `shop`; test apps) are separate Next projects in one npm workspace, so they share
  one `node_modules`.
- `shared/` (`@spike/shared`) is a package that the shell and every zone import.
- The shell is built with `next build`.
- A zone image is built with `./build-zone.sh <zone> <version>` into the zone store, `.zones-store/<zone>/<version>/`.
  `blog` versions 1 and 2 come from one source, with `ZONE_VERSION` (and a route only v2 has, `page.v2.tsx`).
- `zones.cjs` serves the shell from a programmatic `next()` server, with four load-time hooks (below).
- Browser checks use Playwright (Chromium).

## Measured

| Check | Result |
|---|---|
| `/blog` before the zone is installed | 404 |
| Installing the zone (`POST /_next-zones/install`) | **the switch takes 3.0–3.2 µs p50** (8.8–10.2 µs p95) at 248 routes (75 dynamic), with a 29-route zone, with dynamic routes, server actions, prerendered pages and the mount checks; no restart. See [Activation](#activation-v0--v1). The first spike's v0 took 0.7–1.3 ms |
| `/blog` after installing | 200, rendered from the zone's own build (its files stay outside the shell's `.next`) |
| Shared client modules in the two independent builds (Next's runtime) | **8 of 8 have the same id**: Turbopack ids are derived from the module's path |
| The zone's own client module | its own id, chunks named by URL |
| From the shell's page, `<Link href="/blog">` | **soft navigation**: same document (a `window` marker survived), the shell's counter kept `clicked 2` |
| The zone's client component (`useState`) in the shell's tree | works, no errors: one React on the client |
| Swap v1 → v2 on the server | **3.0–3.2 µs p50** for the switch (measured over 300 alternating v1/v2 swaps), atomic; the next request serves v2 |
| An open tab, after the swap | its next soft navigation to `/blog` shows **v2**, with no refresh and the same document |
| Roll back v2 → v1 | immediate; 0 errors in the server log |
| Memory (RSS after 20 requests each) | shell alone, `next start`: **105 MB**; zone alone, `next start`: **105 MB**; Zones serving shell + zone: **107 MB** |

**The memory row is the case against Next's Multi-Zones on a small server.** Each extra zone is another Next server,
about 105 MB of baseline here. In Zones, an installed zone cost about 2 MB. These are tiny apps; real ones add
their own heap on top in both setups.

## How (the four places Next 16.3.6 caches "what a URL is")

1. **`server/load-manifest.external`**
   - `loadManifest` gives back `app-paths-manifest.json` with the zones' pages overlaid, as **absolute paths** into
     each zone's build. `require.js` `getMaybePagePath` already accepts absolute paths ("built-in components").
   - The overlaid object keeps its identity until a zone changes. The route matcher compares manifests with `===`,
     so it rebuilds only then.
   - `loadManifestFromRelativePath` reads a zone route's **own** manifests (its client reference manifest, its
     react-loadable manifest) from the zone's build. The shared ones (routes, build, fonts, server actions) stay the
     shell's.
2. **`server/lib/router-utils/filesystem` (`setupFsCheck`)**
   - The router server's fs check is kept, and the zone's routes are added to its `appFiles` Set.
   - `dynamicRoutes` is a mutable array, ready for dynamic routes. This spike used a static route only.
3. **`server/lib/lru-cache`**
   - Every LRU is kept, so the fs check's and `require.js`'s **cached misses** can be dropped when a zone is
     installed.
   - Without this, a URL requested before the install would stay a 404.
4. **`NextNodeServer`**
   - Its instance is kept (through `getRouteMatchers`).
   - On install, Zones rebuilds `appPathsManifest` and `appPathRoutes`, then calls the public `reloadMatchers()`.

A zone's client chunks are served by Zones, from the zone's own `static/`, before Next sees the request. The
router server's `/_next/static` list is built at startup and is not reachable from outside.

## What the spike showed has to be right

- **A zone must be built on the shell's root layout.**
  - Here the zone's `app/layout.tsx` re-exports the shell's, so the module is the same and so are its ids.
  - With a layout of its own, a direct load of `/blog` rendered without the shell's chrome. Soft navigation still
    kept the shell's layout, so a direct load and a soft navigation would disagree.
  - The composer, or a `next-zones build`, must give every zone the shell's layouts.
- **Same Next, same React, same `node_modules` layout** across the shell and its zones. That is the contract that
  makes shared module ids match. Zones must check it when a zone is installed.

## Activation: v0 → v1

v0 rebuilt everything on each install: the whole manifest overlay, `appPathRoutes`, every route matcher (through
`reloadMatchers()`), and a scan of every key of every kept LRU. Every phase grew with the whole app, and the
switch awaited in between, so a request could land on a half-installed state.

v1 splits an install in two:
- **`prepare`** builds, from the current state, everything that grows with the app:
  - the zone's matchers, with Next's own `AppPageRouteMatcherProvider.transform` on the zone's pages only;
  - the new static and dynamic matcher lists, with dynamic ones sorted by Next's `getSortedRoutes`;
  - the new `appPathRoutes`.

  It runs before the switch and is redone if another activation happened in the meantime.
- **The switch** is synchronous, with no `await`, so no request ever sees half of it. It:
  - assigns what was prepared;
  - changes the overlay in place (the old version's pages out, the new one's in);
  - adds and removes the zone's routes in `fsChecker.appFiles`;
  - drops cached misses only under the zone's first path segments. Every kept LRU indexes its keys by first segment,
    and eviction keeps that index exact.

**Method.**
- `POST /_next-zones/bench?strategy=…&runs=300&pad=212&dynamic=75&lru=2000`: an app of 216 routes with 75
  dynamic, and 2000 cached misses refilled before each run.
- The runs alternate the v1 and v2 builds of `blog`. Each strategy runs in a fresh Zones process.
- Apple M1 Pro, Node 24.18.0, Next 16.3.6. Results in µs.

| phase | v0 p50 | v0 p95 | v1 p50 | v1 p95 |
|---|---|---|---|---|
| overlay | 37.1 | 62.4 | 0.8 | 2.7 |
| appPathRoutes | 84.7 | 151 | (in prepare) | |
| matchers | 722.5 | 1123.1 | 0.3 | 1.0 |
| fsCheck | 0.3 | 1.5 | 0.5 | 2.3 |
| lru | 405.1 | 591.9 | 1.6 | 8.5 |
| **switch (activate)** | **1264.2** | **3007.5** | **4.0** | **20.9** |
| prepare (before the switch) | — | — | 142 | 291.7 |

- **The switch is about 300× faster (p50) and now atomic.**
- Behaviour is unchanged:
  - `browse.mjs`: soft navigation, the shell's state kept, one React, 0 errors;
  - `swap.mjs`: v1 → v2 seen by an open tab, in the same document.
- A first install end to end, `stage` included, took 0.68 ms then: stage 0.51, prepare 0.24, switch 0.16.

**After the features below** (the router server's dynamic routes, merged server actions, prerendered pages) were
added to the switch, the same bench was run again. This time the padding's 75 dynamic routes were also in the router
server's list, as Next builds it from `routes-manifest`:

| phase | p50 | p95 |
|---|---|---|
| prepare (before the switch) | 260 | 588.3 |
| **switch (activate)** | **9.2** | **31.6** |

Later measurements:
- After the module registry and the mount checks, the switch took 10.2 µs p50 (30.8 µs p95), and `prepare` took 253
  / 568 µs.
- After route handlers, metadata routes and aliases, with the blog zone then at 9 routes, two runs gave:
  - the switch: **12.6 µs p50** (32.5–41.5 µs p95);
  - `prepare`: 420–436 / 1147–1385 µs.
- What the switch still does grows with the zone's own routes, never with the app:
  - assigning what `prepare` built, the overlay among it, copied on write;
  - the zone's `appFiles` entries;
  - its cached misses.

  The alias table and the overlay copy moved from the switch to `prepare` in this round. With them in the switch, it
  took 24.5 µs.

A first install of a new zone image also seeds its prerendered pages (a copy, plus the build-id rewrite, below).
It took 16.5 ms here, once per version, off the switch.

## Beyond a static page

Checked in a browser (`features.mjs`, `bound.mjs`) and with `curl`, after an install with no restart. All of it
passed with 0 console errors.

| Feature | What it needed | Result |
|---|---|---|
| Dynamic route `/blog/[id]` | The router server's dynamic list (`fsChecker.dynamicRoutes`) comes from `routes-manifest`, read at startup. The zone's entries are added, kept in `getSortedRoutes` order, and swapped in by the switch | Direct load 200 and soft navigation. Removed by a swap to a version without it (404), back on rollback (200) |
| The zone's CSS module | nothing: its chunk is named in the route's client reference manifest | Applied on a soft navigation and on a direct load |
| A server action of the zone | `server-reference-manifest.json` is shared, so read from the shell. Every zone's `node`/`edge` entries are merged into it; action ids are content hashes | `shout()` answered from the zone |
| An inline action closing over a value | Bound arguments are encrypted with the manifest's `encryptionKey`. The builds have different keys, but at run time one key is used (the merged manifest's, the shell's) both to encrypt and to decrypt | `remembered 42` |
| A prerendered page `/blog` | Without a fix it was rendered on every request with `Cache-Control: no-store`, because the shell's `prerender-manifest` does not know it. Three changes, below | `x-nextjs-cache: HIT`, `s-maxage=31536000`, from the first request |
| ISR, `revalidate = 1` | as above | HIT, then STALE (served while regenerating), then HIT with the new time. Written to the zone image's cache; the zone's build and the shell's `.next` are untouched |

**Prerendered pages: the three changes.**
1. **`prerender-manifest` overlay.** Through both loaders (`loadManifest` for the server, `loadManifestFromRelativePath`
   for route modules), the zone's routes are merged in, memoized per set of zones.
2. **A writable cache per zone image.**
   - At stage, the zone's prerendered outputs (`.html`, `.rsc`, `.meta`, `.body`, segments) are copied into
     `.zones-cache/<zone>/<zone build id>--<shell build id>/`.
   - The zone's build is never written. A new version starts from its own prerender, and ISR writes go to that
     version's copy.
   - **Why a `cacheHandler`:** the page runtime is bundled (`app-page-turbo.runtime.prod.js`) and carries its own
     `FileSystemCache` and `fs`, so a patch to `dist` does not reach it. Zones therefore sets Next's public
     `cacheHandler` option to Next's own `dist` `FileSystemCache`, whose `getFilePath` sends a zone's keys to its
     version's cache.
   - A shell with a `cacheHandler` of its own is refused for now.
3. **The build id.**
   - A prerendered payload carries the build id of the build that made it. The client router does a hard
     navigation when it differs from the page's own (deployment skew).
   - With the zone's id, the soft navigation into `/blog` became hard, and the shell's state was lost.
   - The seeded copies have the zone's id replaced by the shell's. Both are 21-character nanoids, so RSC length
     prefixes stay right, and a different length is refused.
   - The cache key includes both build ids, so a shell deploy re-seeds.

**A behaviour to know.** After a swap, an open tab can keep showing the old version of a **static** page on a soft
navigation. Next's client router keeps a static route's payload for its stale time (`x-nextjs-stale-time: 300`), until
that time passes or `router.refresh()` is called. Dynamic routes are fresh at once. A swap that open tabs must see at
once needs a signal from Zones to them (ledger D4).


## One module, loaded once

The shell and two zones (`blog`, `shop`) import one package (`@spike/shared`). It has a server module that counts
its evaluations process-wide, and a client component that counts its evaluations in the browser (`shared.mjs`).

**Before.**
- **Server:** the shared module ran **3 times**, once per build. Each build's `[turbopack]_runtime.js` keeps its own
  `moduleCache`, so every singleton (a DB pool, a cache) existed once per zone.
- **Client:** it ran once, and no JS file was fetched twice. The browser has one Turbopack runtime, and shared modules
  have the same id and chunk URL in every build.
- **A bug the measurement found.** After a swap from v1 to v2, an open tab rendered v2's server output with **v1's
  client component** ("zone blog v2" over "editor v1").
  - Module ids are derived from the path, so v1's and v2's editor share one.
  - The browser runtime never replaces a factory it already has.

**What changed.**
1. **One module registry for every server runtime.**
   - Zones rewrites one line of each `[turbopack]_runtime.js` as it is compiled, and refuses a runtime whose layout
     it does not recognise. Each runtime's `moduleCache` becomes a view on a process-wide registry, keyed by module id
     **and the sha1 of the factory's source**.
   - A module is shared only when it is byte-identical, so v1 and v2 of a zone never mix.
2. **Turbopack scope hoisting off** (`experimental.turbopackScopeHoisting: false`) for the shell and the zones.
   - **Why:** hoisting merges modules into one factory, and that factory defines the other modules' exports
     (`esmExport` with an id). A shared module was then written into after another build had sealed its exports:
     `TypeError: Cannot define property …, object is not extensible`.
   - Next's own prebuilt modules still do this in 18 places. Any module whose exports another factory defines is
     never shared, and a runtime that borrowed one swaps in its own before it is written.
3. **A zone image is built from its own path**, `fixtures/<zone>@<version>` (`build-zone.sh`).
   - The zone's own modules get ids of their own per version, so an open tab loads v2's client code.
   - Shared modules keep their paths, so their ids, and stay loaded once.

**After.**

| | Before | After |
|---|---|---|
| The shared server module, across the shell, blog and shop | 3 evaluations | **1** (registry: 506 modules, 45 shared hits) |
| The shared client module | 1 | 1 |
| JS fetched twice, or the same content under two names | 0 | 0 |
| An open tab's client code after a v1 → v2 swap | **v1** | **v2**, same document, state kept |

**What it costs.**
- **Request latency:** sequential, 2000 requests per page after 200 warm-up, two runs each way.
  - p50 was 3.1–3.9 ms with the registry on and with it off. The difference is inside the noise.
  - `NEXT_ZONES_REGISTRY=off` turns the registry off for this comparison.
- **Bundle size, scope hoisting off (shell):**
  - client JS is unchanged: 589,902 bytes, and 176,314 gzipped against 176,306 with hoisting on;
  - server JS grows 16%, from 520,125 to 603,839 bytes.

## The URL segment a zone owns

- **The declaration.** A zone declares its segment in `package.json`, for example `"nextZones": { "mount": "/blog" }`.
  `build-zone.sh` writes it into the store as `zone.json`, with the zone's name and version.
- **The checks.** At install, Zones refuses, with a 409 and nothing changed:
  - a mount that is not one segment;
  - a route of the zone outside its mount;
  - a mount that another zone already owns;
  - a mount the shell already serves;
  - a store folder that is not a zone build.
- **Each refusal was triggered once:**
  - `blog-copy` claiming `/blog`: "`/blog already belongs to zone "blog"`";
  - `shop` claiming `/files`: "`owns /files, but has routes outside it: /shop`";
  - a zone claiming the shell's `/about`: "`/about is the shell's`", after which the shell's `/about` still answers 200;
  - a missing version: "`no zone build`".

## The shell's proxy, and links between zones

**The shell's `proxy.ts` in front of zone routes** (`proxy.mjs`, and `curl`) needed no change in Zones: the
proxy runs in the router before routes resolve.
- A header set by the proxy is read by the zone's pages.
- A sign-in gate on a zone route answers 307 to `/login?next=…`.
  - On a `<Link>`, the navigation stays soft and lands on the shell's `/login`, with the shell's state kept.
  - After the session cookie is set and `router.refresh()` is called (as a real sign-in does), the same `<Link>`
    reaches the zone page. Before the refresh, the router's cached redirect still applies, as in any Next app.
- `/b/7` is rewritten into the zone's `/blog/7`.
- A prerendered zone page still answers `x-nextjs-cache: HIT` behind the proxy.

**A zone's own `proxy.ts` or `instrumentation.ts` is refused at install.** One of each runs per server, the shell's,
so a zone's would silently not run. This was checked against real zone builds that had each file.

**`<Link>` between zones** (`links.mjs`): blog → shop → blog, from links inside each zone's page.
- Both ways are soft, and so is Back.
- The blog editor's text, the shop's list and the shell's counter are all kept.
- There are no errors.

## Instrumentation per zone

`instrumentation.mjs`, using a `register` and an `onRequestError` in the shell and in each zone, and a page that
throws in each of them.

| Policy | Error on | `onRequestError` that ran |
|---|---|---|
| default | `/boom` (shell) | shell |
| default | `/blog/boom` | shell, blog |
| default | `/shop/boom` | shell, shop |
| `shell.skip: ["shop"]`, `own: { blog: false }` | `/blog/boom` | shell |
| same | `/shop/boom` | shop |

- `register()` ran for the shell at boot, for each zone at its install, and again for blog when v2 was installed.
- Each error was reported once.
- **How:** both paths Next uses for `onRequestError` (the route module's, through `instrumentation-globals.external`,
  and the server's) go through one dispatcher. It picks the zone by the error's `routePath`.

## A zone's URL at the root

`alias.mjs`: blog declares `aliases: [{ source: "/post/:id", destination: "/blog/:id" }]`.
- `/post/7` answered 404 before the install and 200 after it, rendered by the zone.
- A `<Link href="/post/7">` from the shell is soft, and the address bar keeps `/post/7`.
- **Refused:** an alias overlapping another zone's alias, one on the shell's `/about`, and one pointing outside the
  zone's mount.
- A swap to a version without the alias removed it (`/s/1`: 200, then 404).
- **Why the alias table is read through one rewrite:** production computes the router's route list once, at the
  first request. So one rewrite is put in `beforeFiles` before that request, and its `match()` reads the current
  alias table, which the switch replaces whole.

## Route handlers and metadata routes

`routes.mjs`. Zones now feeds Next's `AppRouteRouteMatcherProvider` with the zone's routes, as it already fed the
page provider.
- **A dynamic `route.ts`:**
  - `GET /blog/api/hello` returns JSON, with the shell proxy's header;
  - `POST /blog/api/echo` echoes its body;
  - after a swap, v2's handler answers.
- **Metadata routes under the mount:**
  - `/blog/sitemap.xml` is `application/xml`, with 2 URLs;
  - the page links `og:image` to `/blog/opengraph-image?…`, which serves a generated 1200×630 PNG.
- The root `/sitemap.xml` and `/robots.txt` are the shell's.

## Fonts, images and public files

`media.mjs` uses `/blog/media`: a `next/font/local` font, an imported image, and a `public/` image through
`next/image` and as a plain `<img>`. It checks a direct load and a soft navigation.
- **`next/font`:**
  - the family is applied, the font file answers 200 and the preload `<link>` is in the HTML;
  - nothing had to change.
- **`next/image`:**
  - failed first with "isn't a valid image … received null", because the optimizer fetches local images by calling
    Next's handler with a mocked request, which never reaches Zones' HTTP layer;
  - Zones now hooks `fetchInternalImage`, and both images load, the imported one at 120 px and the public one at
    64 px.
- **`public/`:**
  - failed first: `/blog/logo.png` was answered by the dynamic page `/blog/[id]`;
  - `tools/build-zone.mjs` now stores `public/` beside the build, and Zones serves it ahead of Next, so ahead of
    dynamic routes, as Next does: `image/png`, `max-age=0`;
  - a zone with `public/favicon.ico` (outside its mount) is refused at install.
- **Fixed on the way:** Zones served every zone static file that was not CSS as `application/javascript`, fonts
  and images included. It now sets each file's content type.

## Declaring a zone in its next.config

`zoneConfig({ mount, aliases }, nextConfig)` (`src/config.mjs`) replaces the earlier `package.json` field.
- `build-zone.sh` reads the declaration with `readZone()` and writes it into the store's `zone.json`.
- `next-zones check` (`src/cli.mjs`) checks a whole workspace of zones.
- Zones reads the shell's declaration at boot, and refuses to start unless the shell is mounted at `/`.

## generateStaticParams, dynamicParams, fallback

`params.mjs`:
- `/blog/tags/a`, a generated param, is a HIT at once.
- `/blog/tags/z` is a MISS on its first request and a HIT on the second. It was written to the zone image's cache,
  and the shell's `.next` was left untouched.
- With `dynamicParams = false`, `/blog/fixed/one` is a HIT and `/blog/fixed/two` answers 404.

## Concurrent renders, and revalidation across zones

**The bug.** Next's page runtime assigns `globalThis.__next_require__` and `globalThis.__next_chunk_load__` to the
rendering page's loaders at the start of every render.
- With several builds in one process, two concurrent renders overwrite each other. One loaded its chunks through
  the other's runtime: `ChunkLoadError: Failed to load chunk server/chunks/ssr/… from module …`.
- It first showed in revalidation: the shell's `/stamp`, regenerating in the background while `/blog/stamp`
  rendered, failed, so a tag revalidation never refreshed the shell's page.

**The fix.** Both globals are properties whose setter binds the loader to the current async context
(`AsyncLocalStorage.enterWith`), and whose getter returns that context's.

`concurrent.mjs`: 3000 requests, 64 at a time, across dynamic pages of the shell, the blog and the shop, and a route
handler.

| Loaders bound per context | Correct | Wrong (500) | Zones log errors | Time |
|---|---|---|---|---|
| off (`NEXT_ZONES_SCOPED_LOADERS=off`) | 1551 | 1449 | 5796 | 6.16 s |
| on | **3000** | 0 | 0 | 4.50 s |

`revalidate.mjs`: the shell's `/stamp` and the blog's `/blog/stamp` cache data tagged `stamp`.
- `revalidateTag` from the zone refreshes both pages, and so does `revalidateTag` from the shell (each page changes
  on its second read, as the `max` profile serves stale once).
- `revalidatePath("/stamp")` from the zone refreshes the shell's page.

## Routing inside a zone

`routing.mjs`, by direct request and by soft navigation from the shell:
- **Routes:** catch-all, optional catch-all, a route group and parallel routes.
- **Segment files:** `loading` (seen while the page streams), the error boundary, and the zone's not-found.
- **Navigation:** `redirect()` into another zone (307, soft on a `<Link>`); the router hooks report the zone's path,
  params and search params, and `router.push` into another zone is soft.

Compared with the zone running alone (`next start`), direct loads behave the same. A thrown page answers 500 with
the error boundary rendered after hydration; `notFound()` answers 404 with the zone's not-found in the HTML. The list
of such Next behaviours is in `SUPPORT.md`.

## A zone's routing rules, and intercepting routes

`rules.mjs`: a zone's own `headers`, `redirects` and `rewrites` from its `next.config`.
- **Results:**
  - `x-zone-header: blog-x`;
  - a 308 to `/blog/5`;
  - rewrites before files, after files and as a fallback;
  - a rewrite with `has` that sends `?to=shop` to the shop zone;
  - intercepting routes: the modal on a soft navigation, the full page on a direct load.
- **How:** production computes the router's route list once. So Zones puts one dispatcher in each list (headers,
  redirects, rewrites before files, after files, fallback) before the first request.
  - Its `match()` walks the current zone rules.
  - Its getters (`destination`, `has`, `missing`, `statusCode`, `headers`) answer for the rule just matched.
    `resolve-routes` reads them right after `match()`, with no `await` in between.
  - Aliases are rewrites before files, so they go through the same dispatcher.
- **Refused:** a header rule outside the mount ("its headers rule /other/:x is outside /blog, /post"), and a
  `trailingSlash` different from the shell's.

## A zone's main chunks, and its client runtime

**The bug.** After the blog zone gained more server actions, a soft navigation into `/blog` failed in the browser:
"Module 53412 was instantiated because it was required from module 95187, but the module factory is not available".
- Turbopack had moved module 53412 into the blog build's root main chunks (`build-manifest.rootMainFiles`). Those
  are loaded by the blog's own HTML documents only.
- A zone reached softly runs in the shell's document, whose main chunks lack it.
- Prerendered payloads (`.rsc`, and the flight data in `.html`) carry their chunk lists from build time, so changing
  the manifests at run time was not enough for `/blog`.

**The fix.**
- **The synthesized chunk.** A worker thread (`zone-main.cjs`) runs the zone's and the shell's main chunks in a `vm`
  sandbox and collects the modules the shell lacks, with the zone main modules they require (factories scanned for
  `x.r(id)`-style requires). They are written as one small chunk: **511 bytes**, against about 430 KB for the
  zone's four main chunks.
- **Where it is listed:** first in every client module of the zone's manifests, and in every `I[…]` row of its
  seeded payloads.
- Measured: of 137 module ids in the shell's main chunks and 137 in the zone's, the zone's main chunks held
  **1 module** the shell lacked.

**The client runtime.** Each build's Turbopack browser runtime is trimmed to that build: the blog's has method `a`
(async modules), the shell's does not.
- A document has one runtime, the shell's.
- Zones refuses a zone whose chunks call a runtime method the shell's runtime lacks (`x.a(`). The blog's chunks
  never call `a`, so it installs.

## Swaps under load

`swapload.mjs`: 32 concurrent clients on a zone's dynamic page, its prerendered page, its route handler and a shell
page. Partway, the zone is swapped v1 ⇄ v2 every 150 ms (18 swaps), then rolled back.

| Phase | Requests | p50 | p95 | p99 | Wrong |
|---|---|---|---|---|---|
| before | 2338 | 48.89 ms | 88.07 ms | 214.76 ms | 0 |
| during the swaps | 2457 | 39.07 ms | 76.77 ms | 95.49 ms | 0 |
| after | 2873 | 27.02 ms | 64.97 ms | 70.24 ms | 0 |

- The phases get faster over time as the JIT warms up. The swaps add nothing visible.
- The switch under load takes 0.04 ms p50.

## The swap signal (D4 settled)

`<ZoneUpdates />` (`@runsnip/next-zones/client`) in the shell's root layout listens to `/_next-zones/events`, Zones'
server-sent events, and calls `router.refresh()` on a swap.

`signal.mjs`: a tab visits `/blog` (v1, prerendered and cached by the router), goes home, and the zone is swapped to
v2. With no refresh of its own, its next soft navigation shows "zone blog v2" and "editor v2", in the same document,
with the shell's counter kept. `swap.mjs`'s soft navigation now shows v2 too, where it showed v1 before.

## One node_modules, and version checks

**The bug.** A zone's server code requires its externals by bare name (`next/…`), and Turbopack aliases
`serverExternalPackages` as `<pkg>-<hash>` through absolute symlinks in the build's `node_modules/` that point at the
build machine.
- From a store on another machine neither resolves: `Cannot find module '@spike/ext-63e66b3bbcb951df'`, a 500.
- It went unseen because the shell, loaded first, had put the shared modules in the registry.

**The fix.** A bare request from inside a zone's build resolves against the shell's `node_modules` first, with the
hash suffix stripped.
- `external.mjs`: a store copied outside the workspace, its external's symlink pointed at a missing build-machine
  path. The page renders.
- `tools/build-zone.mjs` records the Next, React and react-dom versions in `zone.json`. A zone built with React
  19.2.0 is refused by a Zones service that runs 19.3.0.

## Cached misses

`miss.mjs`: URLs that answered 404 before any install, and were cached as misses, answer once the zone serves them.
`/blog/new` shows v2's page under v2 and the item page again after a rollback to v1.

## The switch at 3 µs

The switch now only assigns what `prepare` built:
- the overlay;
- the segment → zone map;
- the zones' routes for the router's `appFiles`. The router's Set answers through an overridden `has()`, since it is
  held in a closure;
- the rule tables.

Cached misses are dropped lazily:
- each key in a kept LRU remembers its first segment's generation;
- a switch bumps the zone's segments, O(segments);
- an older key reads as absent.

`tools/bench/activation.mjs`, 248 routes (75 dynamic in the padding), a 29-route zone, 2000 cached misses, 300 swaps.
Two runs, each on a fresh Zones:

| phase | before this round (p50) | after, run 1 (p50 / p95) | after, run 2 (p50 / p95) |
|---|---|---|---|
| overlay | 8.6 | 0.6 / 2.0 | 0.5 / 1.8 |
| matchers | 0.3 | 0.5 / 1.5 | 0.5 / 1.4 |
| fsCheck | 3.5 | 0.3 / 0.9 | 0.3 / 0.9 |
| lru | 2.1 | 0.3 / 0.9 | 0.3 / 0.8 |
| **switch** | **17.0** | **3.2 / 10.2** | **3.0 / 8.8** |
| prepare | 528 | 574 / 1292 | 543 / 1064 |

Every phase is now under 1 µs, so what remains of the switch is mostly the cost of timing its phases.

## Installs off the event loop

A first install of a zone image used to block the event loop for about 110 ms: seeding (58 ms, synchronous
`cpSync` then a rewrite pass), the main-chunk analysis and the runtime scan (about 20 ms of `vm` and reads).
- **The fix.** The analysis runs in one worker thread (`zone-main.cjs`) and the seeding in another (`zone-seed.cjs`,
  one pass: read, rewrite, write, then rename). Both results are kept per (zone build, shell build), so a reinstall
  (a rollback) reads them back.
- **What stays on the main thread:**
  - reading the zone's manifests, about 4–5 ms;
  - `prepare`, 2.5–3.4 ms;
  - the zone's instrumentation, 1.8 ms.
- `installstall.mjs`: one client requests a shell page back to back. Its worst request while a first install runs
  is 9.6–28.6 ms, against 7.3–10.9 ms idle (two runs). Before the fix, the install alone blocked about 110 ms.
- **Install times:** a first install takes 95–180 ms of wall time, most of it in the workers. A reinstall takes about
  4 ms.

## Cache Components and PPR

`fixtures-cc` holds a shell and a zone (`notes`) that both set `cacheComponents: true`. `/notes` is a Partial
Prerender: a `'use cache'` value tagged `notes` in the static shell, and a dynamic hole reading a cookie.

`cc.mjs`, on Zones (`NEXT_ZONES_SHELL=fixtures-cc/shell`):
- With cookies `alice` and `bob`, both responses carry the build's cached value (`08:08:44.081Z`, the store build's
  own), with `alice` and `bob` in the hole.
- After `revalidateTag("notes", { expire: 0 })`, the next read carries a new value, written to the zone image's
  cache.
- A soft navigation from the shell renders the zone page with its hole (`dave`), in the same document, with no
  errors.
- Compared with the zone running alone (`next start`): the same prerendered value and per-request hole,
  `x-nextjs-prerender: 1`.
- `blog`, built without `cacheComponents`, is refused by this shell: "cacheComponents must equal the shell's
  (false vs true)".

## Several installs at once, and what a zone may not bring

- **Installs take turns.** Installs stage, seed and analyse in parallel, but `prepare` and the switch now run behind
  one queue. Before, `activateV1` re-prepared a stale plan only once, which another switch could outrun.
  `many.mjs`: 20 rounds of three concurrent installs (blog v1/v2 and shop) under 16 clients. The versions served are
  the last installed every time, and no answer was wrong.
- **Refused at install, each checked against a real build:**
  - edge routes ("has edge routes (/edgy/fast/route)…");
  - an `instrumentation-client` file, which `tools/build-zone.mjs` records;
  - an `images` config that differs from the shell's ("images.remotePatterns differ from the shell's…").

## A shared package at different versions across zones

**The bug** (reported by an agent building an app on next-zones):
- **What it looked like:** two zones built against different versions of one shared component. After a soft
  navigation into the newer zone, the browser ran the older component; a hard reload showed the newer one.
- **The cause:** module ids come from the path, so the shared component has the same id in both builds. The browser
  has one Turbopack runtime, which keeps the first factory it loads for an id. On the server the module registry
  already keyed by id and factory hash; the browser did not.
- **Reproduced** with `sharedver.mjs`. Shop v2 is built with `env.BADGE_VARIANT = "v2"`, inlined into the shared
  badge. After a soft navigation from the shell, the shop showed "badge shop", not "badge v2 shop".

**The fix**, at install, in a worker (`zone-client.cjs`):
1. Each client module of the zone is compared with what a browser may hold for its id: the shell's modules, and those
   of every zone installed before.
2. **What is compared.** Byte for byte, 36 modules differed, 35 of them Next's own. Two builds minify one module with
   different local names (`o` here, `u` there). So the comparison is of the code up to the minifier's local names
   (`canonical.cjs`, alpha-renaming):
   - strings, numbers, regular expressions, property names, object keys and long names are kept;
   - short identifiers are renamed by order of first appearance.

   Of the 162 module ids the shell and shop v2 share, 126 are equal byte for byte and **161 are equal canonically**.
   The one that differs is the badge.
3. **New ids.** A differing module, and its importers the browser may hold, get new ids, derived from the zone build
   and the old id.
   - The zone's chunks holding them are written again under new URLs (`…-z<build>.js`).
   - Its client reference manifests (ids, chunk URLs, the SSR/RSC mappings) and its seeded payloads (`I[…]` rows,
     chunk URLs) point at them.
4. **What a module requires counts by what it is, not by its id.**
   - **What failed:** after step 2, `rules.mjs` failed. A soft navigation to an intercepted route no longer showed the
     modal. The blog's build gave one module of Next (`findSourceMapURL`) another id than the shell's build did,
     though the code is the same. Three router modules that require it then differed only in that id, and so did their
     22 importers. The blog got a second copy of Next's router, with its own contexts.
   - **The fix:** a module's identity is a Merkle hash. It is made of its own canonical code, with the ids it requires
     blanked, and of the identities of the modules it requires, in order.
   - **Cycles.** Next's router modules require each other, so they are hashed together, whatever the order they are
     reached in. Each strongly connected component (Tarjan) is refined from its modules' own code and what they
     require outside it, for as many rounds as it has modules (color refinement).
   - **Result:** the blog remaps nothing, and shop v2 remaps the badge alone. The analysis takes about 150 ms, in a
     worker thread.
5. **The results are kept** per (zone build, what was installed before, analysis format).
6. **Concurrent installs.** Two installs of one build at once (`many.mjs`) wrote the same temporary folder, named by
   process and millisecond. The temporary names are now unique per worker, and the analysis writes its files
   atomically.

**After:**
- A soft navigation into shop v2 shows "badge v2 shop", and back in the shell "badge shell": both versions live in one
  document, with no errors.
- One module was given a new id, and one chunk was written again. React and Next's runtime stay shared.
- **Before the canonical comparison,** the 35 false conflicts remapped React's modules and loaded a second React: "Cannot
  read properties of null (reading 'useContext')".

Every area of Next and its status is listed in [`SUPPORT.md`](../../SUPPORT.md).

## A zone run alone

**The report.** A zone was run alone (an app developed on its own), and Next logged 404s when it prefetched links to
other zones from a shared header.

**Measured** with the blog run by `next start`, and its `<Link href="/shop">`:
- **Prefetch:** 404.
- **Click:** a full page load, onto a 404 page.
- **The cause:** the zone alone has no `/shop`.

**Decided:** this is not Zones' concern.
- Zones are served together by Zones. There, links between zones prefetch with a 200 and navigate softly.
- A zone deployed alone lives on its own domain, so its links to other apps are links to another site.
- A fallback to "where the zones run together" was tried and dropped. It made the 404s go away, but every navigation
  was still a full load from another build, and it served no deployment that exists.

**Found on the way:** a zone alone did not answer its aliases (`/post/42` gave 404), because only Zones served them.
`zoneConfig` now adds them to the zone's own `beforeFiles` rewrites, unless the build is for Zones
(`NEXT_ZONES_BUILD`, set by `next-zones build`). `standalone.mjs` checks a zone alone: its page, its alias and its
404.

## Development: the zones composed on `next dev`

Zones runs production builds, so an edit means a build: `next-zones watch` rebuilds a zone and installs it in about
7 s. `next-zones dev` composes the shell and the zones into one app, `.zones-dev/`, and runs one `next dev` on it.

**What it is made of.** Nothing is copied: every file is a link to the zone's own file.
- **Linked files, not linked folders.** With `app/blog` linked as a folder, Next's route discovery did not enter it:
  `/blog` gave 404. So `app/` is made of real folders holding links to files, and a watcher mirrors the files added
  and removed.
- **An edit is seen through the link.** It reaches Turbopack, which compiles the zone's real path. The watcher also
  makes the link again on each edit, so the change is seen in the composed tree too.
- **One tsconfig, and each zone's own `@/*`.** Checked by removing the composed `@/*` path: the zone's own tsconfig was
  not read for its files, and its imports failed.
  - Turbopack 16 runs loaders by path condition. So an alias that zones point to different folders goes to a loader
    rule per zone (`compose-alias-loader.cjs`), which turns `"@/x"` in that zone's files into a relative path to the
    zone's own folder.
  - Two Turbopack details found on the way: a loader must give a relative path (an absolute one is not resolved), and
    `as: "*.tsx"` renames `editor.tsx` to `editor.tsx.tsx`, so the rule has no `as`.
  - Aliases all zones agree on stay in the composed tsconfig.
  - The blog and the shop fixtures both import through `@/*`, each to its own folder: composed, Zones builds, and alone.
  - A package's `imports` (`#/*`) also resolves per package under Turbopack, but TypeScript does not read an
    extensionless target. `@/*` stays.
- **Tailwind.** From the composed app, Tailwind's automatic scan saw only links and Next's `.next` cache. It produced
  a class from binary bytes, and a broken stylesheet. The composed PostCSS config sets Tailwind's `base` to the zones
  dir, so it scans every zone as each does alone; a class used only in a zone's `src/` is generated.
- **Turbopack's root** is the folder holding every zone, so the linked files are inside the project.
- **HMR origin.** `next dev` serves HMR only to allowed origins: opened at `127.0.0.1`, a page got no updates. The
  composed config allows `localhost` and `127.0.0.1`.

**Measured** (`composed.mjs`, the test shell, blog and shop):
- Soft navigation shell → blog → shop → the alias, with the shell's counter kept.
- An edit to a zone's page shows in 78–79 ms, and an edit to a shared package in 24–76 ms, with no reload.

## A library's context across builds

**Found** by serving two real apps on Zones. One page answered 500 with "No QueryClient set, use
QueryClientProvider to set one":
- the shell's root layout rendered a UI kit's `QueryClientProvider`;
- a zone's hooks called `useQuery`.

**The cause:** Turbopack drops the exports a build does not use.
- The shell used only `QueryClientProvider`, so its copy of the react-query module exported only that.
- The zone also used `useQueryClient`, so its copy exported both.
- Same module id, different code, so the registry rightly did not share them. That made two modules, and two
  `createContext` calls. On a soft navigation, the zone's hook read a context nobody provided.

**What it is not:**
- Not the minifier: the two copies differ even in canonical form.
- Not the client boundary: a `"use client"` file keeps every export. Only a library imported *inside* the boundary
  is trimmed.

**The fix:** `zoneConfig` sets `experimental.turbopackRemoveUnusedExports: false`, and
`turbopackRemoveUnusedImports: false`, which Turbopack requires with it. Every build then holds the whole module,
identical across builds, and shared.
- On the two apps, react-query's module became byte-identical in both builds, and the page answered 200.
- **The cost:** client JS +1.9% (shell) and +3.4% (zone), server JS +8.6% and +4.4%.
- The three options and their cost are documented ("Build options" in docs/configuration.md). `zoneConfig` warns
  when a zone's own config sets them otherwise.

**The check:** `context.mjs` reproduces the case.
- `shared/context-lib.js` is a library with a context.
- `shared/context.js` is the client boundary the shell's layout renders: it re-exports the Provider only.
- The blog reads the hook from the library.
- **Without the options:** a soft navigation reads "context none", the default. A direct load reads "root", because
  the whole page comes from one build.
- **With them:** "root" both ways.

## Next's internals, checked before they are hooked

Zones hooks a dozen of Next's modules and methods. Before this change:
- they were found by the path they were required by (`request.endsWith("router-utils/filesystem")`), so a moved
  import would leave a hook silently off;
- only the Turbopack runtime layout and the route matcher providers were checked.

**Now:**
- **Before anything is hooked** (`locateNext`): the Next version must be one of `SUPPORTED`, the versions the whole
  suite has passed on. Each module Zones relies on is located by its exact file.
- **Hooks match the module loaded from that file,** whatever path Next requires it by.
- **Once hooked** (`checkNext`): each module, as Next has it, has the functions and methods Zones wraps or calls.
- **At start:** the hooks the switch needs took hold (the server, the router's fs checker, the manifests, the LRU
  caches). The router's and the server's objects have the shape Zones reads.
- **Any failure refuses to start,** with every problem listed.

`contract.mjs` proves it:
- an unknown version is refused, and runs with `unsupportedNext`;
- a module that moved is refused;
- a missing function is named;
- the spike's Next passes.

The upgrade guard sets `NEXT_ZONES_UNSUPPORTED_NEXT=1` for the version it checks.

## One file to install, and the build's integrity (D2)

`stage` used to read a dozen of the build's manifests synchronously, on Zones' event loop:
- app paths and routes;
- the routes, middleware, functions, prerender and server-reference manifests;
- `required-server-files.json`, `BUILD_ID` and `public/`;
- and the shell's own manifests, each time.

**Now:**
- `next-zones build` describes the build once (`Zones/describe.cjs`) and writes the result into `zone.json` under
  `install`, with the build's `integrity`: a sha256 over every file's path and content.
- Zones reads that one file asynchronously. It reads the shell's facts once per process.
- It checks the integrity in a worker (`zone-verify.cjs`) the first time it installs a build. A build without these
  fields is described at install, as before.

**Measured** (the test blog, 8 installs alternating two versions):

| | Before | After |
|---|---|---|
| Stage work on the main thread | 3.7–8.9 ms | 0.15–1.55 ms |
| Integrity check (worker, first install of a build) | — | about 270 ms for 663 files, then remembered (0.5–0.8 ms) |
| Longest event-loop block during an install | — | 0–2.9 ms |

**The check:** `integrity.mjs` changes one byte of one server file in a copy of a stored build. The copy is refused
(409, "the stored build differs from the one built") and the active version is unchanged. An intact copy installs.

## Two real apps on Zones, against `next start`

The shell and two zones of a real workspace: Tailwind, a UI kit, Monaco, react-query, a proxy with a CSP nonce per
request. Measured on the same machine.
- **Zones:** the shell, with both zones installed.
- **Against:** three `next start`, one per app.
- **Method:** each route is requested 20 times to warm up, then 100 times in sequence. RSS is summed over each
  server's process tree.

| | RSS | p50 / p95 latency |
|---|---|---|
| Zones (one process) | **291.6 MB** | 3.6–4.2 / 4.2–5.6 ms |
| Three `next start` | 500.3 MB | 3.4–4.4 / 4.5–5.9 ms |

- **Navigation:** soft from the shell to each zone and between them. No console error, and no CSP violation: Zones'
  rewritten chunks load under `strict-dynamic`.
- **Found on the way:** `next-zones build` copied a zone without its own `node_modules`, so packages the workspace
  had not hoisted were missing from the copy. The copy now links them.

## Memory across many versions

`memswap.mjs` installs copies of one build at new paths: N distinct sets of modules for Node, as N releases would be.
It requests each version so its code loads, then calls `collect({ keep: 2 })`.

- **The first measurement was wrong.** `/_next-zones/debug?gc=1` called `gc()` only when Zones ran with `--expose-gc`,
  and it did not. The "2.0–2.6 MB per version" was garbage not yet collected. The endpoint now turns the flag on at run
  time.
- **A plain `gc()` is not enough either.** After 30 versions it left 89 MB (large objects: 32.9 MB). The full
  collection V8 runs before a heap snapshot, and near its heap limit, left 43.7 MB (large objects: 8.1 MB). What a
  plain GC kept was reclaimable caches of old builds' sources and code.
- **Retained heap, after that full collection:**

  | Versions installed | 0 | 30 | 60 | 90 | 120 |
  |---|---|---|---|---|---|
  | Heap (MB) | 25.7 | 44.6 | 44.9 | 46.2 | 47.3 |
  | RSS (MB) | 211.5 | 298.6 | 361.6 | 381.7 | 403.5 |

  From 30 to 120 versions, the heap keeps about 30 KB per version: Node's internal resolution caches, which hold path
  strings. `collect()` now also clears `Module._pathCache`; the others are internal to Node.
- **RSS still grows, ever more slowly.** That is native memory not handed back to the OS: D14, a task before serving on Zones.

## Debt

What was measured and left for later is kept in one place: the **Debt ledger** in the [README](../../README.md#debt-ledger),
with each entry's cost, bottleneck, next step and when to come back.

## Not yet covered (next spikes)

- Fonts (`next/font`) and `next/image` in a zone.
- Route handlers (`route.ts`) and metadata routes in a zone.
- `generateStaticParams` with `dynamicParams`/fallback in a zone (`prerender-manifest.dynamicRoutes`).
- `revalidateTag` / `revalidatePath` across zones, and `'use cache'` handlers.
- The shell's proxy in front of zone routes.
- A Next upgrade guard: these hooks reach Next's internals, so a version check plus this suite must run on every
  upgrade.

## Client module identity by a parser (D15, settled)

`canonical.cjs` compared minified modules with a tokenizer: short names were renamed by first appearance, whatever
they were bound to; names over three letters were kept; and `x.y(<number>)` on any one-letter object counted as a
require, blanked. So `return top` and `return foo` (two globals) were one code, `o.f(3)` and `o.f(4)` on a local were
one code, and a long local name made one code two.

`src/zones/module-code.cjs` reads each factory with Next's own acorn and a scope analysis: function scopes with var
hoisting, separate parameter scopes when parameters have defaults or patterns, block scopes for let/const/class,
catch, loops, named function and class expressions, sloppy-mode block functions (Annex B), labels, and a class's
private names. A bound name is written as its binding's index; a free name is kept; `with` or a direct `eval` keeps
every name. Requires are calls on the factory's own context parameter (not a local shadowing it), with a one-letter
method and a numeric id, remapped by their position.

Measured with `tools/bench/identity.mjs` on a real app's zone (797 client modules) against its shell (373), median of
5 runs, M1:

| | Time | Conflicting modules | Chunks rewritten |
|---|---|---|---|
| Tokenizer | 0.39 s | 68 | 21 |
| Parser | 0.85 s | 17 | 7 |
| Parser, module reads cached | 0.16 s | 17 | 7 |

Of the 17, six differ in their own code (an app catalogue with another app, two modules unrelated but given one id,
another list of API routes, a parameter default) and the rest import one of them. Parsing is the cost (about 480 ms of
the 520 ms reading 3.4 MB of factories cold; the scope walk about 40 ms), so module reads are cached on disk by the
factory's text: a zone's next version shares most of its modules with the last.

## Memory across many versions (D14, settled)

The earlier measure: after a full collection, the heap kept about 30 KB a version, while RSS went 211 → 404 MB over
120 versions. Taken again on the current code (`memswap.mjs`'s method: 120 copies of blog 1's build at distinct paths,
each installed, requested, then `collect?keep=2`; M1, Node 24), with V8's and macOS's own accounting (`vmmap`):

- **The collected versions are gone.** Native contexts stay at 16, Turbopack runtimes at 10, loaded server chunks at
  164. A heap snapshot finds a collected version's paths only in Node's `relativeResolveCache` and `realpathCache`
  (strings, about 20 KB a version).
- **But the heap after `gc()` grew 38 → 270 MB**, in `large_object_space` and `old_space`. A heap snapshot of the same
  process counted 54 MB live, and `heapUsed` read right after the snapshot was 50 MB: the snapshot's collection frees
  what `gc()`, run 30 times, does not.
- **It is V8's compilation cache.** Run with `--no-compilation-cache`, the heap stays at 49 MB after 30 versions (101 MB
  with it): the cache keeps every chunk script ever compiled, sources included, the collected versions' too.
- **And the heap's grown pages.** Without the cache, `heapTotal` still rose 47 → 186 MB (then flat), RSS 157 → 283 MB.
- **V8's last-resort collection** (`gc({ type: "major", flavor: "last-resort" })`, what a heap snapshot runs) clears
  both: after 30 versions, 59 ms, heap 101 → 48 MB, `heapTotal` → 51 MB, RSS → 130 MB; 27 ms run again.

**The fix** (`src/zones/reclaim.cjs`): after a version is collected, Zones runs that collection once no request has
been in flight for a second (at most 30 s later, however busy). The cache stays on for everything else (a rollback
recompiles nothing).

| 120 versions, collected | RSS | Heap after a full collection | macOS footprint |
|---|---|---|---|
| Before | 161 → 337 MB | 38 → 270 MB | 141 → 563 MB |
| `--no-compilation-cache` | 157 → 283 MB | 36 → 52 MB | 138 → 315 MB |
| **Reclaim when idle** | **127 → 117 MB** | **40 → 52 MB** | **122 → 127 MB** |

Three reclaims ran over the 120 installs, 47–75 ms each, all while idle. `reclaim.mjs` checks it: 12 versions, then
idle: one reclaim, RSS 210 → 87 MB.

## Two versions rendering one route at once (Next 16.3.8)

**Found** by `swapload.mjs` once in a full run on Next 16.3.8, then reproduced at 96 clients with the CPU loaded:
during swaps, `/blog` answered 500 (4 to 136 times per run, in 4 runs of 6), with "Could not find the module
`[project]/fixtures/blog@1/…#Editor` in the React Client Manifest".

- Next registers the client reference manifest of the route a request renders in a process-wide map keyed by route
  (`app-render/manifests-singleton.js`: `clientReferenceManifestsPerRoute`, set by every request), and the render reads
  it back from there. v1 and v2 of a zone serve the same routes: while a swap was under way, a v1 render read the
  manifest a v2 request had just registered for `/blog`.
- **The fix** (`src/zones/loaders.cjs`): the map Next creates gets a layer per request (Zones runs each request in an
  async context of its own): what a request registers, it reads back; outside a request, the shared map as before.
  Also, a zone page bundle's route module loads its own manifests from its own build (`hooks.cjs`), not from the
  version active when it asks.
- After: 6 runs of 6 s per phase at 96 clients with four CPU-bound processes, about 17,000 requests and 54 swaps: no
  wrong answer, no error. `swapload.mjs` now runs at 64 clients.

## Next 16.4.0, and 16.3.7

**The guard:** `node tools/upgrade-guard.mjs <version>` on a fresh copy of this folder, one version after another
(they share port 3900): 48/48 on 16.4.0, 16.3.8, 16.3.7 and 16.3.6 (Node 24.16.0, Apple M1).

**What 16.4.0 changed under Zones**, each found by a check that failed, and handled for both versions:
- **The server runtime's module cache is a `Map`** (`new Map()`, `get`/`set`), no longer an object: the registry gives
  the Map layout a Map subclass with the same lookups (`registry.cjs`). The runtime was refused, as it should be, until
  it was recognised.
- **No route matchers.** `getRouteMatchers` and the matcher providers are gone; `getRouteMatch` rebuilds the route
  definitions from `appPathsManifest` and `appPathRoutes` on each call. Zones already assigns both at a switch, so it
  keeps the server by `getAppPathRoutes` (called in the constructor) and skips the matchers. The contract names
  either form ("getRouteMatchers, or getRouteMatch and getRouteDefinitions and getAppPathRoutes").
- **A route's client reference manifest is read by `evalManifestFromRelativePath`**, a function of its own: it is
  routed to the zone's build like `loadManifestFromRelativePath`.
- **Strict factories in client chunks:** a chunk's strict modules come first as a nested array, made in one
  `"use strict"` scope; a chunk of strict modules only is one `"use strict"` scope around a flat push, because a push
  of two items is read as the chunk's registration. Chunks Zones writes again (new ids, a zone's main chunk) keep both
  forms (`zone-client.cjs`).
- **`partialPrefetching`** is warned about when `cacheComponents` is on without it. It decides how the client router
  prefetches, so a zone must set it as the shell does, like `cacheComponents` (`stage.cjs`, `doctor`).

**Not measured yet:** the cost of 16.4's per-request route matching (definitions rebuilt and dynamic routes sorted on
each call) against 16.3's matchers, with the 2036-route app of `activation.mjs`.

## A .zip read as it arrives

**Before:** a `.zip` was spooled to disk, then read from its central directory one file at a time.

**Now** (`readZipStream`, `zip.cjs`): read from its local headers as it arrives, nothing spooled. Files of up to 2 MB
are read whole and inflated and written in parallel while the next ones arrive (4 at once, 16 MB in flight); larger
ones, and ones whose size comes after their data, stream through `inflateRaw`, which stops where its deflate stream
ends (`bytesWritten` says where the next entry starts). The central directory, at the end, must agree with what was
written (names, CRC-32, sizes); links are made from it, last. `writeZip` now puts each entry's sizes in its local
header (written back at its position once the data is out), so every entry it writes can go the parallel way.

**Measured** (`node tools/bench/pull.mjs --mb 300 --runs 5 --format zip --against HEAD`, a build-shaped 300 MB image,
60% random bytes, served by a local HTTP server, each run a fresh process, median; Node 24.16.0, Apple M1, load
average about 6 from other work, so ±0.1 s):

| | time | peak RSS | disk beside the folder |
|---|---|---|---|
| `.zip`, spooled (before) | 0.9 s | 185 MB | 174 MB |
| `.zip`, as it arrives, one file at a time | 0.8 s | 171 MB | 0 |
| `.zip`, as it arrives, in parallel (now) | 0.5 s | 210 MB | 0 |
| `.tgz` (for reference) | 0.3–0.4 s | 160 MB | 0 |

- **Where the time went:** a CPU profile of the one-at-a-time reader was 67% idle: inflating and writing run on
  libuv's thread pool, and one file at a time keeps one of its threads busy.
- **The memory:** the 25 MB over the spooled reader does not follow the in-flight budget (16, 32 and 64 MB gave
  211–214 MB) or the per-file limit (1, 2, 8 MB gave 196–218 MB): it is buffers of whole files churned faster than
  the collector returns them.
- **An earlier measurement was wrong:** `.tgz` 2.4 s and `.zip` 3.7 s were taken while the upgrade guard ran in the
  background; the same code measured 0.3 s and 0.9 s on a quiet machine.

## D8: what it costs, and module fragments (tried, rejected)

**The measure** is the JavaScript a page loads when opened: the build's `rootMainFiles` and the `entryJSFiles` of
the page's client reference manifest (its layouts and page), each file once, gzipped at level 9. Lazy chunks are
left out: a sum of every chunk counts code a page never loads (one zone has 696 chunks, most of them one icon each).
Builds: a real workspace of a shell and four zones on Next 16.4.0 (a copy, with `next` bumped), `next-zones build`,
three ways: as today (unused exports kept), with Turbopack's module fragments (`turbopackModuleFragments` and unused
exports removed), and with unused exports removed alone (the target: smallest, but not shareable across builds).

| page | today | fragments | target |
|---|---|---|---|
| shell `/` | 198.7 KB | 191.1 | 194.3 |
| shell `/account/*` (7 pages) | 241.5–259.2 | 251.3–271.9 | 230.3–247.1 |
| a zone's editor page | 376.6 | 406.6 | 349.0 |
| a zone's library page | 287.7 | 306.0 | 268.3 |
| a zone's studio page | 353.7 | 363.6 | 330.3 |
| a zone's two pages | 245.7–251.3 | 255.9–263.9 | 233.4–238.9 |

- **D8 costs 5–8% of a page's JavaScript** (10–28 KB gzipped) on these apps.
- **Module fragments are worse than today on 15 of 16 pages** (+2–8%), and on the check bed they cost 4–13 MB of
  RSS serving the same pages (2.7 times the modules: 958 → 2578), for 16–18% less server JS on disk. Each fragment is
  a module of its own, and what they trim is mostly functions never called, which V8 never compiles. They also
  panic on Next 16.3.8 (`module_fragments/graph.rs:746`, even on a one-page app), and one build of a zone using
  `next/font/google` failed once with them on 16.4.0 ("queries have exactly one entry"). Rejected.
- **Correctness held with fragments**, once Zones read 16.4's `e.S` re-exports (package `3ab2408`): 48/48 checks.

**Where the 5–8% is** (one zone's page, bytes of generated code by source package through the source maps, today
minus target, 74.7 KB raw in all): `react-resizable-panels` 17.8 KB, the workspace's UI kit 13.4 KB, `tslib` 9.3 KB,
`@ecosy/core` 4.7 KB, the workspace's API client 3.5 KB, the rest under 3 KB each. These are modules with many
exports of which a page uses a few, in packages the shell uses too: keeping whole only the packages the shell
depends on (checked: a namespace import keeps a module whole, and the context check passes with it) would recover
nothing here.

**What must be identical across builds is a module with state** (a context, a singleton, a mutable binding), not a
stateless one: `tslib` trimmed two ways is loaded twice at worst. Next: trim every build, and keep whole only the
modules that hold state, found from their syntax tree, if that can be shown to miss none.
