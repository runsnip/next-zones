import { connection } from "next/server";
import { List } from "../list";

/* A dynamic shop page with a client component, rendered per request: concurrent renders across zones. */
export default async function Live() {
  await connection();
  return <section><h1 id="title">zone shop live</h1><List /></section>;
}
