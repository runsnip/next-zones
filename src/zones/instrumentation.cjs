"use strict";
/*
 * Instrumentation: the shell's runs for every zone; each zone's own runs for its routes only, registered when the zone
 * is installed. The policy decides, per zone, whether the shell's onRequestError is skipped ("shell.skip") and whether
 * the zone's own runs ("own": { name: false }). register() effects are process-wide (one process), so global setup
 * belongs to the shell. Next has no unregister: a zone image may export unregister(), which Zones calls when that
 * version is replaced.
 */

function createInstrumentation(ctx) {
  const zoneInstrumentation = new Map();               // zone name → { module, version }
  const { interopDefault } = ctx.requireNext("next/dist/lib/interop-default");
  const shellRuns = (zone) => !zone || !(ctx.policy.instrumentation?.shell?.skip ?? []).includes(zone.name);
  const ownRuns = (zone) => ctx.policy.instrumentation?.own?.[zone.name] !== false;

  /** Runs the shell's handler (unless the policy skips it for this zone), then the zone's own. */
  async function dispatchRequestError(shellHandler, err, request, context) {
    const zone = ctx.zoneOfRoute(context?.routePath ?? request?.path);
    if (shellRuns(zone)) await shellHandler();
    const own = zone && ownRuns(zone) && zoneInstrumentation.get(zone.name)?.module;
    if (own?.onRequestError) {
      try { await own.onRequestError(err, request, context); }
      catch (error) { console.error(`Error in zone "${zone.name}" instrumentation.onRequestError:`, error); }
    }
  }

  /** Registers a zone image's own instrumentation (before the switch); unregisters the version it replaces. */
  async function registerZoneInstrumentation(staged) {
    const previous = zoneInstrumentation.get(staged.name);
    if (previous?.version === staged.version) return;
    await previous?.module?.unregister?.();
    zoneInstrumentation.delete(staged.name);
    if (!staged.instrumentationFile || !ownRuns(staged)) return;
    const module = interopDefault(await require(staged.instrumentationFile));
    await module?.register?.();
    zoneInstrumentation.set(staged.name, { module, version: staged.version });
  }

  return { dispatchRequestError, registerZoneInstrumentation };
}

module.exports = { createInstrumentation };
