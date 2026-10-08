# What next-zones supports, and how

Next 16.3.8 and 16.3.6, App Router, production server, live-installed zones (Zones). Each area of Next is listed from Next's own
API reference (`next/dist/docs/01-app/03-api-reference`).

**Status**
- ✅ **proved:** checked in a browser or over HTTP by the script named, under `spikes/zones/`.
  `node check-all.mjs` runs them all, each on a fresh Zones.
- 🟡 **expected:** the area needs nothing from next-zones because the mechanism is one that is already proved. It
  still has to be checked.
- 🔧 **work:** next-zones has to intervene; how is written here.
- ⛔ **refused:** cannot hold under Zones. The install refuses a zone that uses it, so it never fails silently.

**Why most things need nothing.** App Router navigation is server-driven: the browser asks for the next URL's RSC
payload, and the payload names its client chunks by URL. With one origin, one router, one React and one Turbopack
browser runtime, a zone's page is just another route to the client.
Zones' work is on the server:
- making the zone's routes, manifests and caches exist in the running process;
- keeping module ids, chunks and build ids consistent across separately built zones.

## Declaring zones

| Area | Status | How |
|---|---|---|
| Declaring a zone | ✅ | `zoneConfig({ mount, aliases }, nextConfig)` in the zone's `next.config` (`@runsnip/next-zones/config`). It turns scope hoisting off and attaches the declaration under a symbol, which `readZone()` reads for the build, `next-zones check` and Zones |
| A zone's URL segment | ✅ Zones mount checks, `next-zones check` | `mount: "/x"`. The shell is the zone mounted at `/`, with no shell flag. `next-zones check` refuses two zones on one mount and a workspace with no `/`. Zones refuses routes outside a mount, a live zone claiming `/`, and mounts taken by the shell or another zone |
| A zone's URL at the root (aliases) | ✅ `alias.mjs` | `aliases: [{ source: "/post/:id", destination: "/blog/:id" }]`. A rewrite before files, through the routing-rule dispatcher (below). The address bar keeps the root URL and navigation is soft. An alias that points outside the mount, or lands on the shell's routes or on another zone's mount or alias, is refused |
| Next, React, react-dom versions | ✅ `external.mjs` | `tools/build-zone.mjs` records them in `zone.json`. A zone built with another version than Zones runs is refused ("built with react 19.2.0; this Zones runs react 19.3.0") |
| `basePath`, `i18n`, `trailingSlash`, `assetPrefix`, `skipTrailingSlashRedirect`, `cacheComponents` | ⛔ refused ✅ | They shape every URL, or every page's rendering, so they must equal the shell's. Read from the zone's `required-server-files.json` at install |

## Routing

| Area | Status | How |
|---|---|---|
| `page`, `layout` | ✅ `browse.mjs` | Every zone renders the same root layout (a shared module). Routes are added to the route matchers, `appPathRoutes` and the router server's `appFiles` |
| Dynamic routes `[id]` | ✅ `features.mjs` | The zone's `routes-manifest` dynamic routes join the router server's list, in `getSortedRoutes` order |
| Catch-all `[...x]`, optional `[[...x]]` | ✅ `routing.mjs` | Same path as dynamic routes |
| Route groups `(group)` | ✅ `routing.mjs` | Folded into the paths at build time |
| Parallel routes `@slot`, `default` | ✅ `routing.mjs` | Resolved inside the zone's own loader tree |
| Intercepting routes `(.)x` | ✅ `rules.mjs` | Next compiles them into rewrites before files, conditioned on the `next-url` header. The zone's rewrites reach the router through the dispatcher, `has` included: the modal opens on a soft navigation, and the full page renders on a direct load |
| `loading` (streaming), `error`, `not-found` | ✅ `routing.mjs` | Per segment, inside the zone's tree. The root `not-found` and `global-error` are the shell's. Direct loads behave exactly as the zone running alone: compared with `next start`, see below |
| Route handlers `route.ts` | ✅ `routes.mjs` | Another matcher kind (`APP_ROUTE`). Its provider (`AppRouteRouteMatcherProvider`) is fed the zone's routes like the page provider |
| Metadata routes (`sitemap`, `robots`, `icon`, `opengraph-image`) | ✅ `routes.mjs` for a zone's `sitemap` and `opengraph-image` | Route handlers underneath. A zone's live under its mount (`/blog/sitemap.xml`); the root ones (`/robots.txt`, `/sitemap.xml`) belong to the shell |

