# Root URLs: aliases

A zone's routes live under its mount, but sometimes a URL must sit at the root: a short share link, a public profile,
a legacy address.

```js
export default zoneConfig({
  mount: "/blog",
  aliases: [{ source: "/post/:id", destination: "/blog/:id" }],
});
```

- `source` is the root URL. It must start with a fixed segment (`/post/…`) and can use the same parameters as Next's
  `rewrites` (`:id`, `:path*`).
- `destination` is the zone's own route, and must be under its mount.

## What the user sees

- `/post/42` renders the zone's `/blog/42`.
- The address bar keeps `/post/42`, and `<Link href="/post/42">` navigates softly.
- The shell's `proxy.ts` runs first, so a sign-in gate on `/post/…` applies.

## Rules

An alias is refused if:
- it points outside its zone's mount;
- it lies inside its own mount (use the route itself);
- its first segment is the shell's (for example `/about`), another zone's mount, or another zone's alias segment.

When a zone image without the alias is installed, the alias stops resolving.

> **Running a zone alone** (`next build`, `next start`, `next dev`): `zoneConfig` adds the aliases to the zone's own
> rewrites, so the zone answers them alone too. A build for Zones (`next-zones build`) leaves them out: Zones
> serves them.
