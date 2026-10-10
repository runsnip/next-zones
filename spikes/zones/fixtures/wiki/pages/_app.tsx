import type { AppProps } from "next/app";
import Link from "next/link";
import { ZoneUpdates } from "@runsnip/next-zones/client";

/* The zone's own _app, with <ZoneUpdates />: a tab on its pages follows a new version at once. */
export default function App({ Component, pageProps }: AppProps) {
  return (
    <>
      <p id="app">wiki app</p>
      <Link href="/docs" id="wiki-to-docs">docs</Link>
      <Component {...pageProps} />
      <ZoneUpdates />
    </>
  );
}
