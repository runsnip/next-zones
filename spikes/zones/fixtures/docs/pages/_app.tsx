import type { AppProps } from "next/app";
import Link from "next/link";
import { useState } from "react";
import { ZoneUpdates } from "@runsnip/next-zones/client";

/* The zone's own _app: a counter that lives across soft navigations inside the zone, and <ZoneUpdates />, so an open
   tab's next navigation after a swap reaches the version installed. */
export default function App({ Component, pageProps }: AppProps) {
  const [count, setCount] = useState(0);
  return (
    <>
      <nav>
        <Link href="/docs" id="to-index">index</Link> <Link href="/docs/a" id="to-a">a</Link>{" "}
        <Link href="/docs/b" id="to-b">b</Link> <Link href="/docs/ssr" id="to-ssr">ssr</Link>{" "}
        <Link href="/docs/plain" id="to-plain">plain</Link> <Link href="/blog" id="to-blog">blog</Link>
        <button id="inc" onClick={() => setCount((n) => n + 1)}>count {count}</button>
      </nav>
      <p id="zone-version">docs {process.env.ZONE_VERSION}</p>
      <Component {...pageProps} />
      <ZoneUpdates />
    </>
  );
}
