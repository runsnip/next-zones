import { connection } from "next/server";
import { hello } from "@spike/ext";

/* A zone page using a server external package: it must resolve wherever the zone's build is stored. */
export default async function Ext() {
  await connection();
  return <h1 id="title">zone blog ext {hello()}</h1>;
}
