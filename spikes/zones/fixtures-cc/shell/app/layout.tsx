import Link from "next/link";
import { Counter } from "./counter";

/* The Cache Components shell's root layout, re-exported by its zone. */
export default function Root({ children }: { children: React.ReactNode }) {
  return (
    <html lang="en">
      <body>
        <nav><Link href="/">home</Link> · <Link href="/notes" id="to-notes">notes</Link></nav>
        <Counter />
        <main>{children}</main>
      </body>
    </html>
  );
}
