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

export function corsHeaders(request: Request, allowedOrigin: string): Headers {
  const origin = request.headers.get("origin");
  const headers = new Headers({
    "access-control-allow-headers":
      "authorization, content-type, last-event-id",
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

export async function readJson(
  request: Request,
  allowEmpty = false
): Promise<unknown> {
  const declaredLength = Number(request.headers.get("content-length") ?? "0");
  if (Number.isFinite(declaredLength) && declaredLength > MAX_JSON_BYTES) {
    throw new HttpError("Request body is too large.", 413, "body_too_large");
  }
  const text = await request.text();
  if (new TextEncoder().encode(text).byteLength > MAX_JSON_BYTES) {
    throw new HttpError("Request body is too large.", 413, "body_too_large");
  }
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
