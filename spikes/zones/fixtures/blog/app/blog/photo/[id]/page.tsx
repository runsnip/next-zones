export default async function Photo({ params }: { params: Promise<{ id: string }> }) {
  return <h1 id="title">zone blog photo {(await params).id}</h1>;
}
