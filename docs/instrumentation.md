# Instrumentation

Next runs one `instrumentation.ts` per server. With zones there is one server and several apps, so next-zones
dispatches.

| | `register()` | `onRequestError()` |
|---|---|---|
| The shell's | once, when the server starts | for errors on **every** route, any zone's included (unless the policy skips a zone) |
| A zone's own | when that zone image is installed | for errors on **that zone's** routes only |

A zone never sees another zone's errors.

## The policy

`zones.config.json`, next to Zones:

```json
{
  "instrumentation": {
    "shell": { "skip": ["shop"] },
    "own": { "blog": false }
  }
}
```

- **`shell.skip`:** zones whose errors do not go to the shell's `onRequestError`.
- **`own`:** set a zone to `false` to turn off its own instrumentation. By default every zone's runs.

## Things to know

- **`register()` is process-wide.** All zones run in one Node process, so whatever a `register()` sets globally (an
  OpenTelemetry tracer provider, `process.on` handlers) affects every zone. Keep global setup in the shell, and let a
  zone's `register()` do only zone-scoped work.
- **Swapping a version.** Next has no "unregister". If a zone exports `unregister()`, next-zones calls it on the
  version being replaced, before the new version's `register()`.

> Available in Zones [preview](zones.md).
