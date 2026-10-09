# next-zones

**Zones for Next.js.** Build each part of a product as its own Next app, a *zone*, with its own version. Serve them as
one app: one origin, soft navigation between zones' App Router pages, one React. A new version of a zone can be loaded into the running
server without a restart.

> **Status: pre-release.** It targets Next.js **16.4.0** and **16.3.8** (and 16.3.6, 16.3.7), App Router and Pages Router, production server.
> - **Available:**
>   - the zone declaration (`zoneConfig`);
>   - the CLI: `init`, `add`, `check`, `doctor`, `dev`, `build`, `start`, `serve`, `install`, `pack`, `pull`, `prune`,
>     `watch`;
>   - Zones (`createZones`), which installs and swaps zones at run time;
>   - one combined build of every zone (`mode: "single"`, the composer);
>   - `<ZoneUpdates />`;
>   - metrics: Zones' own and any zone's, as Prometheus text (`@runsnip/next-zones/metrics`).

## Why

Next.js has [Multi-Zones](https://nextjs.org/docs/app/guides/multi-zones):
- every zone is a separate server;
- moving between zones reloads the page and drops client state.

next-zones keeps the separation (each zone builds, versions and deploys on its own) without those costs:

| | Next Multi-Zones | next-zones |
|---|---|---|
| Moving between zones | hard navigation | **soft** `<Link>` navigation between App Router pages; client state kept |
| Servers | one per zone | **one** for all zones |
| A module shared by zones | loaded once per zone | loaded **once** |
| Releasing a zone | redeploy its server | **install it live**, roll back in milliseconds |

## Pages

1. [Concepts](concepts.md): zones, the shell, mounts, aliases, versions
2. [Getting started](getting-started.md)
3. [Configuration: `zoneConfig`](configuration.md)
4. [CLI](cli.md): every command
5. [Root URLs: aliases](aliases.md)
6. [Routing rules: a zone's headers, redirects and rewrites](routing-rules.md)
7. [Instrumentation](instrumentation.md)
8. [Assets: fonts, images, public files](assets.md)
9. [Live updates and requirements](updates.md)
10. [Zones: live installs](zones.md)
11. [Metrics](metrics.md)
12. [Zones on the Pages Router](pages-router.md)
13. [What is supported](support.md)

## For assistants

The package ships `llms.txt` (the essentials) and `llms-full.txt` (every page above in one file), and a skill for
coding assistants, `skills/next-zones/SKILL.md`: copy its folder into a project's skills folder (for Claude Code,
`.claude/skills/`) so an assistant reads those files before it answers.

## License

Apache-2.0.
