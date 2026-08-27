import { encode } from "next-auth/jwt";

export const E2E_USER_ID = "00000000-0000-4000-8000-000000000001";

const SESSION_COOKIE = "authjs.session-token";
const SECURE_SESSION_COOKIE = "__Secure-authjs.session-token";

export function subscriberCookies(email = "e2e-user@example.invalid") {
  const secret = process.env.AUTH_SECRET;
  if (!secret) {
    throw new Error("AUTH_SECRET is required for subscriber browser contracts");
  }
  const cookieNames =
    process.env.E2E_PRODUCTION === "1"
      ? [SESSION_COOKIE, SECURE_SESSION_COOKIE]
      : [SESSION_COOKIE];

  return Promise.all(
    cookieNames.map(async (name) => ({
      domain: "localhost",
      httpOnly: true,
      name,
      path: "/",
      sameSite: "Lax" as const,
      secure: name === SECURE_SESSION_COOKIE,
      value: await encode({
        salt: name,
        secret,
        token: {
          email,
          id: E2E_USER_ID,
          name: "E2E subscriber",
          subscribedUntil: "2099-01-01T00:00:00.000Z",
          type: "subscriber",
        },
      }),
    }))
  );
}
