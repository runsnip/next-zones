# Assets: fonts, images, public files

## Fonts

`next/font` works in a zone as it does in any app: the font is preloaded, and its CSS comes with the zone's styles.

```tsx
import localFont from "next/font/local";
const zoneFont = localFont({ src: "./fonts/my-font.woff2" });
```

## Images

`next/image` works with the zone's own local images:
- **imported images** (`import hero from "./hero.png"`);
- **files from the zone's `public/`** (`src="/blog/logo.png"`).

The image optimizer uses **the shell's** `images` settings: sizes, formats, remote patterns. Put remote patterns
that a zone needs in the shell's config, until zone-level image config is supported.

## Public files

A zone's `public/` files must live **under its mount**:

```
blog/public/blog/logo.png     → served at /blog/logo.png   ✓
blog/public/favicon.ico       → refused: outside the zone's mount
```

The root (`/favicon.ico`, `/robots.txt`…) belongs to the shell. A public file takes precedence over a dynamic route
at the same URL, as in Next.
