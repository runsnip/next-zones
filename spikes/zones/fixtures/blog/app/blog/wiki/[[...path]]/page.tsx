export default async function Wiki({ params }: { params: Promise<{ path?: string[] }> }) {
  return <h1 id="title">zone blog wiki {(await params).path?.join("/") ?? "(root)"}</h1>;
}
