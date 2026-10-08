import { headers } from "next/headers";

/* A zone page behind the shell's sign-in gate: reached only with a session, and it sees the shell proxy's header. */
export default async function Private() {
  const proxy = (await headers()).get("x-shell-proxy");
  return <section><h1 id="title">zone blog private</h1><p id="proxy">{proxy ?? "none"}</p></section>;
}
