import { connection } from "next/server";

/* Streams: loading.tsx shows first, then the page after 800 ms. */
export default async function Slow() {
  await connection();
  await new Promise((r) => setTimeout(r, 800));
  return <h1 id="title">zone blog slow done</h1>;
}
