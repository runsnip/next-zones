/* A server module shared by the shell and every zone: each evaluation is counted, process-wide. */
globalThis.__sharedServerEvals = (globalThis.__sharedServerEvals ?? 0) + 1;
const evaluation = globalThis.__sharedServerEvals;
const instance = {};

export function stamp() {
  return evaluation;
}
/* An object every importer should see as the same one: a module-level singleton (a DB pool, a cache…). */
export function singleton() {
  return instance;
}
