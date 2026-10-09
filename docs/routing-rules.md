# Routing rules: a zone's headers, redirects and rewrites

A zone keeps its own `headers()`, `redirects()` and `rewrites()` in its `next.config`, as any Next app does. They apply
when the zone runs alone and when it is served together with other zones.

```js
export default zoneConfig({
  mount: "/blog",
  async headers() {
    return [{ source: "/blog/api/:path*", headers: [{ key: "x-zone", value: "blog" }] }];
  },
  async redirects() {
    return [{ source: "/blog/old/:id", destination: "/blog/:id", permanent: true }];
  },
  async rewrites() {
    return {
      beforeFiles: [{ source: "/blog/b/:id", destination: "/blog/:id" }],
      afterFiles: [{ source: "/blog/a/:id", destination: "/blog/:id" }],
      fallback: [{ source: "/blog/f/:path*", destination: "/blog/docs/:path*" }],
    };
  },
});
```

## What applies

Everything Next supports in these rules:
- parameters (`:id`, `:path*`);
- `has` and `missing` conditions;
- permanent (308) and temporary (307) redirects;
- rewrites before files, after files and as a fallback.

They keep Next's order: headers and redirects run before the shell's `proxy.ts`; rewrites run after it.

Intercepting routes (`(.)photo`, `(..)photo`) work too, since Next turns them into rewrites.

## Rules

- **Every `source` must be under the zone's mount, or under one of its [aliases](aliases.md).** A rule anywhere else
  would change URLs the zone does not own, so the zone is refused at install.
- **A `destination` may point anywhere,** another zone's route included.
- **When a new version of the zone is installed, its rules replace the old version's,** as one step with the rest of
  the zone.
