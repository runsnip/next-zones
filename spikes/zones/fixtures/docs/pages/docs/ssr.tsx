import type { GetServerSideProps } from "next";

export const getServerSideProps: GetServerSideProps = async ({ query }) => ({
  props: { version: process.env.ZONE_VERSION ?? "", q: String(query.q ?? "") },
});

export default function Ssr({ version, q }: { version: string; q: string }) {
  return <h1 id="title">ssr {version} {q}</h1>;
}
