import Link from "next/link";
import { connection } from "next/server";

/* A dynamic page of server components only: no entry of its own in the client reference manifest (zonecss.mjs). */
export default async function Plain() {
  await connection();
  return <section><h1 id="title">zone wide plain</h1><p id="wide-styled">wide styled</p><Link href="/about" id="to-about" prefetch={false}>about</Link></section>;
}
