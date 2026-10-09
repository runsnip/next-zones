import type { GetStaticPaths, GetStaticProps } from "next";

export const getStaticPaths: GetStaticPaths = async () => ({ paths: [{ params: { slug: "a" } }], fallback: "blocking" });

export const getStaticProps: GetStaticProps = async ({ params }) =>
  params?.slug === "missing"
    ? { notFound: true }
    : { props: { slug: String(params?.slug), version: process.env.ZONE_VERSION ?? "" }, revalidate: 60 };

export default function Doc({ slug, version }: { slug: string; version: string }) {
  return <h1 id="title">doc {slug} {version}</h1>;
}
