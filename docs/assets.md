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
that a zone needs in the shell's config. A zone that sets no `images` config fits any shell. A key a zone sets of its own
(not left at Next's default; set to Next's default, it counts as unset) and that differs from the shell's is refused at install today; zone-level image config is
planned.

## Public files

A zone's `public/` files must live **under its mount**:

```
blog/public/blog/logo.png     → served at /blog/logo.png   ✓
blog/public/favicon.ico       → refused: outside the zone's mount
```

The root (`/favicon.ico`, `/robots.txt`…) belongs to the shell. A public file takes precedence over a dynamic route
at the same URL, as in Next.

Zones serves a zone's public files itself, before Next sees the request, the same way behind any front proxy:

- **Precompressed siblings.** A file with a `.br` or `.gz` next to it (`fonts/a.ttf` and `fonts/a.ttf.br`) is sent as
  that sibling when the request's `Accept-Encoding` allows it (q-values read; brotli first on a tie), with
  `Content-Encoding`, the original's `Content-Type`, the sibling's `Content-Length`, and `Vary: Accept-Encoding` on
  every answer for that file. A sibling is only ever sent for a file that exists; asked for by its own name
  (`a.ttf.br`), it is an ordinary file. Compress at build time, as hard as you like (`brotli -q 11`): nothing is
  compressed while serving.
- **Ranges.** A single byte range of the file as it is (`206`, `If-Range` honoured, `416` when unsatisfiable). A
  `Range` request is never answered from a sibling: a range of brotli bytes is of no use to a client that asked for a
  part of the file, and the server picks the representation (RFC 9110), so it gets the identity one. Several ranges
  get the whole file.
- **Validators.** A strong `ETag` per representation (the brotli answer's differs from the plain one's) and
  `Last-Modified`; `If-None-Match`, else `If-Modified-Since`, answers `304`. `HEAD` answers the same headers as `GET`.
- **Caching.** `Cache-Control: public, max-age=0` (Next's default for `public/`), unless the URL names the file by its
  content: `?h=<hash>` or `?v=<hash>`, a hex value of 8 or more characters or a base64url one of 16 or more. Those
  are served `public, max-age=31536000, immutable`. The parameter names are the zone's
  [`hashQuery`](configuration.md#zone) (`false`: never).

A front proxy that compresses on its own must leave an answer that already has `Content-Encoding` alone: Caddy's
`encode` and nginx's `gzip` both do.
