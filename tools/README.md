# tools

Tools for developing next-zones itself. The CLI for users is in `src/` (`next-zones check`).

| Tool | What it does |
|---|---|
| `build-zone.mjs <zones dir> <zone> <version> [--store <dir>]` | Builds one version of a zone into a zone store: the build, plus `zone.json` (name, version, mount, aliases). It builds from `<zone>@<version>`, so each version gets module ids of its own |
| `bench/activation.mjs [--url URL] [--runs N] [--pad N] [--dynamic N] [--lru N]` | Activation benchmark on a running Zones service: `prepare` and the switch, phase by phase, at a given app size |
| `bench/latency.mjs [--url URL] [--paths a,b] [--n N] [--warmup N]` | Request latency through a running Zones service, p50 / p95 / p99 |

## How benchmarks are run and reported

- **Start a fresh Zones for each run.** The activation benchmark leaves its padding in the process.
- **Run each comparison at least twice**, and report both runs. Differences inside the spread between runs are noise.
- **Every report states its method:**
  - the machine, Node and Next versions;
  - the inputs (routes, dynamic routes, cached misses, runs);
  - the unit.

  The benchmarks print it with their results.
- **The current numbers live in** `spikes/zones/RESULTS.md` and in the README's debt ledger. Update them when a
  benchmark changes them.
