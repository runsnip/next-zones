import { NextResponse, type NextRequest } from "next/server";

/*
 * The shell's proxy, in front of every route, the zones' included: a header the pages read, a sign-in gate on a
 * zone's route, and a short path rewritten into a zone.
 */
export function proxy(request: NextRequest) {
  const { pathname } = request.nextUrl;
  if (pathname.startsWith("/blog/private") && !request.cookies.has("session")) {
    return NextResponse.redirect(new URL(`/login?next=${encodeURIComponent(pathname)}`, request.url));
  }
  const headers = new Headers(request.headers);
  headers.set("x-shell-proxy", "seen");
  const response = pathname.startsWith("/b/")
    ? NextResponse.rewrite(new URL(`/blog/${pathname.slice(3)}`, request.url), { request: { headers } })
    : NextResponse.next({ request: { headers } });
  response.headers.set("x-shell-proxy-response", "1");
  return response;
}

export const config = { matcher: ["/((?!_next/static|_next/image|favicon.ico).*)"] };
