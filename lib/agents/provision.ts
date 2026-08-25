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

      return readConnectionResponse(response.status, body);
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
