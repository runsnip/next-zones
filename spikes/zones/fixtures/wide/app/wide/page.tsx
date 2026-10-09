import { stamp } from "@spike/shared/server";
import { ContextLabel } from "./label";
import { Many } from "./many/index.js";

export default function WidePage() {
  return <section><h1 id="title">zone wide</h1><p id="stamp">shared server module evaluation {stamp()}</p><ContextLabel /><Many /></section>;
}
