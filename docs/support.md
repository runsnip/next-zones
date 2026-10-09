# What is supported

Next.js 16.3.6, 16.3.7, 16.3.8 and 16.4.0, App Router. Key:
- ✅ works: verified in a browser or over HTTP;
- 🟡 expected to work: not verified yet;
- 🔧 planned: not done yet; where it would otherwise fail silently, refused at install until it is;
- ⛔ not possible for a zone, and refused at install so it never fails silently.

## Routing

| | |
|---|---|
| `page`, `layout`, dynamic routes, catch-all, optional catch-all, route groups, parallel routes | ✅ |
| `loading` (streaming), `error`, `not-found` | ✅ |
| Intercepting routes (modals) | ✅ |
| Route handlers (`route.ts`) | ✅ |
| A zone's metadata routes (`/blog/sitemap.xml`, `/blog/opengraph-image`) | ✅ (the root `/sitemap.xml` and `/robots.txt` are the shell's) |
| Mounts and [aliases](aliases.md) | ✅ |
| The shell's `proxy.ts` in front of every zone | ✅ |
| A zone's own `proxy.ts` | ⛔ (move its logic into the shell's proxy) |
| A zone's `headers`, `redirects`, `rewrites` (see [routing rules](routing-rules.md)) | ✅ |
| `basePath`, `i18n`, `trailingSlash`, `assetPrefix`, `skipTrailingSlashRedirect`, `cacheComponents`, `partialPrefetching` different from the shell's | ⛔ |

## Navigation

| | |
|---|---|
| `<Link>` shell ↔ zone and zone ↔ zone, Back/Forward, prefetch | ✅ soft, state kept |
| `useRouter`, `usePathname`, `useParams`, `useSearchParams`, `router.push` into another zone | ✅ |
| `redirect()` into another zone, `notFound()` | ✅ |
| `permanentRedirect`, `forbidden`, `unauthorized` | 🟡 |
| New client code after a version swap, even for a page an open tab has cached | ✅ (with [`<ZoneUpdates />`](updates.md)) |
| A shared package at different versions in different zones, in one page | ✅ each zone runs its own version ([concepts](concepts.md#the-contract-between-zones)) |

## Rendering and data

| | |
|---|---|
| Server and client components, one React | ✅ |
| Server actions (with bound arguments) | ✅ |
| Prerendered pages, ISR, `generateStaticParams` (with `dynamicParams` and fallback) | ✅ |
| `revalidateTag` and `revalidatePath` across zones, `unstable_cache` | ✅ |
| `cookies`, `headers`, `connection` | ✅ |
| `'use cache'`, `cacheTag`, `cacheLife`, Cache Components / PPR | ✅ (`cacheComponents` must be the same in the shell and every zone) |
| Edge runtime in a zone | 🔧 refused at install today (use the Node.js runtime) |

## Assets

| | |
|---|---|
| Client chunks, CSS modules | ✅ |
| `next/font` | ✅ |
| `next/image` with local images (imported, or from the zone's `public/`) | ✅ |
| A zone's own `images` config (remote patterns…) that differs from the shell's | 🔧 refused at install today (put it in the shell's config, which serves every zone). A zone with no `images` config, or the shell's, installs |
| A zone's `public/` files, under its mount | ✅ (see [assets](assets.md)) |

## Process

| | |
|---|---|
| [Instrumentation](instrumentation.md), the shell's and each zone's | ✅ |
| A zone's `instrumentation-client.ts` | ⛔ (put it in the shell) |
| A zone's dependencies (`serverExternalPackages` included), wherever its build is stored | ✅ (they resolve from the shell's `node_modules`) |
| A package only in a zone's own `node_modules` (not hoisted by the workspace) | ✅ bundled into the zone's build; 🟡 as a `serverExternalPackages` entry, which must be in the shell's `node_modules` |
| Zones built with a different Next or React than the server's | ⛔ |
| Many requests at once across zones, several installs at once, and swaps under load | ✅ |
| A shell with its own `cacheHandler` (a remote cache) | ✅ (it keeps every key but the zones' pages, which stay per version) |
| A zone run alone (`next start`, `next dev`), with its aliases | ✅ ([running alone](configuration.md#running-a-zone-alone)) |
| `next dev` across zones | ✅ [`next-zones dev`](cli.md#next-zones-dev): HMR and soft navigation, every zone at once |
| Pages Router (`pages/`) in a zone | 🔧 refused at install today (Next's own `/404` and `/500` aside): use `app/` |
| `output: "export"` | ✅ both modes: one static site, soft navigation between zones ([build and start](cli.md#build-and-start)) |
| `output: "standalone"` | ✅ both modes: the folder alone is the deploy ([build and start](cli.md#build-and-start)) |

## Zone images

| | |
|---|---|
| Images entering the store by a pull from a source (HTTP, a folder, one's own), streamed and checked | ✅ ([zone images](zones.md#zone-images)) |
| Uploading an image to Zones | ⛔ by design: endpoints only ask Zones to pull |
| Pulls on a ping, for a zone with `livePull` | ✅ ([live pulls](zones.md#live-pulls)) |
| Images of hundreds of MB | ✅ streamed: memory does not grow with the image |
| Images as `.zip`, and a repository's archive of a tag (one top-level folder) | ✅ |
| Pulls over a shared link: stalls and dropped connections resumed with `Range` | ✅ |
| service-connector as the source (`fromConnector`) | ✅ against its documented API |
| A pull that would fill the disk | ✅ refused before it starts, or stopped while it runs ([the disk](zones.md#the-disk)) |
| Pruning old images, automatically or on request | ✅ ([pruning](zones.md#pruning)) |

## One app

| | |
|---|---|
| Every zone built into one Next app (`mode: "single"`), served by `next start` | ✅ ([build and start](cli.md#build-and-start)) |
| Each zone's own `@/*` and its types, in that one app | ✅ (types checked per zone, with its own `tsconfig`) |
| Instrumentation in that one app | ✅ as on Zones: the shell's for every route, each zone's for its own |
| Installing a zone into it while it runs | ⛔ by design: that is what images and Zones are for |
