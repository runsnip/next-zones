import type { GetStaticProps } from "next";

export const getStaticProps: GetStaticProps = async () => ({ props: { built: `index ${process.env.ZONE_VERSION}` } });

export default function Index({ built }: { built: string }) {
  return <h1 id="title">{built}</h1>;
}
