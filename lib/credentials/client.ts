type FetchLike = (input: string, init?: RequestInit) => Promise<Response>;

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

/** Test seam. */
export function resetCredentialCache(): void {
  credentialsInFlight = null;
}
