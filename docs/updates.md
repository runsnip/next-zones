# Live updates and requirements

## `<ZoneUpdates />`: open tabs follow a new version

The shell declares the events endpoint (Zones serves no URL unless declared, see [endpoints](zones.md#endpoints)):

```js
export default zoneConfig({ mount: "/", endpoints: { events: true } });
```

Then render it once, in the shell's root layout. With another `endpoints.base`, pass
`<ZoneUpdates endpoint="<base>/events" />`:

```tsx
import { ZoneUpdates } from "@runsnip/next-zones/client";

export default function RootLayout({ children }: { children: React.ReactNode }) {
  return (
    <html lang="en">
      <body>
        {children}
        <ZoneUpdates />
      </body>
    </html>
  );
}
```

Importing `@runsnip/next-zones/client` in the shell also gives the shell's browser runtime every feature a zone's code
may use. Each build's Turbopack runtime holds only what that build uses, and a document runs the shell's: a zone with a
top-level await in a client module needs the runtime's async-module support there. Zones refuses a zone whose code uses
something the shell's runtime lacks, and names it.

When Zones installs a new version of any zone, it tells every open tab. The tab refreshes its router, so it drops
the pages it had cached, and its next navigation shows the new version, its client code included. Nothing reloads, and
client state is kept.

Without it, a tab still gets new versions of dynamic pages at once. A static page it has already visited may keep its
old version until the router's stale time (5 minutes by default) or a `router.refresh()`.

When a zone runs alone, or the events endpoint is not declared, there is no event stream and `<ZoneUpdates />` does
nothing.

## Requirements

- **Next.js 16.3.6, App Router.**
- **Every zone is built with the same Next, React and react-dom as the server that runs them.** The build records
  their versions, and a zone built with others is refused at install.
- **One workspace.** The zones and the shell share one `node_modules`. A zone's dependencies, its
  `serverExternalPackages` included, resolve from the shell's `node_modules` when it is served, wherever its build is
  stored. A package the workspace did not hoist, in the zone's own `node_modules`, is bundled into its build:
  `next-zones build` resolves it as the zone does. An external package (`serverExternalPackages`) is not bundled, so
  it must be in the shell's `node_modules`.
- **The same `basePath`, `i18n`, `trailingSlash`, `assetPrefix` and `cacheComponents`** as the shell's.
