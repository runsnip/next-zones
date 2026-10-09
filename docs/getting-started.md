# Getting started

> Requires Next.js 16.3.6, 16.3.7, 16.3.8 or 16.4.0, App Router, and Node.js 24 or later.

## The quick way

```sh
npx @runsnip/next-zones init my-app blog shop     # a workspace: shared/, shell/, blog/, shop/, installed
cd my-app
npm run dev                                       # every zone on one next dev, with HMR: http://localhost:3000
npm run doctor                                    # checks the workspace for Zones and for dev
npx next-zones add docs                           # one more zone, at /docs
```

`init` uses the package manager that runs it (npm, yarn, pnpm or bun) and never overwrites a file. Every tsconfig
extends `@runsnip/next-zones/tsconfig/zone.json`, and each zone keeps its own `@/*` → `./src/*`. The steps below are
what it sets up, for a workspace made by hand.

## 1. A workspace of zones

One workspace (npm, yarn or pnpm), so every zone shares one `node_modules`:

```
my-app/
  package.json        workspaces: ["shared", "shell", "blog", "shop"]
  shared/             a package: the root layout, shared UI
  shell/              the zone mounted at "/"
  blog/               the zone mounted at "/blog"
  shop/               the zone mounted at "/shop"
```

```json
{
  "private": true,
  "workspaces": ["shared", "shell", "blog", "shop"],
  "dependencies": { "@runsnip/next-zones": "0.x" }
}
```

## 2. Declare each zone

Each zone's `next.config.mjs` (or `.ts`):

```js
// shell/next.config.mjs
import { zoneConfig } from "@runsnip/next-zones/config";

export default zoneConfig({
  mount: "/",
  transpilePackages: ["shared"],
});
```

```js
// blog/next.config.mjs
import { zoneConfig } from "@runsnip/next-zones/config";

export default zoneConfig({
  mount: "/blog",
  transpilePackages: ["shared"],
});
```

Every route of `blog` lives under `blog/app/blog/…`.

## 3. Share the root layout

Every zone renders the same root layout, so a page looks the same however it is reached:

```tsx
// shared/root-layout.tsx
import Link from "next/link";

export function RootLayout({ children }: { children: React.ReactNode }) {
  return (
    <html lang="en">
      <body>
        <nav><Link href="/">Home</Link> <Link href="/blog">Blog</Link> <Link href="/shop">Shop</Link></nav>
        <main>{children}</main>
      </body>
    </html>
  );
}
```

```tsx
// blog/app/layout.tsx (the same in every zone)
import { RootLayout } from "shared/root-layout";
export default RootLayout;
```

## 4. Follow new versions in open tabs

In the shell's root layout, render [`<ZoneUpdates />`](updates.md) once. Open tabs then pick up a newly installed
zone image on their next navigation.

## 5. Check the workspace

```sh
npx next-zones check .
```

```
✓ /            shell
✓ /blog        blog
✓ /shop        shop
```

It fails if two zones claim one mount, if no zone owns `/`, or if an alias collides. Run it before every build.

## 6. Build and run

Give each zone a `version` in its `package.json`, then:

```sh
next-zones build          # the shell as an app, blog and shop as images, zones.json pinning their versions
next-zones start          # Zones on port 3000: the shell, with blog and shop installed
```

- **Releasing a zone** is bumping its version, building its image, and installing it on the running Zones:
  `next-zones build blog`, then `next-zones install blog 1.1.0`. See [build and start](cli.md#build-and-start).
- **Each zone still runs on its own** with `next build` and `next start`.
- **One Next app instead:** declare `mode: "single"` in the shell's `zoneConfig`; `next-zones build` then builds the
  workspace as one app, and `next-zones start` runs it with `next start`. No images, no live installs.
