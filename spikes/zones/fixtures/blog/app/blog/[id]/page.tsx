import { revalidatePath } from "next/cache";
import { headers } from "next/headers";
import { stamp } from "@spike/shared/server";

let last = "";

/* A dynamic route of the zone, never prerendered: rendered per request from the zone's build. Its inline server
   action closes over `id`, so the bound argument travels encrypted and must be decrypted with the same key. */
export default async function BlogItem({ params }: { params: Promise<{ id: string }> }) {
  const { id } = await params;
  const proxy = (await headers()).get("x-shell-proxy");
  async function remember() {
    "use server";
    last = `remembered ${id}`;
    revalidatePath(`/blog/${id}`);
  }
  return (
    <section>
      <h1 id="title">zone blog item {id}</h1>
      <p id="stamp">{stamp()}</p>
      <p id="proxy">{proxy ?? "none"}</p>
      <form action={remember}><button id="remember">remember</button></form>
      <p id="last">{last}</p>
    </section>
  );
}
