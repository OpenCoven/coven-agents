import { timingSafeEqual } from "node:crypto";

const MAX_JSON_BYTES = 64 * 1024;

export class HttpError extends Error {
  readonly code: string;
  readonly status: number;

  constructor(
    message: string,
    status: number,
    code: string,
    options?: ErrorOptions
  ) {
    super(message, options);
    this.code = code;
    this.name = "HttpError";
    this.status = status;
  }
}

export function corsHeaders(request: Request, allowedOrigin: string): Headers {
  const origin = request.headers.get("origin");
  const headers = new Headers({
    "access-control-allow-headers": "authorization, content-type",
    "access-control-allow-methods": "GET, POST, DELETE, OPTIONS",
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

export async function readJson(request: Request): Promise<unknown> {
  const declaredLength = Number(request.headers.get("content-length") ?? "0");
  if (Number.isFinite(declaredLength) && declaredLength > MAX_JSON_BYTES) {
    throw new HttpError("Request body is too large.", 413, "body_too_large");
  }
  const text = await request.text();
  if (new TextEncoder().encode(text).byteLength > MAX_JSON_BYTES) {
    throw new HttpError("Request body is too large.", 413, "body_too_large");
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
