import { unstable_cache } from "next/cache";

export const revalidate = 3600;
const stamp = unstable_cache(async () => new Date().toISOString(), ["blog-stamp"], { tags: ["stamp"] });

/* The zone's page with data tagged "stamp", shared with the shell's /stamp. */
export default async function BlogStamp() {
  return <section><h1 id="title">zone blog stamp</h1><p id="data">{await stamp()}</p></section>;
}
