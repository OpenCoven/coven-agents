type ApplicationOriginEnvironment = Readonly<
  Record<string, string | undefined>
>;

function nonblank(value: string | undefined): value is string {
  return Boolean(value?.trim());
}

function isLoopbackHostname(hostname: string): boolean {
  return (
    hostname === "localhost" ||
    hostname === "127.0.0.1" ||
    hostname === "::1" ||
    hostname === "[::1]"
  );
}

export function parseCanonicalApplicationOrigin(
  name: string,
  value: string,
  options: Readonly<{ allowTrailingSlash?: boolean }> = {}
): string {
  const configured = value.trim();
  let parsed: URL;
  try {
    parsed = new URL(configured);
  } catch (error) {
    throw new Error(`${name} must be an absolute application origin.`, {
      cause: error,
    });
  }
  if (parsed.protocol !== "https:" && parsed.protocol !== "http:") {
    throw new Error(`${name} must use https.`);
  }
  if (parsed.username || parsed.password) {
    throw new Error(`${name} must not contain credentials.`);
  }
  if (parsed.pathname !== "/" || parsed.search || parsed.hash) {
    throw new Error(`${name} must contain only an origin.`);
  }
  const accepted = options.allowTrailingSlash
    ? configured === parsed.origin || configured === `${parsed.origin}/`
    : configured === parsed.origin;
  if (!accepted) {
    throw new Error(`${name} must be a canonical application origin.`);
  }
  if (parsed.protocol === "http:" && !isLoopbackHostname(parsed.hostname)) {
    throw new Error(`${name} must use https outside loopback development.`);
  }
  return parsed.origin;
}

function vercelOrigin(name: string, value: string | undefined): string | null {
  if (!nonblank(value)) {
    return null;
  }
  if (
    value.includes("://") ||
    /[/:\\@?#]/u.test(value) ||
    value.trim() !== value
  ) {
    throw new Error(`${name} must contain only a deployment host.`);
  }
  return parseCanonicalApplicationOrigin(name, `https://${value}`);
}

function selectedVercelOrigin(
  environment: ApplicationOriginEnvironment
): string | null {
  if (environment.VERCEL_ENV === "production") {
    const origin = vercelOrigin(
      "VERCEL_PROJECT_PRODUCTION_URL",
      environment.VERCEL_PROJECT_PRODUCTION_URL
    );
    if (!origin) {
      throw new Error(
        "VERCEL_PROJECT_PRODUCTION_URL must identify the production application authority."
      );
    }
    return origin;
  }
  if (environment.VERCEL_ENV === "preview") {
    const origin = vercelOrigin("VERCEL_URL", environment.VERCEL_URL);
    if (!origin) {
      throw new Error(
        "VERCEL_URL must identify the preview application authority."
      );
    }
    return origin;
  }
  return null;
}

export function approvedApplicationOrigin(
  environment: ApplicationOriginEnvironment
): string {
  if (!nonblank(environment.APP_ORIGIN)) {
    throw new Error("APP_ORIGIN must be configured.");
  }
  const candidate = parseCanonicalApplicationOrigin(
    "APP_ORIGIN",
    environment.APP_ORIGIN,
    { allowTrailingSlash: true }
  );
  let approved: string | null = null;
  for (const name of ["AUTH_URL", "NEXTAUTH_URL"] as const) {
    const value = environment[name];
    if (nonblank(value)) {
      const origin = parseCanonicalApplicationOrigin(name, value, {
        allowTrailingSlash: true,
      });
      if (approved && approved !== origin) {
        throw new Error(
          "AUTH_URL and NEXTAUTH_URL must identify the same application authority."
        );
      }
      approved = origin;
    }
  }
  if (!approved) {
    approved = selectedVercelOrigin(environment);
  }

  if (!approved && isLoopbackHostname(new URL(candidate).hostname)) {
    return candidate;
  }
  if (approved !== candidate) {
    throw new Error(
      "APP_ORIGIN must exactly match an approved application authority."
    );
  }
  return candidate;
}

export function configuredApplicationOrigin(
  environment: ApplicationOriginEnvironment
): string | null {
  try {
    return approvedApplicationOrigin(environment);
  } catch {
    return null;
  }
}
