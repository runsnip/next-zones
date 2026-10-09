# Zones on the Pages Router

A zone may use the App Router, the Pages Router, or both, like any Next.js app. A zone on the Pages Router is built,
installed, swapped and rolled back like any other zone: in mode `"zones"` (live installs), in mode `"single"`, with
Next's `output: "standalone"`, and in `next-zones dev`.

## Its files

```
docs/
  next.config.mjs          zoneConfig({ mount: "/docs" })
  pages/
    _app.tsx               the zone's own (optional)
    _document.tsx          the zone's own (optional)
    docs/
      index.tsx            /docs
      [slug].tsx           /docs/a, /docs/b…
  public/docs/…            served at /docs/…
```

- **Every page lives under the mount**: `pages/docs/…` (or `pages/docs.tsx` for `/docs` itself). A page anywhere else
  (`pages/about.tsx`) is outside the mount and refused, as an `app/` route would be.
- **`_app`, `_document`, `_error`, `404` and `500`** sit at the top of `pages/`, as in any Next app. They are the zone's
  own: its pages render with them, never with another zone's.
- **`pages/api/`** is served at `/api/…`, which no zone but the shell owns: a zone's API routes are refused there. Write
  them as route handlers under the mount (`app/docs/api/…/route.ts`), which works in a Pages Router zone too (route
  handlers need no root layout; a path both `app/` and `pages/` define is refused by `next build` itself), or put them
  in the shell.
- **What every zone shares** (the navigation, the providers) comes in through its `_app`: a Pages Router page never
  renders the shell's App Router layout. Import the same shared components there.
- **The client runtime check** Zones runs on a zone's App Router code (the shell's runtime must have what it uses)
  does not apply to its Pages Router pages, which run on the zone's own runtime.

## How its pages are served

Next never shows a Pages Router page and an App Router page in one document: going from one to the other loads a new
document. So a Pages Router page renders whole in its own zone's build, as it would in that zone alone:

- **its own document**: the zone's `_document` and `_app`, its build id, its client runtime and chunks;
- **soft navigation inside the zone**: `<Link>` between the zone's Pages Router pages keeps its `_app`'s state, and
  each page's data comes from `/_next/data/<the zone's build id>/…`, which Zones answers;
- **between zones**: to the shell, to an App Router zone or to another Pages Router zone, the next page loads a new
  document (Next's own rule between the two routers, and two builds' Pages Router clients never share one);
- **data**: `getStaticProps` (prerendered, `revalidate`, `notFound`), `getStaticPaths` (checked with
  `fallback: "blocking"`), `getServerSideProps`, and static pages, as in Next. A prerendered page is served as built; a
  revalidated one is written to the version's cache, never into the zone image;
- **not found**: an unknown URL under the mount, and a page answering `notFound`, show the shell's not-found page
  (404), as for an App Router zone: the zone's own `404`, `500` and `_error` are used when it runs alone.

## Live installs

A new version of a Pages Router zone installs like any other. Its pages then render with the new build (its new build
id); requests for the old version's data are answered 404, and Next's client reloads the page from the server.

To make open tabs follow at once, render [`<ZoneUpdates />`](updates.md) in the zone's `_app`:

```tsx
// docs/pages/_app.tsx
import type { AppProps } from "next/app";
import { ZoneUpdates } from "@runsnip/next-zones/client";

export default function App({ Component, pageProps }: AppProps) {
  return (
    <>
      <Component {...pageProps} />
      <ZoneUpdates />
    </>
  );
}
```

After a swap, the tab's next navigation (a link, `router.push`, back or forward) loads a new document, which is the
version just installed. Nothing reloads before the user navigates. Without it, a page the tab prefetched before the
swap may show once more from the old version.

The static files of every version still in the store stay served, so a tab still on a replaced version keeps loading
its chunks.

## In the other modes

- **`mode: "single"`**: the zone's pages are linked into the one app, each rendering from its own build under
  `.next/zones/<zone>/`; going to another zone loads a new document, as under Zones. The app's `instrumentation.js` (which Next loads before any route renders) gets a few lines that
  make the Pages Router read a zone page's build id and build manifest from its zone's build.
- **`output: "standalone"`**: the packages a zone's server code leaves external (a Pages Router build leaves most of
  `node_modules` external) are traced into the standalone folder, with what they import.
- **`next-zones dev`**: one `next dev` serves the shell and every zone. Each zone's pages are re-exported into the
  composed app (a stub per page, so an edit to the page is seen at once, with HMR). With one `_app` (or `_document`)
  in the workspace it is used as it is; with several, each page renders with its own zone's, picked by the page's
  mount. Moving between two Pages Router zones is a soft navigation in dev (one app), a new document under Zones.

## Measured

Sequential requests after a warm-up (`tools/bench/latency.mjs`, 3000 per path, 300 warm-up), Node 24.16, Apple M1,
two alternating rounds (the two numbers), p50 in ms. The reference is the same pages in one app on `next start` with
the same shell, whose proxy runs on every request in both:

| Path | Zones | One app |
|---|---|---|
| `getServerSideProps` page | 0.98, 1.07 | 0.85, 0.99 |
| prerendered `getStaticProps` page | 0.69, 0.65 | 0.58, 0.60 |
| its `/_next/data/…` JSON | 0.44, 0.45 | 0.43, 0.39 |

Zones' own code is about 5% of the busy time in a CPU profile (`spikes/zones/RESULTS.md`, "The Pages Router").
