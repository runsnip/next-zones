/* What one build inlines (shop v2 is built with BADGE_VARIANT): the dependency server-wrap.js reads. */
export function variant() {
  return process.env.BADGE_VARIANT ?? "base";
}
