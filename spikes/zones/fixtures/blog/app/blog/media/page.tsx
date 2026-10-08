import localFont from "next/font/local";
import Image from "next/image";
import hero from "./hero.png";

const zoneFont = localFont({ src: "./fonts/geist-latin.woff2" });

/* The zone's assets: its own font (next/font), an imported image and a public/ image through next/image, and the
   public/ image as a plain <img>. Its public files live under its mount (public/blog/…). */
export default function Media() {
  return (
    <section>
      <h1 id="title" className={zoneFont.className}>zone blog media</h1>
      <Image id="static-img" src={hero} alt="hero" />
      <Image id="public-img" src="/blog/logo.png" width={64} height={64} alt="logo" />
      {/* eslint-disable-next-line @next/next/no-img-element -- a raw public file, served by Zones, is what this page checks */}
      <img id="raw-public" src="/blog/logo.png" alt="raw logo" />
    </section>
  );
}
