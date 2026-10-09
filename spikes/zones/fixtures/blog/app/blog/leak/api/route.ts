/* A route handler whose code holds a marker; its response does not (leak.mjs). */
export async function GET() {
  const marker = "nz-route-marker-3d77";
  return Response.json({ length: marker.length });
}