## The proxy, and the config's routing rules

| Area | Status | How |
|---|---|---|
| The shell's `proxy.ts` in front of zone routes | ✅ `proxy.mjs` | It runs in the router before routes resolve, so it needs nothing. Header passing, a sign-in redirect (soft, on a `<Link>`) and a rewrite into a zone are proved |
| A zone's own `proxy.ts` | ⛔ refused ✅ | Only one proxy runs per server. A zone's proxy would silently not run (an auth gate skipped), so the install refuses it. Its logic belongs in the shell's proxy |
| `headers`, `redirects`, `rewrites` (before files, after files, fallback, `has`/`missing`) in a zone's `next.config` | ✅ `rules.mjs` | Production computes the router's route list once. So one dispatcher per list is put in before the first request; its `match()` walks the current zone rules, and getters answer for the rule just matched, with no `await` in between. Next does the rest: params, `has`, 307/308, the order. Every source must be under the zone's mount or its aliases, or the install is refused |

## Navigation (client)

| Area | Status | How |
|---|---|---|
| `<Link>` shell → zone | ✅ `browse.mjs` | Soft: same document, the shell's state is kept |
| `<Link>` zone → zone, both ways, Back/Forward | ✅ `links.mjs` | Soft. Each zone's client state and the shell's are kept |
| Prefetching | ✅ | Zone routes prefetch like any route. An uninstalled zone's prefetch is a plain 404 |
| `useRouter`, `usePathname`, `useParams`, `useSearchParams`, `useSelectedLayoutSegments` | ✅ `routing.mjs` | One router on the client. `router.push` into another zone is soft |
| `redirect` into another zone, `notFound` | ✅ `routing.mjs` | 307 on a direct load. On a `<Link>`, soft to the other zone, or the zone's not-found |
| `permanentRedirect`, `forbidden`, `unauthorized` | 🟡 | Same mechanisms as `redirect` and `notFound` |
| A zone's main chunks | ✅ `browse.mjs`, `features.mjs` | A build's root main chunks load with its own documents only. A zone reached softly runs in the shell's document, so modules Turbopack put in the zone's main chunks went missing ("module factory is not available"). The modules the shell's main chunks lack, with the zone main modules they require, go into one small chunk (511 bytes here, against about 430 KB of the zone's main chunks). It is listed first in the zone's manifests and in its seeded prerendered payloads |
| A shared package at different versions across zones | ✅ `sharedver.mjs` | Module ids come from the path, so a shared package has the same ids in every build, whatever its version, and the browser runtime keeps the first factory it loads for an id. At install, a worker (`zone-client.cjs`) compares each client module of the zone with what a browser may hold for its id: the shell's modules, and every zone installed before. It compares what each module is, not its text: the code up to the names of its bindings, from a parse with a scope analysis (`module-code.cjs`, Next's acorn), and the modules it requires by what they are, not by their id (a Merkle hash, with cycles hashed together). One module can have different ids in two builds. Of 162 shared modules, 126 match byte for byte and all but the changed one match this way. A differing module, and the importers of it that the browser may hold, get new ids. The zone's chunks holding them are written again under new URLs, and its manifests and seeded payloads point at them. Identical modules stay shared |
| The client runtime | ✅ check at install | Each build's Turbopack browser runtime is trimmed to that build, and a document has one runtime, the shell's. A zone whose modules use a name on their module context that the shell's runtime does not give is refused, with the names. Both sides are exact: the zone's uses from each module's parse, the shell's context from its runtime itself, run in a sandbox with one probe module that records the context it is handed |
| After a version swap | ✅ `signal.mjs`, `shared.mjs` | Open tabs run the new version's client code: each version builds from its own path, so its module ids are its own. `<ZoneUpdates />` (`@runsnip/next-zones/client`) in the shell refreshes the router on Zones' swap event, so even a cached static page shows the new version on the next navigation |

