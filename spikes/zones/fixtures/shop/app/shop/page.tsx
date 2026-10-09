export const dynamic = "force-dynamic";
import { stamp } from "@spike/shared/server";
import { Badge } from "@spike/shared/badge";
import { wrapped } from "@spike/shared/server-wrap";
import Link from "next/link";
import { List } from "@/list";

export default function ShopPage() {
  return <section><h1 id="title">zone shop</h1><p id="stamp">shared server module evaluation {stamp()}</p><Badge label="shop" /><p id="wrapped">{wrapped()}</p><List /><Link href="/blog/42" id="shop-to-blog">to a blog post</Link></section>;
}
