import {
  type ConnectionStatus,
  readConnectionResponse,
} from "./connection-status";

/**
 * The in-flight or completed provisioning request for this page load.
 *
 * Module scope, deliberately. The console fetched its connection from a mount
 * effect, so every remount issued another request — and once signed in, the
 * response updates state that can remount the tree, which turned a single
 * lookup into a stream of them.
 *
 * The connection is not data that changes while the page is open: the endpoint
 * and the deployment token are fixed for the deployment. Fetching it more than
 * once per load is waste however few times it happens.
 */
let inFlight: Promise<ConnectionStatus> | null = null;

type FetchLike = (input: string, init?: RequestInit) => Promise<Response>;

/**
 * Fetches the runner connection at most once per page load.
 *
 * Concurrent callers share the same promise rather than racing, so two mounts
 * in the same tick produce one request, not two.
 */
export function provisionConnection(
  fetchImpl: FetchLike = (input, init) => fetch(input, init)
): Promise<ConnectionStatus> {
  inFlight ??= (async () => {
    try {
      const response = await fetchImpl("/api/runner-connection");
      const body = (await response.json().catch(() => null)) as Record<
        string,
        unknown
      > | null;

      const status = readConnectionResponse(
        response.status,
        body,
        response.headers.get("retry-after")
      );

      /**
       * A rate limit expires on its own, so caching its verdict for the life
       * of the page turns a sixty-second refusal into "reload the tab". The
       * cache clears once the window has passed, and the next caller — a
       * navigation, a retry, a remount — fetches fresh. Capped so a hostile
       * or absurd retry-after cannot pin the page for hours.
       */
      if (status.kind === "rate_limited") {
        const RETRY_CAP_SECONDS = 600;
        setTimeout(() => {
          inFlight = null;
        }, Math.min(status.retryAfterSeconds, RETRY_CAP_SECONDS) * 1000);
      }

      return status;
    } catch {
      // Not cached as a permanent failure: a network blip should not leave the
      // console unable to connect for the life of the page.
      inFlight = null;
      return { kind: "unavailable" as const };
    }
  })();

  return inFlight;
}

/** Test seam. Never called by the app. */
export function resetProvisionCache(): void {
  inFlight = null;
}

/**
 * Whether this tenant has any harness credential stored, fetched once.
 *
 * Same single-flight treatment as the connection, and for the same reason:
 * this is read from a mount effect, and a remount would otherwise reissue it.
 * Shipping an uncached fetch next to a cached one would reintroduce exactly
 * the request spam the cache above exists to remove.
 *
 * Not cached on failure -- an unreadable answer should not permanently claim
 * the tenant has no credential, which would nag someone who does.
 */
let credentialsInFlight: Promise<boolean | null> | null = null;

export function fetchHasCredential(
  fetchImpl: FetchLike = (input, init) => fetch(input, init)
): Promise<boolean | null> {
  credentialsInFlight ??= (async () => {
    try {
      const response = await fetchImpl("/api/credentials");

      if (!response.ok) {
        credentialsInFlight = null;
        return null;
      }

      const body = (await response.json()) as { harnessIds?: string[] };
      return (body.harnessIds ?? []).length > 0;
    } catch {
      credentialsInFlight = null;
      return null;
    }
  })();

  return credentialsInFlight;
}

/** Test seam. Never called by the app. */
export function resetCredentialCache(): void {
  credentialsInFlight = null;
}
