export type WorkOSConfiguration = Readonly<{
  apiKey: string;
  clientId: string;
}>;

export function readWorkOSConfiguration(
  environment: Readonly<Record<string, string | undefined>>
): WorkOSConfiguration | null {
  if (![undefined, "0", "1"].includes(environment.WORKOS_AUTH_ENABLED)) {
    throw new Error(
      "WORKOS_AUTH_ENABLED must be exactly 0 or 1 when configured."
    );
  }
  if (environment.WORKOS_AUTH_ENABLED !== "1") {
    return null;
  }
  const apiKey = environment.WORKOS_API_KEY?.trim();
  const clientId = environment.WORKOS_CLIENT_ID?.trim();
  if (!(apiKey && clientId?.startsWith("client_"))) {
    throw new Error(
      "Enabled WorkOS login requires WORKOS_CLIENT_ID and WORKOS_API_KEY."
    );
  }
  return { apiKey, clientId };
}
