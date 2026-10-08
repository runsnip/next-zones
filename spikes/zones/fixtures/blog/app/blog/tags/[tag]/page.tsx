/* generateStaticParams with dynamicParams (the default): "a" and "b" are prerendered at build; any other tag is
   rendered on its first request, then cached. */
export function generateStaticParams() {
  return [{ tag: "a" }, { tag: "b" }];
}

export default async function Tag({ params }: { params: Promise<{ tag: string }> }) {
  const { tag } = await params;
  return <section><h1 id="title">zone blog tag {tag}</h1><p id="at">{new Date().toISOString()}</p></section>;
}
