import { headers } from "next/headers";

/* A route handler of the zone: GET answers JSON (with the shell proxy's header), POST echoes its body. */
export async function GET(_request: Request, { params }: { params: Promise<{ name: string }> }) {
  const { name } = await params;
  return Response.json({ zone: "blog", version: process.env.ZONE_VERSION, name, proxy: (await headers()).get("x-shell-proxy") });
}

export async function POST(request: Request, { params }: { params: Promise<{ name: string }> }) {
  const { name } = await params;
  return Response.json({ zone: "blog", name, received: await request.json() });
}
