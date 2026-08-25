import { type NextRequest, NextResponse } from "next/server";
import { getToken } from "next-auth/jwt";
import { betaVerdict, isAllowedIdentity, readBetaGate } from "./lib/beta";
import { guestRegex, isDevelopmentEnvironment } from "./lib/constants";
import { DEMO_COOKIE_NAME } from "./lib/session";

/**
 * Identifies an anonymous visitor across requests, with no database row
 * behind it. Set only when absent (see below), never overwritten — a demo
 * visitor's tenant is derived from this value, and `toSession` mints
 * `demo:<uuid>` from it. A value that changed on every request would make a
 * demo visitor's own state vanish between page loads.
 */

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

  // Closed beta. Checked before the demo cookie is minted, because the demo
  // session needs no sign-in — gating only the sign-in path would leave the
  // beta wide open to anyone holding the URL. `/api/internal` is exempt: the
  // worker authenticates itself with a service token and a signed identity
  // claim, and gating it would break runs rather than close the beta.
  const gate = readBetaGate({
    BETA_ALLOWLIST: process.env.BETA_ALLOWLIST,
    BETA_MODE: process.env.BETA_MODE,
  });

  // Refused visitors are sent to sign in rather than shown a bare 403. The
  // marker is what lets the page say "Closed beta" instead of implying the
  // credentials were wrong.
  const invited = isAllowedIdentity(gate, token?.email);

  if (betaVerdict(gate, pathname, token?.email) === "deny") {
    const login = new URL(`${base}/login`, request.url);
    login.searchParams.set("beta", "1");

    return NextResponse.redirect(login);
  }

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

  // `invited` is load-bearing here. Without it a signed-in stranger is refused
  // at `/`, redirected to `/login`, bounced back to `/` for being signed in,
  // and loops forever.
  if (
    token &&
    !isGuest &&
    invited &&
    ["/login", "/register"].includes(pathname)
  ) {
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
