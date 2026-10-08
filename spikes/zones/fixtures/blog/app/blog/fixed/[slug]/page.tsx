/* dynamicParams = false: only the generated slugs exist; any other answers 404. */
export const dynamicParams = false;

export function generateStaticParams() {
  return [{ slug: "one" }];
}

export default async function Fixed({ params }: { params: Promise<{ slug: string }> }) {
  const { slug } = await params;
  return <h1 id="title">zone blog fixed {slug}</h1>;
}
