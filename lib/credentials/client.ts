import { browserApplicationPath } from "@/lib/application-path";

type FetchLike = (input: string, init?: RequestInit) => Promise<Response>;

export function isCredentialAuthorityRequestCurrent({
  currentAuthorityContext,
  operationIsCurrent,
  requestAuthorityContext,
}: {
  currentAuthorityContext: string;
  operationIsCurrent: boolean;
  requestAuthorityContext: string;
}): boolean {
  return (
    operationIsCurrent && requestAuthorityContext === currentAuthorityContext
  );
}

export type CredentialRefreshTicket = Readonly<{
  generation: number;
  mutationEpoch: number;
}>;

export type CredentialRefreshFence = Readonly<{
  activate: () => void;
  advanceMutation: () => boolean;
  beginRefresh: () => CredentialRefreshTicket;
  deactivate: () => void;
  isCurrent: (ticket: CredentialRefreshTicket) => boolean;
}>;

export function createCredentialRefreshFence(): CredentialRefreshFence {
  let active = false;
  let generation = 0;
  let mutationEpoch = 0;

  return {
    activate: () => {
      active = true;
      generation += 1;
    },
    advanceMutation: () => {
      if (!active) {
        return false;
      }
      mutationEpoch += 1;
      generation += 1;
      return true;
    },
    beginRefresh: () => {
      generation += 1;
      return { generation, mutationEpoch };
    },
    deactivate: () => {
      active = false;
      generation += 1;
    },
    isCurrent: (ticket) =>
      active &&
      ticket.generation === generation &&
      ticket.mutationEpoch === mutationEpoch,
  };
}

export type CredentialEligibility =
  | "authentication_required"
  | boolean
  | "subscription_required"
  | null;

let credentialsInFlight: Promise<CredentialEligibility> | null = null;
let credentialAuthorityContext: string | null = null;
let credentialEligibility: boolean | null = null;
let credentialVersion = 0;

export function fetchHasCredential(
  fetchImpl: FetchLike = (input, init) => fetch(input, init),
  authorityContext: string | null = null
): Promise<CredentialEligibility> {
  if (
    authorityContext !== null &&
    authorityContext !== credentialAuthorityContext
  ) {
    credentialAuthorityContext = authorityContext;
    credentialVersion += 1;
    credentialEligibility = null;
    credentialsInFlight = null;
  }
  credentialsInFlight ??= (async () => {
    const requestVersion = credentialVersion;
    try {
      const response = await fetchImpl(
        browserApplicationPath("/api/credentials")
      );

      if (!response.ok) {
        const authorityRefusal =
          response.status === 401
            ? "authentication_required"
            : response.status === 403
              ? "subscription_required"
              : null;
        if (requestVersion === credentialVersion) {
          credentialsInFlight = null;
          credentialEligibility = null;
        }
        return authorityRefusal ?? credentialEligibility;
      }

      const body = (await response.json()) as { harnessIds?: string[] };
      const hasCredential = (body.harnessIds ?? []).length > 0;
      if (requestVersion !== credentialVersion) {
        return credentialEligibility;
      }
      credentialEligibility = hasCredential;
      return hasCredential;
    } catch {
      if (requestVersion === credentialVersion) {
        credentialsInFlight = null;
        credentialEligibility = null;
      }
      return credentialEligibility;
    }
  })();

  return credentialsInFlight;
}

export function updateCredentialEligibility(
  harnessIds: readonly string[]
): boolean {
  const hasCredential = harnessIds.length > 0;
  credentialVersion += 1;
  credentialEligibility = hasCredential;
  credentialsInFlight = Promise.resolve(hasCredential);
  return hasCredential;
}

/** Test seam. */
export function resetCredentialCache(): void {
  credentialVersion += 1;
  credentialAuthorityContext = null;
  credentialEligibility = null;
  credentialsInFlight = null;
}
