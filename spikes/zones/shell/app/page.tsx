import { stamp } from "@spike/shared/server";
import { Badge } from "@spike/shared/badge";
import Link from "next/link";

export default function Home() {
  return <><h1 id="title">shell home</h1><p id="stamp">shared server module evaluation {stamp()}</p><Badge label="shell" /><Link href="/wide" id="to-wide" prefetch={false}>wide</Link></>;
}
