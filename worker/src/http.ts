import { timingSafeEqual } from "node:crypto";
import {
  AGENT_RUNNER_API_VERSION,
  AGENT_RUNNER_LIMITS,
  type RunError,
  type RunEvent,
} from "@opencoven/agent-contracts";

const MAX_JSON_BYTES = 64 * 1024;

export class HttpError extends Error {
  readonly code: string;
  readonly details?: string;
  readonly retryable: boolean;
  readonly status: number;

  constructor(
    message: string,
    status: number,
    code: string,
    options: ErrorOptions & { details?: string; retryable?: boolean } = {}
  ) {
    super(message, options);
    this.code = code;
    this.details = options.details;
    this.name = "HttpError";
    this.retryable = options.retryable ?? false;
    this.status = status;
  }
}

/**
 * Request headers the browser client is permitted to send.
 *
 * Kept as data so a test can compare it against what the client actually
 * sets, instead of the two drifting silently until a browser refuses.
 */
export const CLIENT_HEADERS = [
  "authorization",
  "content-type",
  "last-event-id",
  "x-runner-token",
] as const;

export function corsHeaders(request: Request, allowedOrigin: string): Headers {
  const origin = request.headers.get("origin");
  const headers = new Headers({
    /**
     * Every header the browser client sends, or the request never leaves it.
     *
     * `x-runner-token` was missed when identity moved to `Authorization` and
     * the deployment gate moved here. A header absent from this list makes
     * the browser fail the preflight and report `TypeError: Failed to fetch`
     * -- a message that names neither the header nor CORS, and which no
     * server-side test can reproduce because CORS exists only in a browser.
     *
     * `CLIENT_HEADERS` is asserted against the client in a test rather than
     * kept in step by hand.
     */
    "access-control-allow-headers": CLIENT_HEADERS.join(", "),
    "access-control-allow-methods": "GET, POST, PUT, DELETE, OPTIONS",
    "access-control-max-age": "86400",
    vary: "Origin",
  });
  if (origin && origin === allowedOrigin) {
    headers.set("access-control-allow-origin", origin);
  }
  return headers;
}

export function hasValidBearerToken(
  request: Request,
  expectedToken: string
): boolean {
  const authorization = request.headers.get("authorization");
  if (!authorization?.startsWith("Bearer ") || !expectedToken) {
    return false;
  }
  const supplied = new TextEncoder().encode(authorization.slice(7));
  const expected = new TextEncoder().encode(expectedToken);
  if (supplied.byteLength !== expected.byteLength) {
    return false;
  }
  return timingSafeEqual(supplied, expected);
}

export function hasValidHeaderToken(
  request: Request,
  header: string,
  expectedToken: string
): boolean {
  const supplied = request.headers.get(header);
  if (!supplied || !expectedToken) {
    return false;
  }
  const a = new TextEncoder().encode(supplied);
  const b = new TextEncoder().encode(expectedToken);
  if (a.byteLength !== b.byteLength) {
    return false;
  }
  return timingSafeEqual(a, b);
}

export async function readJson(
  request: Request,
  allowEmpty = false
): Promise<unknown> {
  const declaredLength = Number(request.headers.get("content-length") ?? "0");
  if (Number.isFinite(declaredLength) && declaredLength > MAX_JSON_BYTES) {
    throw new HttpError("Request body is too large.", 413, "body_too_large");
  }
  const reader = request.body?.getReader();
  const chunks: Uint8Array[] = [];
  let size = 0;

  if (reader) {
    try {
      while (true) {
        // biome-ignore lint/performance/noAwaitInLoops: a stream is read sequentially by definition — the next chunk does not exist until this read resolves, so there is nothing to parallelise.
        const { done, value } = await reader.read();
        if (done) {
          break;
        }
        const chunk = value as Uint8Array;
        size += chunk.byteLength;
        if (size > MAX_JSON_BYTES) {
          await reader.cancel("Request body is too large.");
          throw new HttpError(
            "Request body is too large.",
            413,
            "body_too_large"
          );
        }
        chunks.push(chunk);
      }
    } finally {
      reader.releaseLock();
    }
  }
  const bytes = new Uint8Array(size);
  let offset = 0;
  for (const chunk of chunks) {
    bytes.set(chunk, offset);
    offset += chunk.byteLength;
  }
  const text = new TextDecoder().decode(bytes);
  if (allowEmpty && !text) {
    return null;
  }
  try {
    return JSON.parse(text) as unknown;
  } catch (error) {
    // biome-ignore lint/style/useErrorCause: HttpError forwards this options object to Error.
    throw new HttpError(
      "Request body must be valid JSON.",
      400,
      "invalid_json",
      { cause: error }
    );
  }
}

export function errorEnvelope(
  code: string,
  message: string,
  retryable: boolean,
  details?: string,
  requestId: string = crypto.randomUUID()
): {
  apiVersion: string;
  error: RunError;
  requestId: string;
} {
  return {
    apiVersion: AGENT_RUNNER_API_VERSION,
    error: {
      code: code.slice(0, 64),
      ...(details
        ? { details: details.slice(0, AGENT_RUNNER_LIMITS.maxDetailsLength) }
        : {}),
      message: message.slice(0, AGENT_RUNNER_LIMITS.maxMessageLength),
      retryable,
    },
    requestId: requestId.slice(0, AGENT_RUNNER_LIMITS.maxRequestIdLength),
  };
}

export function serializeSse(events: RunEvent[], lastEventId: number): string {
  return events
    .filter((event) => event.id > lastEventId)
    .map(
      (event) =>
        `id: ${event.id}\nevent: ${event.type}\ndata: ${JSON.stringify(event)}\n\n`
    )
    .join("");
}

export function json(
  value: unknown,
  init: ResponseInit = {},
  cors?: Headers
): Response {
  const headers = new Headers(init.headers);
  headers.set("content-type", "application/json; charset=utf-8");
  cors?.forEach((headerValue, key) => {
    headers.set(key, headerValue);
  });
  return Response.json(value, { ...init, headers });
}
