/* Server-only code with a marker that must never reach a browser (leak.mjs): the page uses it to decide, and sends
   only the decision. */
const MARKER = "nz-server-marker-5c1e";

export function secretCheck(value: string): boolean {
  return value === MARKER + (process.env.NZ_LEAK_SECRET ?? "");
}
