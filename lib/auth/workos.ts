import { customFetch } from "next-auth";
import type { OAuthConfig } from "next-auth/providers";
import { z } from "zod";

const AUTHENTICATE_URL = "https://api.workos.com/user_management/authenticate";
const profileSchema = z.object({
  email: z.string().trim().toLowerCase().max(64).pipe(z.email()),
  email_verified: z.literal(true),
  id: z.string().startsWith("user_").min(6).max(128),
});

type WorkOSProfile = z.infer<typeof profileSchema>;

import type { WorkOSConfiguration } from "./workos-config";

export { readWorkOSConfiguration } from "./workos-config";

export function verifiedWorkOSProfile(value: unknown): WorkOSProfile {
  const result = profileSchema.safeParse(value);
  if (!result.success) {
    // Do not attach the rejected profile to authentication logs.
    throw new Error("WorkOS did not return a verified account email.");
  }
  return result.data;
}

/** AuthKit user management, not the legacy WorkOS enterprise SSO provider. */
export function createWorkOSProvider(
  configuration: WorkOSConfiguration,
  request: typeof fetch = fetch
): OAuthConfig<WorkOSProfile> {
  return {
    authorization: {
      params: { provider: "authkit", scope: "" },
      url: "https://api.workos.com/user_management/authorize",
    },
    checks: ["state", "pkce"],
    client: { token_endpoint_auth_method: "client_secret_post" },
    clientId: configuration.clientId,
    clientSecret: configuration.apiKey,
    id: "workos",
    issuer: "https://api.workos.com",
    name: "WorkOS",
    profile(value) {
      const profile = verifiedWorkOSProfile(value);
      return { email: profile.email, id: profile.id, type: "demo" };
    },
    token: AUTHENTICATE_URL,
    type: "oauth",
    // AuthKit returns its authenticated user in the server-side code exchange.
    userinfo: {
      request: ({ tokens }: { tokens: { user?: unknown } }) =>
        verifiedWorkOSProfile(tokens.user),
    },
    [customFetch]: async (input, init) => {
      if (String(input) !== AUTHENTICATE_URL || init?.method !== "POST") {
        throw new Error("Unexpected WorkOS authentication endpoint.");
      }
      const parameters = new URLSearchParams(String(init.body));
      parameters.delete("redirect_uri");
      const headers = new Headers(init.headers);
      headers.set("content-type", "application/json");
      let response: Response;
      try {
        response = await request(AUTHENTICATE_URL, {
          ...init,
          body: JSON.stringify(Object.fromEntries(parameters)),
          headers,
          redirect: "error",
          signal: AbortSignal.timeout(15_000),
        });
      } catch {
        // biome-ignore lint/style/useErrorCause: Upstream errors may contain credentials and must not reach Auth.js logs.
        throw new Error("WorkOS authentication is temporarily unavailable.");
      }
      if (!response.ok) {
        return Response.json({ error: "invalid_grant" }, { status: 400 });
      }
      const result = await response.json();
      const user = verifiedWorkOSProfile(result.user);
      if (typeof result.access_token !== "string" || !result.access_token) {
        throw new Error("WorkOS authentication returned an invalid response.");
      }
      // Auth.js validates state and PKCE; its normal JWT callback maps only
      // the verified email to our account. No provider tokens enter that JWT.
      return Response.json({
        access_token: result.access_token,
        token_type: "bearer",
        user,
      });
    },
  };
}
