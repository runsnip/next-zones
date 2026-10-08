import { stamp } from "@spike/shared/server";

export const dynamic = "force-dynamic";

/* A dynamic shell page: renders per request, so the shared server module runs in the shell's runtime. */
export default function About() {
  return <h1 id="title">shell about <span id="stamp">{stamp()}</span></h1>;
}
