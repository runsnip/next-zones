"use server";

/* A server action of the zone: its id lives in the zone's server-reference-manifest, not the shell's. */
export async function shout(text: string) {
  return `${text.toUpperCase()} (from the zone's action)`;
}
