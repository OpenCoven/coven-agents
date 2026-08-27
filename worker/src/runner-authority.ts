import type { RunnerClaims } from "@opencoven/agent-contracts";

const AUTHORITY_PATH = "/api/internal/runner-authority";
const MAX_AUTHORITY_RESPONSE_BYTES = 1024;

export type RunnerAuthorityResult =
  | { kind: "allowed" }
  | { kind: "subscription_required" }
  | { kind: "unauthorized" }
  | { kind: "unavailable" };

type RunnerFetch = (
  input: RequestInfo | URL,
  init?: RequestInit
) => Response | Promise<Response>;

export async function checkRunnerAuthority(
  claims: Pick<RunnerClaims, "authVersion" | "plan" | "sub" | "tenant">,
  configuration: {
    appOrigin: string | undefined;
    serviceToken: string | undefined;
  },
  fetchImpl: RunnerFetch = (input, init) => fetch(input, init)
): Promise<RunnerAuthorityResult> {
  if (!configuration.appOrigin?.trim() || !configuration.serviceToken?.trim()) {
    return { kind: "unavailable" };
  }

  let endpoint: string;
  try {
    endpoint = new URL(AUTHORITY_PATH, configuration.appOrigin).toString();
  } catch {
    return { kind: "unavailable" };
  }

  let response: Response;
  try {
    response = await fetchImpl(endpoint, {
      body: JSON.stringify({
        authVersion: claims.authVersion,
        plan: claims.plan,
        sub: claims.sub,
        tenant: claims.tenant,
      }),
      headers: {
        "content-type": "application/json",
        "x-service-token": configuration.serviceToken,
      },
      method: "POST",
    });
  } catch {
    return { kind: "unavailable" };
  }

  const body = await readAuthorityBody(response);
  if (!body) {
    return { kind: "unavailable" };
  }

  if (response.status === 200) {
    return body.allowed === true && Object.keys(body).length === 1
      ? { kind: "allowed" }
      : { kind: "unavailable" };
  }
  if (
    response.status === 401 &&
    body.error === "unauthorized" &&
    Object.keys(body).length === 1
  ) {
    return { kind: "unauthorized" };
  }
  if (
    response.status === 403 &&
    body.error === "subscription_required" &&
    Object.keys(body).length === 1
  ) {
    return { kind: "subscription_required" };
  }
  return { kind: "unavailable" };
}

async function readAuthorityBody(
  response: Response
): Promise<Record<string, unknown> | null> {
  const declaredLength = response.headers.get("content-length");
  if (
    declaredLength &&
    (!/^(?:0|[1-9]\d*)$/.test(declaredLength) ||
      Number(declaredLength) > MAX_AUTHORITY_RESPONSE_BYTES)
  ) {
    return null;
  }
  if (!response.body) {
    return null;
  }

  const reader = response.body.getReader();
  const chunks: Uint8Array[] = [];
  let size = 0;
  try {
    while (true) {
      // biome-ignore lint/performance/noAwaitInLoops: response streams must be consumed sequentially.
      const { done, value } = await reader.read();
      if (done) {
        break;
      }
      size += value.byteLength;
      if (size > MAX_AUTHORITY_RESPONSE_BYTES) {
        await reader.cancel().catch(() => undefined);
        return null;
      }
      chunks.push(value);
    }
  } catch {
    return null;
  } finally {
    reader.releaseLock();
  }

  const bytes = new Uint8Array(size);
  let offset = 0;
  for (const chunk of chunks) {
    bytes.set(chunk, offset);
    offset += chunk.byteLength;
  }
  try {
    const parsed: unknown = JSON.parse(
      new TextDecoder("utf-8", { fatal: true }).decode(bytes)
    );
    return isRecord(parsed) ? parsed : null;
  } catch {
    return null;
  }
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}
