import { type NextRequest, NextResponse } from "next/server";
import { getToken } from "next-auth/jwt";
import { guestRegex, isDevelopmentEnvironment } from "./lib/constants";

/**
 * Identifies an anonymous visitor across requests, with no database row
 * behind it. Set only when absent (see below), never overwritten — a demo
 * visitor's tenant is derived from this value, and `toSession` mints
 * `demo:<uuid>` from it. A value that changed on every request would make a
 * demo visitor's own state vanish between page loads.
 */
const DEMO_COOKIE_NAME = "coven-demo";

export async function proxy(request: NextRequest) {
  const { pathname } = request.nextUrl;

  if (pathname.startsWith("/ping")) {
    return new Response("pong", { status: 200 });
  }

  if (pathname.startsWith("/api/auth")) {
    return NextResponse.next();
  }

  const token = await getToken({
    req: request,
    secret: process.env.AUTH_SECRET,
    secureCookie: !isDevelopmentEnvironment,
  });

  const base = process.env.NEXT_PUBLIC_BASE_PATH ?? "";

  if (!token) {
    // No sign-in, and no database write either: an anonymous visitor gets a
    // stateless, httpOnly cookie identifying them, and the request proceeds.
    // This replaces the old redirect to a guest-provider route that inserted
    // a real `User` row for every anonymous request.
    const response = NextResponse.next();

    if (!request.cookies.has(DEMO_COOKIE_NAME)) {
      response.cookies.set(DEMO_COOKIE_NAME, crypto.randomUUID(), {
        httpOnly: true,
        path: "/",
        sameSite: "lax",
        secure: !isDevelopmentEnvironment,
      });
    }

    return response;
  }

  const isGuest = guestRegex.test(token?.email ?? "");

  if (token && !isGuest && ["/login", "/register"].includes(pathname)) {
    return NextResponse.redirect(new URL(`${base}/`, request.url));
  }

  return NextResponse.next();
}

export const config = {
  matcher: [
    "/",
    "/chat/:id",
    "/api/:path*",
    "/login",
    "/register",

    "/((?!_next/static|_next/image|favicon.ico|sitemap.xml|robots.txt).*)",
  ],
};
