"use client";

import type { Session } from "next-auth";
import { browserApplicationPath } from "@/lib/application-path";

type SessionFetch = (
  input: RequestInfo | URL,
  init?: RequestInit
) => Promise<Response>;

type RefreshSession = Session & {
  user?: Session["user"] & {
    id?: string;
    type?: unknown;
  };
};

export async function refreshSubscriberSession(
  expectedUserId: string,
  signal: AbortSignal,
  fetcher: SessionFetch = fetch
): Promise<RefreshSession | null> {
  const csrfResponse = await fetcher(browserApplicationPath("/api/auth/csrf"), {
    credentials: "same-origin",
    headers: { "content-type": "application/json" },
    signal,
  });
  const csrfBody = (await csrfResponse.json()) as { csrfToken?: unknown };
  if (!(csrfResponse.ok && typeof csrfBody.csrfToken === "string")) {
    throw new Error("Auth.js did not return a CSRF token.");
  }

  const sessionResponse = await fetcher(
    browserApplicationPath("/api/auth/session"),
    {
      body: JSON.stringify({
        csrfToken: csrfBody.csrfToken,
        data: {
          expectedUserId,
          refreshSubscription: true,
        },
      }),
      credentials: "same-origin",
      headers: { "content-type": "application/json" },
      method: "POST",
      signal,
    }
  );
  const session = (await sessionResponse.json()) as RefreshSession | null;
  if (!sessionResponse.ok) {
    throw new Error("Auth.js did not refresh the session.");
  }
  if (
    session?.user?.id !== expectedUserId ||
    session.user.type !== "subscriber"
  ) {
    return null;
  }
  return session;
}
