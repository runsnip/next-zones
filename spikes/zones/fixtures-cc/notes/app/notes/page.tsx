import { Suspense } from "react";
import { cacheLife, cacheTag } from "next/cache";
import { cookies } from "next/headers";

/* Cache Components in a zone: a 'use cache' value tagged "notes" in the prerendered shell, and a dynamic hole
   (cookies) streamed in per request (PPR). */
async function cachedStamp() {
  "use cache";
  cacheTag("notes");
  cacheLife("hours");
  return new Date().toISOString();
}

async function Visitor() {
  const who = (await cookies()).get("who")?.value ?? "anonymous";
  return <p id="visitor">{who}</p>;
}

export default async function Notes() {
  return (
    <section>
      <h1 id="title">zone notes</h1>
      <p id="cached">{await cachedStamp()}</p>
      <Suspense fallback={<p id="pending">pending</p>}><Visitor /></Suspense>
    </section>
  );
}
