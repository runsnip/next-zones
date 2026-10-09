/* A route handler in a zone on the Pages Router: the zone's API, under its mount. */
export const dynamic = "force-dynamic";

export function GET() {
  return Response.json({ zone: "docs", version: process.env.ZONE_VERSION ?? "" });
}
