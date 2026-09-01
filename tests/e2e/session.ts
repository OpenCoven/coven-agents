import { encode } from "next-auth/jwt";

export const E2E_USER_ID = "00000000-0000-4000-8000-000000000001";

const SESSION_COOKIE = "authjs.session-token";
const SECURE_SESSION_COOKIE = "__Secure-authjs.session-token";

export function sessionCookies(
  type: "demo" | "subscriber",
  {
    authVersion = 1,
    email = "e2e-user@example.invalid",
    id = E2E_USER_ID,
    subscribedUntil = type === "subscriber" ? "2099-01-01T00:00:00.000Z" : null,
  }: {
    authVersion?: number;
    email?: string;
    id?: string;
    subscribedUntil?: string | null;
  } = {}
) {
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
          authVersion,
          email,
          id,
          name: "E2E subscriber",
          subscribedUntil,
          type,
        },
      }),
    }))
  );
}

export function subscriberCookies(email = "e2e-user@example.invalid") {
  return sessionCookies("subscriber", { email });
}
