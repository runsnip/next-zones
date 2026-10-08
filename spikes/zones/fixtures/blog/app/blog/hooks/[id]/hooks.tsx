"use client";
import { useParams, usePathname, useRouter, useSearchParams, useSelectedLayoutSegments } from "next/navigation";

/* The router hooks inside a zone: what they report, and router.push into another zone. */
export function Hooks() {
  const pathname = usePathname();
  const params = useParams();
  const search = useSearchParams();
  const segments = useSelectedLayoutSegments();
  const router = useRouter();
  return (
    <section>
      <h1 id="title">zone blog hooks</h1>
      <p id="hooks">{JSON.stringify({ pathname, id: params.id, q: search.get("q"), segments })}</p>
      <button id="push-shop" onClick={() => router.push("/shop")}>push to shop</button>
    </section>
  );
}