## Rendering and data

| Area | Status | How |
|---|---|---|
| Server and client components, one React | ✅ `browse.mjs` | Same `node_modules`. Shared modules are loaded once on the server through the module registry |
| A module shared by zones, loaded once | ✅ `shared.mjs` | A registry keyed by module id and factory sha1. Scope hoisting is off |
| Concurrent renders across zones | ✅ `concurrent.mjs` | Next's page runtime sets `globalThis.__next_require__` and `__next_chunk_load__` at every render. Zones binds them to the async context: 3000 of 3000 requests at 64 concurrent, against 1551 of 3000 without |
| A zone's server-external packages, and its Next/React | ✅ `external.mjs` | Bare requests from a zone's build resolve against the shell's `node_modules` first. Turbopack's hashed aliases (`<pkg>-<hash>`, absolute symlinks to the build machine) are stripped. So a store on another disk or machine works, with one copy of each package |
| A package only in a zone's own `node_modules` (not hoisted) | ✅ `localdeps.mjs` | `next-zones build` links the zone's `node_modules` into the versioned copy it builds from, so the package resolves as it does for the zone and is bundled into the build. As a `serverExternalPackages` entry it is not bundled and resolves from the shell's `node_modules` (row above) |
| Server actions, with bound arguments | ✅ `features.mjs`, `bound.mjs` | Every zone's actions are merged into the shared `server-reference-manifest`; one encryption key at run time |
| `next/form`, `useActionState` | 🟡 | Server actions underneath |
| Prerendered pages, ISR | ✅ `curl` | A `prerender-manifest` overlay, and a writable cache per zone image through Next's `cacheHandler`. The shell's build id replaces the zone's, row by row as React reads flight data (a text row's length written again, binary rows untouched), so the two ids may differ in length (a `generateBuildId`); the zone's main chunk is added. What next-zones derives from a build is named by its build key (zone, version, build id, digest), never by Next's build id alone: two builds may share one (`test/payload.test.mjs`; the test shop's versions share a 40-character id) |
| A shell with its own `cacheHandler` (a remote cache) | ✅ `ownhandler.mjs` | Kept for every key but the zones': a zone's pages and route handlers go to Zones' per-version cache, the shell's pages and all fetch and `unstable_cache` data to the shell's handler. `revalidateTag` and the request reset reach both |
| Memory across many versions | ✅ `reclaim.mjs` | Collected versions are unloaded; what V8 keeps of them (its compilation cache, the heap's grown pages) is handed back by its last-resort collection, run once Zones is idle after a collect: RSS flat at 115–128 MB over 120 versions of the test blog, against 161 → 337 MB before |
| Next's LRUs under traffic and swaps | ✅ `lrumem.mjs`, `test/kept-lru.test.mjs` | Each LRU remembers one generation per entry it holds, in step with its entries, so within Next's own bounds: 10k distinct misses with swaps, no heap growth |
| `generateStaticParams`, `dynamicParams`, fallback | ✅ `params.mjs` | Generated params are a HIT at once. Others render on first request, then are cached in the zone image's cache. With `dynamicParams = false`, they answer 404 |
| `cookies`, `headers`, `connection` | ✅ `proxy.mjs`, `routing.mjs` | Request-scoped, no shared state |
| `revalidateTag`, `revalidatePath` across zones | ✅ `revalidate.mjs` | From a zone or from the shell, a tag refreshes the pages of both. A path refreshes another zone's page |
| `'use cache'`, `cacheLife`, `cacheTag`, Cache Components / PPR | ✅ `cc.mjs` | On a shell and a zone that both set `cacheComponents: true` (`fixtures-cc`). The `'use cache'` value from the build is served across requests while the dynamic hole (a cookie) follows each request. `revalidateTag` renews it on the next read, written to the zone image's cache. A soft navigation from the shell renders both. `cacheComponents` must equal the shell's, or the zone is refused |
| `unstable_cache`; `after` | ✅ `revalidate.mjs`; 🟡 | |
| Draft mode | 🟡 | Uses the shell's preview keys (`prerender-manifest.preview`), which the overlay keeps |
| Edge runtime in a zone | ⛔ refused ✅ | Edge routes have their own manifests and sandbox, unproved under Zones. A zone with edge routes (`middleware-manifest.functions`) is refused, naming them; checked against a real build |

## Assets

| Area | Status | How |
|---|---|---|
| Client chunks and other static files | ✅ | Zones serves a zone's `/_next/static` from its own build, with each file's content type and `immutable` caching |
| CSS modules | ✅ `features.mjs` | Named in the route's client reference manifest |
| Global CSS, Tailwind | 🟡 | Global CSS comes from the shared root layout |
| `next/font` | ✅ `media.mjs` | The font CSS comes with the zone's CSS chunk; the font file is a zone static file; the preload `<link>` is emitted |
| `next/image` | ✅ `media.mjs` for local images; ⛔ refused ✅ for a zone's own `images` config | The optimizer fetches local images through Next's handler directly, so Zones hooks `fetchInternalImage`. It runs with the shell's `images` config, so a zone whose `remotePatterns`, `domains`, `localPatterns`, `unoptimized` or `dangerouslyAllow*` differ is refused (put them in the shell's config); checked against a real build |
| `public/` of a zone | ✅ `media.mjs` | Stored beside the build by `tools/build-zone.mjs`, served under the zone's mount ahead of dynamic routes, `max-age=0`. Files outside the mount are refused |
| `next/script` | 🟡 | Client side |

## Pages Router (`pages/`)

| Area | Status | How |
|---|---|---|
| A zone with `pages/` | 🔧 | Not supported yet; next-zones is App Router only. The Pages Router client keeps the build's page list (`_buildManifest.js`, `sortedPages`) and hard-navigates to any page it does not know. A zone's pages would need a merged `_buildManifest.js` served by Zones, plus `PAGES` matchers and a merged `pages-manifest` |

## Process and build

| Area | Status | How |
|---|---|---|
| `instrumentation.ts` | ✅ `instrumentation.mjs` | The shell's `register()` runs once, at boot, and its `onRequestError` runs for every zone. A zone's own `register()` runs when the zone is installed; its `onRequestError` runs for its routes only. `zones.config.json` holds the policy per zone: `shell.skip`, and `own: { name: false }` |
| `instrumentation-client.ts` | ⛔ refused ✅ | Bundled into a build's own documents: a zone reached from the shell would never run it. `tools/build-zone.mjs` records it in `zone.json`, and Zones refuses the zone, pointing to the shell's; checked against a real build |
| Environment variables | ✅ build-time; 🟡 runtime | `NEXT_PUBLIC_*` and `env` are inlined per zone build. `process.env` at run time is Zones' |
| Turbopack module ids | ✅ | Each version builds from `<zone>@<version>` (`tools/build-zone.mjs`). Shared modules keep their ids |
| Scope hoisting, unused exports and imports removal | ✅ off in builds for Zones, `context.mjs` | `zoneConfig` fills `turbopackScopeHoisting`, `turbopackRemoveUnusedExports`, `turbopackRemoveUnusedImports` with `false` in `next-zones build` only (the shell and the zone images, which both modes run), where unset; a zone's own different value stops that build with the reason, and Zones refuses a shell or image built without them. A hoisted or trimmed module differs per build, so a library's context would exist twice. Cost: JS +2–9% (debt D8). See docs/configuration.md, "Build options for Zones" |
| Several installs at once | ✅ `many.mjs` | Installs stage, seed and analyse in parallel; `prepare` and the switch take turns behind one queue, so a plan is always prepared from the state its switch replaces. 20 rounds of three concurrent installs under load: the versions served are the last installed, with no wrong answer |
| Swaps under load | ✅ `swapload.mjs` | 32 concurrent clients, 18 swaps and a rollback: 0 wrong answers. p95 76.8 ms during the swaps, against 88.1 ms before. Two versions rendering one route at once each read their own client reference manifest (Next keeps one per route, process-wide; Zones layers it per request): at 96 clients with the CPU loaded, about 17,000 requests and 54 swaps, no wrong answer (before: up to 136 errors a run) |
| A zone run alone, deployed on its own | ✅ `standalone.mjs` | A normal Next app: its pages, its own 404s, and its aliases, which `zoneConfig` adds to its rewrites unless it is built for Zones (`NEXT_ZONES_BUILD`, set by `next-zones build`). Links to other zones are links to another site there |
| `next dev` | ✅ `composed.mjs` | `next-zones dev`: the shell and every zone composed into one app on one `next dev`. HMR in zones and shared packages (an edit shows in 76–79 ms, with no reload), soft navigation between zones, one React. Each zone keeps its own path aliases (`@/*`), given to its files by a loader rule, since Next reads one tsconfig per app. An `env` key has one value across zones. `next-zones watch` rebuilds production builds into a running Zones service instead |
| `output: "export"` | ✅ both modes: `singleexport.mjs`, `zonesexport.mjs` | Mode `"single"`: one static site from every zone. Mode `"zones"`: each zone exported on its own (its own config says so), then linked into one static site (`.zones-export`): the same analysis as an install (clashing client module ids remapped, the zone's main chunk, the shell's build id in its payloads), done once. Both: a plain static server, soft navigation between zones in one document, also from a zone's page loaded directly. Rewrites, redirects, headers and aliases do not apply to an export, as in Next |
| `output: "standalone"` | ✅ both modes: `singlestandalone.mjs`, `zonesstandalone.mjs` | Mode `"single"`: the standalone folder, copied out of the workspace, serves every zone from its `server.js`. Mode `"zones"`: the shell's standalone folder is the whole deploy (`zones.js`, next-zones and what Zones needs of Next, traced with Next's own `@vercel/nft`, the shell's declaration, the images, the pins); a zone image whose config says `output: "standalone"` carries the packages its server traces need. Copied out of the workspace, `node zones.js` serves every zone, an external package from a zone's image included |
| Adapters API (`07-adapters`) | to study | Next 16's adapter and routing hooks may replace some of Zones' internal hooks with an official surface |

## Behaviours that are Next's, compared with the zone alone

These look like gaps, but a zone running alone with `next start` behaves the same. They are Next's, not Zones'.
They are kept here to see later whether next-zones should improve on them.
- **Direct load of a page that calls `notFound()`:**
  - 404, and the HTML contains the zone's `not-found.tsx` output, as alone;
  - the HTML also embeds the default not-found text in the RSC payload of the root boundary.
- **Direct load of a page that throws:**
  - 500, and the server HTML has no error-boundary output, as alone;
  - `error.tsx` is a client component, so it renders after hydration.
  - **A possible enhancement:** a server-rendered fallback for zone errors, so the first paint is not empty.
- **A route with `dynamicParams = false` asked for an unknown param:** Next logs `Error: Internal: NoFallbackError`,
  as alone.

## The store

| Area | Status | How |
|---|---|---|
| A build changed or copied in part after it was stored | ✅ refused, `integrity.mjs` | `zone.json` records a sha256 over every file at build time; Zones checks it in a worker before the first install of that build, and nothing changes on a refusal |
| One Next app from every zone (`mode: "single"`) | ✅ `single.mjs`, `singlestandalone.mjs`, `singleexport.mjs` | Linked from the same zone images Zones runs, not rebuilt: the shell's `.next` and every image linked into one (`.zones-app`, served by `next start`): each zone's routes under its mount, aliases, rules, prerendered pages, actions, fonts, public files, its own packages, and an instrumentation that runs as on Zones (zones.config.json's policy). Each zone keeps its own build, so its own `@/*`. Follows the shell's `output`: standalone (linked into the shell's standalone folder, traced with Next's `@vercel/nft`, runs copied anywhere) and export (`.zones-export`) |
| A zone image enters the store by a pull only | ✅ `pull.mjs`, `endpoints.mjs`, `test/store.test.mjs` | From Zones' sources (`fromHttp`, `fromDirectory`, or one's own), streamed into a folder beside the store, checked (zone, version, integrity), then moved in by one rename; refused otherwise, store unchanged. No endpoint takes an image: `PUT` answers 405 |
| Pulls on a ping (live pulls) | ✅ `pull.mjs` | Only for a zone with `zoneConfig({ livePull: true })`, read from its latest stored image before anything is fetched; the pulled image must declare it too. A zone's first image is pulled server side (`next-zones pull`) |
| Pulling an image of hundreds of MB | ✅ `tools/bench/pull.mjs` | Unpacked as it arrives (a streaming tar reader): peak memory does not grow with the image. 300 MB image (180 MB packed): 154 MB peak RSS and 3.1 s, against 756 MB and 7.0 s when the archive was held in memory; 600 MB: 164 MB, 6.8 s |
| Images as .zip, and a repository's archive of a tag | ✅ `test/transfer.test.mjs` | Told from .tgz by the first bytes; spooled to disk, read from the central directory one file at a time, each CRC-32 checked; one top-level folder unwrapped (`git archive --prefix`); Zip64 refused. 300 MB: 176 MB peak RSS |
| A pull over a shared link: stalls, dropped connections | ✅ `test/transfer.test.mjs` | `stallMs` (30 s, network waits only), resumed with `Range` and `If-Range` up to `retries` (3); a server that cannot resume fails the pull |
| service-connector as the source | ✅ `test/transfer.test.mjs` (against its documented API) | `fromConnector`: `GET /api/connector/images/zones/<owner>/<zone>@<version>` with a bearer token; refusals carry their reason |
| The disk during a pull | ✅ `test/store.test.mjs` | `minFree` (1 GiB) left free: the size is estimated from the zone's latest image, the store pruned when short, the pull refused if it still does not fit; the free space is read every 250 ms while it runs, and the pull stops below `minFree`, leaving nothing behind |
| Pruning old zone images | ✅ `prune.mjs`, `test/store.test.mjs` | Keeps the active, pinned and `keep` previous versions (install history in `state.json`), images pulled and not installed yet, images being installed; an image whose loaded code other versions share is held until a restart (D9). Its caches go with it unless a kept image has the same build id. After every pull and install, at boot, and on request; `next-zones prune` on a store no Zones runs on |
| What a zone image holds | ✅ | What serving needs: no build cache, traces or generated types (test blog: 64 → 18 MB, 3.5 MB packed) |
| What an install reads | ✅ one file | `zone.json` holds what Zones needs (`src/zones/describe.cjs`), read asynchronously: 0.15–1.55 ms on the main thread |

## The upgrade rule

Zones reaches into Next's internals. Every row marked ✅ is a script under `spikes/zones/`, and
`node check-all.mjs` runs them all on fresh Zones services. `tools/upgrade-guard.mjs <version>` runs them all on another Next,
installed from scratch; once they pass, the version joins `SUPPORTED` in `src/zones/next-contract.cjs`. Zones refuses
to start on any other version, and on any Next where a module or function it hooks has moved, listing what moved.
