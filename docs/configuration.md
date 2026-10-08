# Configuration: `zoneConfig`

```ts
import { zoneConfig } from "@runsnip/next-zones/config";

export default zoneConfig(zone, nextConfig?);
```

## `zone`

| Field | Type | Required | Meaning |
|---|---|---|---|
| `mount` | `string` | yes | `"/"` for the shell, otherwise one URL segment such as `"/blog"` (lowercase letters, digits, `-`) |
| `aliases` | `{ source: string; destination: string }[]` | no | URLs at the root that this zone serves. See [aliases](aliases.md) |
| `endpoints` | `{ base?, events?, health?, admin? }` | no (the shell only) | The URLs Zones serves of its own, under `base` (`"/_next-zones"` by default); none unless declared. See [endpoints](zones.md#endpoints) |
| `mode` | `"zones"` \| `"single"` | no (the shell only), `"zones"` | How the workspace is served: `"zones"`, the shell as an app and every other zone as an [image](zones.md#zone-images) Zones installs while it runs; `"single"`, every zone in one Next app run by `next start`. See [build and start](cli.md#build-and-start). Next's own options, `output` included, go in the Next config (the second argument) |
| `livePull` | `boolean` | no, `false` | Whether a ping (an admin request to Zones' `<base>/images/<zone>/<version>/pull` or `/install`) may make Zones pull this zone's images from its sources. Recorded in each zone image's `zone.json`; read from the zone's latest image before anything is fetched. Without it, the zone's images are pulled on the server side only (`next-zones pull`, a deploy step). Images already in the store install either way. See [live pulls](zones.md#live-pulls) |

An invalid declaration throws as soon as `next.config` is loaded, for example: `mount must be "/" (the shell) or one
URL segment like "/blog"`.

## `nextConfig`

The zone's own Next config:
- an object;
- or a function of the phase, `(phase, { defaultConfig }) => config`, which may be async.

`zoneConfig` returns it with the build options below, the zone declaration (attached under a symbol that Next
ignores and next-zones reads back), and, when the zone runs alone, its aliases as rewrites. Everything else in your
config is passed through unchanged.

## Next's options are yours

`zoneConfig` passes the zone's Next config through as it is: next-zones never changes a Next option for you. `output`,
`images`, `experimental` and the rest mean what they mean in Next, in every mode.

## Build options for Zones

Zones runs zones that were built separately, sharing one instance of each module they have in common. That needs
three Turbopack options off in the builds Zones runs (the shell and every zone image). `zoneConfig` fills them in
**only in `next-zones build`** (the shell and every zone image, in both modes: `"single"` links the same images), and
**only where your config leaves them unset**. Anywhere else (a zone built alone with `next build`, `next-zones dev`)
nothing is filled in.

If your config sets one of them otherwise, a build for Zones stops with an error naming it, rather than overriding it.
Zones refuses a shell or a zone image that was built without them, and says to build it with `next-zones build`.

| Option | In a build for Zones | Why | Cost (measured) |
|---|---|---|---|
| `experimental.turbopackScopeHoisting` | `false` | Hoisting merges modules into one factory that writes other modules' exports. A module shared by several builds is loaded once, so no build may write into it | Server JS of the test shell +16% (520 → 604 KB); client JS unchanged |
| `experimental.turbopackRemoveUnusedExports` | `false` | Turbopack drops the exports a build does not use. A library used by the shell and a zone then differs between their builds: the shell's copy has only what the shell uses. They load as two modules, so a context it creates exists twice, and a zone's hook does not see the shell's provider (found with `@tanstack/react-query`: "No QueryClient set") | Two real apps: client JS +1.9% and +3.4%, server JS +8.6% and +4.4% |
| `experimental.turbopackRemoveUnusedImports` | `false` | Turbopack refuses to build with it on while unused exports are kept | Included above |

Mode `"single"` links the same zone images into one app, where a module several builds use is also loaded once, so it
needs them too. Debt D8 in the README tracks turning them back on (sharing modules by what they export, not by their
whole code).

## Running a zone alone

A zone is a normal Next app: it builds and runs on its own (`next build`, `next start`, `next dev`), and can be
deployed on its own domain. Alone, it serves its own routes, and `zoneConfig` adds its aliases to its own rewrites.
A build for Zones (`next-zones build`) leaves them out, because Zones serves them.

Links to the other apps are then links to another site: point them at where those apps live.

## Example

```js
import { zoneConfig } from "@runsnip/next-zones/config";

export default zoneConfig(
  { mount: "/blog", aliases: [{ source: "/post/:id", destination: "/blog/:id" }] },
  {
    transpilePackages: ["shared"],
    images: { remotePatterns: [{ hostname: "images.example.com" }] },
  },
);
```

## `readZone(dir)`

```ts
import { readZone } from "@runsnip/next-zones/config";

const zone = await readZone("./blog");   // { mount: "/blog", aliases: [...] }, or null if not a zone
```

It loads the app's `next.config.mjs`, `.js`, `.ts` or `.mts`, and returns its declaration. Tools use it: the CLI,
build scripts, Zones.
