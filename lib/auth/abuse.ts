import { ipAddress } from "@vercel/functions";
import { readBoundedBytes } from "@/lib/abuse/body";
import {
  abuseAdmissionResponse,
  enforceAbusePolicy,
} from "@/lib/abuse/enforce";
import { abusePolicyFor } from "@/lib/abuse/policy";
import type { AbuseStore } from "@/lib/abuse/store";
import type { AbuseRoute } from "@/lib/abuse/types";
import type { VerifiedJwtIdentity } from "@/lib/auth/verified-jwt";

type AuthAbuseRoute = Extract<
  AbuseRoute,
  "auth_callback" | "auth_session_update" | "auth_start"
>;

type AuthAbuseOptions = {
  basePath?: string;
  enforceAbuse?: typeof enforceAbusePolicy;
  readIdentity?: (request: Request) => Promise<VerifiedJwtIdentity | null>;
  store?: AbuseStore;
};

const AUTH_SIGNIN_PATH = /^\/api\/auth\/signin(?:\/[^/]+)?\/?$/;
const AUTH_CALLBACK_PATH = /^\/api\/auth\/callback\/[^/]+\/?$/;
const AUTH_SESSION_PATH = /^\/api\/auth\/session\/?$/;

export function authAbuseRoute(
  method: string,
  pathname: string,
  basePath = ""
): AuthAbuseRoute | null {
  const normalizedPathname = stripBasePath(pathname, basePath);
  if (method === "POST" && AUTH_SIGNIN_PATH.test(normalizedPathname)) {
    return "auth_start";
  }
  if (
    (method === "GET" || method === "POST") &&
    AUTH_CALLBACK_PATH.test(normalizedPathname)
  ) {
    return "auth_callback";
  }
  if (method === "POST" && AUTH_SESSION_PATH.test(normalizedPathname)) {
    return "auth_session_update";
  }
  return null;
}

export function withAuthAbusePolicy<
  RequestType extends Request,
  Arguments extends unknown[],
>(
  handler: (
    request: RequestType,
    ...args: Arguments
  ) => Promise<Response> | Response,
  options: AuthAbuseOptions = {}
): (request: RequestType, ...args: Arguments) => Promise<Response> {
  return async (request, ...args) => {
    const route = authAbuseRoute(
      request.method,
      new URL(request.url).pathname,
      options.basePath ?? process.env.NEXT_PUBLIC_BASE_PATH
    );
    if (route) {
      if (route === "auth_session_update") {
        const ipAdmission = await (options.enforceAbuse ?? enforceAbusePolicy)({
          ip: ipAddress(request) ?? null,
          route: "auth_session_update_ip",
          ...(options.store ? { store: options.store } : {}),
        });
        if (ipAdmission.kind !== "allowed") {
          return abuseAdmissionResponse(ipAdmission);
        }

        const body = await readBoundedBytes(
          request,
          abusePolicyFor("auth_session_update").bodyBytes
        );
        if (body.kind === "too_large") {
          return Response.json(
            {
              error: "payload_too_large",
              message: "Session update payload is too large.",
            },
            {
              headers: { "cache-control": "no-store" },
              status: 413,
            }
          );
        }
        if (body.kind === "read_error") {
          return Response.json(
            {
              error: "request_body_unreadable",
              message:
                "Could not read the session update payload. Retry the request.",
            },
            {
              headers: { "cache-control": "no-store" },
              status: 400,
            }
          );
        }
        if (body.kind === "invalid") {
          return Response.json(
            {
              error: "invalid_request_body",
              message: "Session update payload framing is invalid.",
            },
            {
              headers: { "cache-control": "no-store" },
              status: 400,
            }
          );
        }

        const boundedRequest = requestWithBody(request, body.value);
        let identity: VerifiedJwtIdentity | null;
        try {
          identity = await (options.readIdentity ?? readVerifiedJwtIdentity)(
            boundedRequest
          );
        } catch {
          return abuseAdmissionResponse({
            kind: "unavailable",
            responseStatus: 503,
          });
        }
        if (identity) {
          const userAdmission = await (
            options.enforceAbuse ?? enforceAbusePolicy
          )({
            ip: null,
            route: "auth_session_update",
            ...(options.store ? { store: options.store } : {}),
            userId: identity.userId,
          });
          if (userAdmission.kind !== "allowed") {
            return abuseAdmissionResponse(userAdmission);
          }
        }

        return handler(boundedRequest, ...args);
      }

      const admission = await (options.enforceAbuse ?? enforceAbusePolicy)({
        /**
         * Degrades on store failure like every other route, and this is the
         * second reversal of this exact decision in one night, so the record
         * matters: fail-closed here 503ed production sign-in the moment the
         * limiter's store hiccuped — reproduced with a bare curl. OAuth
         * replay safety lives in the state, PKCE, and CSRF machinery, which
         * none of this touches; the limiter is defense-in-depth on these
         * routes, and a defense-in-depth layer that takes sign-in down with
         * its own backing store has its priorities inverted. Degradation
         * keeps per-instance limits enforced throughout.
         */
        ip: ipAddress(request) ?? null,
        route,
        ...(options.store ? { store: options.store } : {}),
      });
      if (admission.kind !== "allowed") {
        return abuseAdmissionResponse(admission);
      }
    }

    return handler(request, ...args);
  };
}

function stripBasePath(pathname: string, basePath: string | undefined): string {
  if (!basePath || basePath === "/") {
    return pathname;
  }
  const normalizedBasePath = basePath.endsWith("/")
    ? basePath.slice(0, -1)
    : basePath;
  return pathname.startsWith(`${normalizedBasePath}/`)
    ? pathname.slice(normalizedBasePath.length)
    : pathname;
}

function requestWithBody<RequestType extends Request>(
  request: RequestType,
  body: Uint8Array
): RequestType {
  type ReplayRequestInit = RequestInit & {
    nextConfig?: { basePath?: string };
  };
  const RequestConstructor = request.constructor as new (
    input: RequestInfo | URL,
    init?: RequestInit
  ) => RequestType;
  const init: ReplayRequestInit = {
    body: body as BodyInit,
    headers: new Headers(request.headers),
    method: request.method,
    signal: request.signal,
  };
  const basePath = nextRequestBasePath(request);
  if (basePath) {
    init.nextConfig = { basePath };
  }

  return new RequestConstructor(request.url, init);
}

function nextRequestBasePath(request: Request): string | undefined {
  const basePath = (request as Request & { nextUrl?: { basePath?: unknown } })
    .nextUrl?.basePath;
  return typeof basePath === "string" && basePath ? basePath : undefined;
}

async function readVerifiedJwtIdentity(
  request: Request
): Promise<VerifiedJwtIdentity | null> {
  const { verifiedJwtIdentity } = await import("./verified-jwt");
  return verifiedJwtIdentity(request);
}
