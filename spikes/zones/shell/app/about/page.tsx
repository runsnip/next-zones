import { stamp } from "@spike/shared/server";
import { wrapped } from "@spike/shared/server-wrap";

export const dynamic = "force-dynamic";

/* A dynamic shell page: renders per request, so the shared server module runs in the shell's runtime. */
export default function About() {
  return <h1 id="title">shell about <span id="stamp">{stamp()}</span> <span id="wrapped">{wrapped()}</span></h1>;
}
