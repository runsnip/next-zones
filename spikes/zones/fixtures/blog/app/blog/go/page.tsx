import { redirect } from "next/navigation";
import { connection } from "next/server";

/* redirect() from a zone into another zone. */
export default async function Go(): Promise<never> {
  await connection();
  redirect("/shop");
}
