"use server";
/* A server action: the browser gets its id, never its body (leak.mjs). */
export async function leakAction(input: string): Promise<number> {
  return ("nz-action-marker-91b2" + input).length;
}
