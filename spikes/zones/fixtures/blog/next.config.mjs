import { zoneConfig } from "@runsnip/next-zones/config";

/* One zone, several versions: ZONE_VERSION is inlined into server and client code, and a version above 1 also picks
   up the routes it adds (page.v2.tsx), so two builds differ the way two releases would. Its own headers, redirects
   and rewrites stay under its mount. */
const version = process.env.ZONE_VERSION ?? "1";

export default zoneConfig(
  { mount: "/blog", aliases: [{ source: "/post/:id", destination: "/blog/:id" }], livePull: true },
  {
    env: { ZONE_VERSION: version },
    serverExternalPackages: ["@spike/ext"],
    pageExtensions: version === "1" ? ["tsx", "ts"] : ["tsx", "ts", `v${version}.tsx`],
    async headers() {
      return [{ source: "/blog/api/:path*", headers: [{ key: "x-zone-header", value: "blog-:path*" }] }];
    },
    async redirects() {
      return [{ source: "/blog/old/:id", destination: "/blog/:id", permanent: true }];
    },
    async rewrites() {
      return {
        beforeFiles: [
          { source: "/blog/b4/:id", destination: "/blog/:id" },
          { source: "/blog/cond", has: [{ type: "query", key: "to", value: "shop" }], destination: "/shop" },
        ],
        afterFiles: [{ source: "/blog/af/:id", destination: "/blog/:id" }],
        fallback: [{ source: "/blog/fb/:path*", destination: "/blog/docs/:path*" }],
      };
    },
  },
);
