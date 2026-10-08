import { revalidateTag } from "next/cache";

/* Expires the zone's "notes" tag at once. */
export async function POST() {
  revalidateTag("notes", { expire: 0 });
  return Response.json({ revalidated: "notes" });
}
