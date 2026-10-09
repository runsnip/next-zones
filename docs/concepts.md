# Concepts

## Zone

A zone is a normal Next.js app (the App Router, the [Pages Router](pages-router.md), or both), so it builds with
`next build` and runs alone with `next start`. It
declares itself in its `next.config` with [`zoneConfig`](configuration.md). A zone never needs next-zones to run:
- **On its own**, it is just a Next app.
- **Together with other zones**, it is served by Zones, or built with them into one Next app (the composer).

## The shell

The shell is the zone mounted at `/`. There is no special flag: it is simply the owner of `/`. It holds what every
page shares:
- the root layout;
- sign-in and the proxy (`proxy.ts`);
- global instrumentation;
- every route that is not another zone's.

A set of zones has **exactly one** shell.

## Mount

Every zone other than the shell owns one URL segment, its *mount*, such as `/blog`. All of its routes live under it:
`/blog`, `/blog/[id]`, `/blog/settings`… A mount has one owner. Two zones on the same mount are refused, and so is a
zone on a segment the shell already serves.

## Alias

A zone can also serve a URL **at the root**, outside its mount, such as `/post/42` for its page `/blog/42`. That is an
[alias](aliases.md): the page still lives under the mount, and the address bar shows the root URL.

## Version

A version of a zone is **a build**, not a copy of its source. Zone images are kept in a *store* (one folder per zone
and version). Zones can switch between them, forwards or back, while the server runs.

## The contract between zones

Zones served together must share:
- **one `node_modules`:** the same Next, the same React, the same layout (a monorepo workspace does this);
- **the same root layout output:** in practice, every zone renders the same root layout component from a shared
  package;
- **the same `basePath`, `i18n`, `trailingSlash`, `assetPrefix`, `skipTrailingSlashRedirect`, `cacheComponents`,
  `partialPrefetching`** (Zones refuses a zone that differs, and names the key); and **no `images` key of a zone's own
  that differs from the shell's** (a zone with no `images` config fits any shell).

**Shared packages may differ in version between zones.**
- Modules that are the same in two zones are loaded once and shared.
- A module that differs (another version of a shared component, or anything that imports it) runs in its own version
  in each zone, side by side in the same page.
- **Mind the remount.** A shared component that differs between two zones is two different components to React, so it
  mounts again when the user moves between them. Keep the root layout and providers on the same version in every zone
  to keep their state across zones.

`zoneConfig` sets the build options next-zones needs (for example, Turbopack scope hoisting off, so a module shared
by zones loads once).
