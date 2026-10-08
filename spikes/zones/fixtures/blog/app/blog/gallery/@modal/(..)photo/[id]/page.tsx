export default async function PhotoModal({ params }: { params: Promise<{ id: string }> }) {
  return <div id="modal">zone blog modal photo {(await params).id}</div>;
}
