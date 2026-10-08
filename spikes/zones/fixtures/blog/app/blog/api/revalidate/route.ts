import { revalidatePath, revalidateTag } from "next/cache";

/* Revalidates from the blog: ?tag= for a tag, ?path= for a path (possibly another zone's). */
export async function POST(request: Request) {
  const url = new URL(request.url);
  const tag = url.searchParams.get("tag");
  const path = url.searchParams.get("path");
  if (tag) revalidateTag(tag, "max");
  if (path) revalidatePath(path);
  return Response.json({ from: "blog", tag, path });
}
