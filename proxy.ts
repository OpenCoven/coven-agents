import { type NextRequest, NextResponse } from "next/server";
import { getToken } from "next-auth/jwt";
import { isAdminEmail } from "./lib/admin/access";
import { betaVerdict, isAllowedIdentity, readBetaGate } from "./lib/beta";
import { guestRegex, isDevelopmentEnvironment } from "./lib/constants";
import { DEMO_COOKIE_NAME, isCanonicalUuid } from "./lib/session";

const PUBLIC_BRAND_ASSETS = new Set([
  "/apple-icon.png",
  "/brand/opencoven-mark.svg",
  "/icon.png",
]);

function isPublicBrandAsset(pathname: string, basePath: string): boolean {
  const applicationPath =
    basePath && pathname.startsWith(`${basePath}/`)
      ? pathname.slice(basePath.length)
      : pathname;

  return PUBLIC_BRAND_ASSETS.has(applicationPath);
}

/**
 * Identifies an anonymous visitor across requests, with no database row
 * behind it. Set only when absent (see below), never overwritten — a demo
 * visitor's tenant is derived from this value, and `toSession` mints
 * `demo:<uuid>` from it. A value that changed on every request would make a
 * demo visitor's own state vanish between page loads.
 */

export async function proxy(request: NextRequest) {
  const { pathname } = request.nextUrl;
  const base = process.env.NEXT_PUBLIC_BASE_PATH ?? "";

  if (pathname.startsWith("/ping")) {
    return new Response("pong", { status: 200 });
  }

  if (isPublicBrandAsset(pathname, base)) {
    return NextResponse.next();
  }

  if (pathname.startsWith("/api/auth")) {
    return NextResponse.next();
  }

  const token = await getToken({
    req: request,
    secret: process.env.AUTH_SECRET,
    secureCookie: !isDevelopmentEnvironment,
  });

  // Refuse the hidden owner surface before React can stream a 200 response
  // around `notFound()`. The page and API repeat this gate as defense in depth.
  if (pathname === `${base}/admin` && !isAdminEmail(token?.email)) {
    return new Response("Not Found", {
      headers: {
        "cache-control": "no-store",
        "content-type": "text/plain; charset=utf-8",
      },
      status: 404,
    });
  }

  // Closed beta. Checked before the demo cookie is minted, because the demo
  // session needs no sign-in — gating only the sign-in path would leave the
  // beta wide open to anyone holding the URL. Only the exact machine routes
  // documented in the beta policy bypass the gate; descendants, lookalikes,
  // and other future routes are gated like ordinary requests.
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

    // Replaced when absent *or* unusable. `demoTenant` ignores a value that is
    // not a uuid it minted, so leaving a stale one in place would hand the
    // visitor a freshly random tenant on every request -- each page would still
    // render while their own state silently failed to follow them.
    const demoId = request.cookies.get(DEMO_COOKIE_NAME)?.value;

    if (!(demoId && isCanonicalUuid(demoId))) {
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
