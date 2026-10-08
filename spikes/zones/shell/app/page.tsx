import { stamp } from "@spike/shared/server";
import { Badge } from "@spike/shared/badge";

export default function Home() {
  return <><h1 id="title">shell home</h1><p id="stamp">shared server module evaluation {stamp()}</p><Badge label="shell" /></>;
}
