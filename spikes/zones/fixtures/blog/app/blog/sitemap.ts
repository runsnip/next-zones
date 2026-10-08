import type { MetadataRoute } from "next";

/* The zone's own sitemap, at /blog/sitemap.xml. The root /sitemap.xml is the shell's. */
export default function sitemap(): MetadataRoute.Sitemap {
  return [{ url: "https://example.com/blog" }, { url: "https://example.com/blog/1" }];
}
