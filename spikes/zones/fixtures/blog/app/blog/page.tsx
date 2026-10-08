import Link from "next/link";
import { stamp } from "@spike/shared/server";
import { Badge } from "@spike/shared/badge";
import { Editor } from "@/editor";
import { AwaitedView } from "./awaited-view";

export default function BlogPage() {
  return <section><h1 id="title">zone blog v{process.env.ZONE_VERSION}</h1><p id="stamp">shared server module evaluation {stamp()}</p><Badge label="blog" /><Editor /><AwaitedView /><Link href="/shop" id="blog-to-shop">to the shop zone</Link></section>;
}
