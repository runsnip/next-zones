import Link from "next/link";

/* The zone's own 404: a URL under /wiki that nothing serves, alone and under Zones. */
export default function NotFound() {
  return (
    <>
      <h1 id="title">wiki not found</h1>
      <Link id="to-wiki" href="/wiki">wiki</Link>
    </>
  );
}
