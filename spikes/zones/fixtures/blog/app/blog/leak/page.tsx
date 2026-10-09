import { secretCheck } from "./secret";
import { LeakButton } from "./button";

export const dynamic = "force-dynamic";

/* A page that uses server-only code and a non-public env variable, and sends only a yes or no (leak.mjs). */
export default function LeakPage() {
  return <section><h1 id="title">zone blog leak</h1><p id="leak">{secretCheck(process.env.NZ_LEAK_SECRET ?? "") ? "match" : "no match"}</p><LeakButton /></section>;
}
