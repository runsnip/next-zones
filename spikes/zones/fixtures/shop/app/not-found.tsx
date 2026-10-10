import Link from "next/link";

/* The zone's own root not-found: it answers a URL under /shop that nothing serves, alone and under Zones. */
export default function NotFound() {
  return (
    <>
      <h1 id="title">shop not found {process.env.BADGE_VARIANT ?? "v1"}</h1>
      <Link id="nf-to-live" href="/shop/live">shop</Link>
    </>
  );
}
