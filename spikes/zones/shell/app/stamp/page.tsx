import { unstable_cache } from "next/cache";

export const revalidate = 3600;
const stamp = unstable_cache(async () => new Date().toISOString(), ["stamp"], { tags: ["stamp"] });

/* A shell page whose data is tagged "stamp", like the blog zone's /blog/stamp: a revalidation from either side must
   refresh both. */
export default async function Stamp() {
  return <section><h1 id="title">shell stamp</h1><p id="data">{await stamp()}</p></section>;
}
