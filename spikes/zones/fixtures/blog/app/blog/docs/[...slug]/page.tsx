export default async function Docs({ params }: { params: Promise<{ slug: string[] }> }) {
  return <h1 id="title">zone blog docs {(await params).slug.join("/")}</h1>;
}
