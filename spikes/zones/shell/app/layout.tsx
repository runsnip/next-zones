import Link from "next/link";
import { ZoneUpdates } from "@runsnip/next-zones/client";
import { Counter } from "./counter";
import { LabelProvider } from "@spike/shared/context";

/* The shell: its layout and a piece of client state that must survive a soft navigation into a zone. */
export default function Root({ children }: { children: React.ReactNode }) {
  return (
    <html lang="en">
      <body>
        <nav><Link href="/">home</Link> · <Link href="/blog" id="to-blog">blog</Link> · <Link href="/blog/42" id="to-item">item 42</Link> · <Link href="/shop" id="to-shop">shop</Link> · <Link href="/blog/private" id="to-private">private</Link> · <Link href="/post/7" id="to-alias">post 7</Link> · <Link href="/blog/media" id="to-media">media</Link> · <Link href="/blog/slow" id="to-slow">slow</Link> · <Link href="/blog/broken" id="to-broken">broken</Link> · <Link href="/blog/missing" id="to-missing">missing</Link> · <Link href="/blog/go" id="to-go">go</Link> · <Link href="/blog/hooks/5?q=x" id="to-hooks">hooks</Link> · <Link href="/blog/docs/a/b" id="to-docs">docs</Link> · <Link href="/blog/ctx" id="to-ctx">context</Link></nav>
        <Counter />
        <ZoneUpdates />
        <main><LabelProvider value="root">{children}</LabelProvider></main>
      </body>
    </html>
  );
}
