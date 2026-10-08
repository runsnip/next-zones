import { connection } from "next/server";

/* Throws on every request, so the instrumentation's onRequestError runs. */
export default async function Boom(): Promise<never> {
  await connection();
  throw new Error("boom");
}
