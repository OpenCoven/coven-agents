import {
  applicationLoginPath,
  applicationPath,
  safeApplicationCallbackPath,
} from "@/lib/application-path";

export const SESSION_REAUTHENTICATION_EVENT = "coven:session-reauthentication";
export const SESSION_RECOVERY_TIMEOUT_MS = 10_000;

export function sessionExpiredLoginPath(
  returnPath: string | null | undefined,
  basePath: string
): string {
  return applicationPath(
    sessionExpiredLoginRoute(returnPath, basePath),
    basePath
  );
}

/** Next's redirect() adds basePath; location.replace() requires the full href. */
export function sessionExpiredLoginRoute(
  returnPath: string | null | undefined,
  basePath: string
): string {
  let callback = safeApplicationCallbackPath(returnPath, basePath);
  const { pathname } = new URL(callback, "https://application-path.invalid");
  if (
    pathname === applicationPath("/login", basePath) ||
    pathname.startsWith(applicationPath("/api/", basePath))
  ) {
    callback = safeApplicationCallbackPath(null, basePath);
  }
  return `${applicationLoginPath(callback, basePath)}&reason=session-expired`;
}

export function isSessionReauthenticationResponse(
  input: string,
  status: number,
  origin: string,
  basePath: string
): boolean {
  if (status !== 401) {
    return false;
  }
  const url = new URL(input, origin);
  return (
    url.origin === origin &&
    url.pathname.startsWith(applicationPath("/api/", basePath)) &&
    !url.pathname.startsWith(applicationPath("/api/auth/", basePath)) &&
    !url.pathname.startsWith(applicationPath("/api/internal/", basePath))
  );
}

export async function confirmSessionExpired(
  request: typeof fetch,
  basePath: string,
  signal: AbortSignal = AbortSignal.timeout(SESSION_RECOVERY_TIMEOUT_MS)
): Promise<boolean> {
  // Auth.js owns the cookie deletion/chunk handling. A successful null result,
  // not a failed request or a billing denial, is the instruction to re-login.
  const response = await request(
    applicationPath("/api/auth/session", basePath),
    {
      cache: "no-store",
      credentials: "same-origin",
      signal,
    }
  );
  if (!response.ok) {
    throw new Error("Session verification is temporarily unavailable.");
  }
  const session: unknown = await response.json();
  if (session === null) {
    return true;
  }
  if (typeof session !== "object" || !("user" in session) || !session.user) {
    throw new Error("Session verification returned an invalid response.");
  }
  return false;
}

export async function synchronizeSessionProvider(
  readSession: () => Promise<{ user?: unknown } | null | undefined>,
  providerReady: Promise<void>,
  signal: AbortSignal
): Promise<void> {
  signal.throwIfAborted();
  let onAbort: () => void = () => undefined;
  const aborted = new Promise<never>((_resolve, reject) => {
    onAbort = () => reject(signal.reason);
    signal.addEventListener("abort", onAbort, { once: true });
  });
  try {
    await Promise.race([
      Promise.all([
        Promise.resolve()
          .then(readSession)
          .then((session) => {
            if (!session?.user) {
              throw new Error(
                "Session verification is temporarily unavailable."
              );
            }
          }),
        providerReady,
      ]),
      aborted,
    ]);
  } finally {
    signal.removeEventListener("abort", onAbort);
  }
}

export const sessionFetch: typeof fetch = async (input, init) => {
  const response = await globalThis.fetch(input, init);
  if (
    typeof window !== "undefined" &&
    isSessionReauthenticationResponse(
      input instanceof Request ? input.url : String(input),
      response.status,
      window.location.origin,
      process.env.NEXT_PUBLIC_BASE_PATH ?? ""
    )
  ) {
    window.dispatchEvent(new Event(SESSION_REAUTHENTICATION_EVENT));
  }
  return response;
};
