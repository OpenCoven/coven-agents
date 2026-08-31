const PATH_ORIGIN = "https://application-path.invalid";

type ApplicationBasePathEnvironment = Readonly<
  Record<string, string | undefined>
>;

export const APPLICATION_CALLBACK_PARAM = "callbackUrl";

export function applicationBasePath(value: string | undefined): string {
  if (value === undefined || value === "") {
    return "";
  }
  if (value !== value.trim() || !value.startsWith("/") || value.endsWith("/")) {
    throw new Error(
      "Application base path must be empty or a canonical absolute path."
    );
  }
  const parsed = new URL(value, PATH_ORIGIN);
  if (
    parsed.origin !== PATH_ORIGIN ||
    parsed.search ||
    parsed.hash ||
    parsed.pathname !== value ||
    value.startsWith("//")
  ) {
    throw new Error(
      "Application base path must be empty or a canonical absolute path."
    );
  }
  return value;
}

export function configuredApplicationBasePath(
  environment: ApplicationBasePathEnvironment
): string {
  return applicationBasePath(environment.IS_DEMO === "1" ? "/demo" : "");
}

export function applicationPath(
  value: string,
  basePath: string | undefined
): string {
  if (!value.startsWith("/") || value.startsWith("//")) {
    throw new Error("Application path must be same-origin and absolute.");
  }
  const parsed = new URL(value, PATH_ORIGIN);
  if (
    parsed.origin !== PATH_ORIGIN ||
    `${parsed.pathname}${parsed.search}${parsed.hash}` !== value
  ) {
    throw new Error("Application path must be same-origin and canonical.");
  }
  return `${applicationBasePath(basePath)}${value}`;
}

export function browserApplicationPath(value: string): string {
  return applicationPath(value, process.env.NEXT_PUBLIC_BASE_PATH ?? "");
}

export function applicationHomePath(basePath: string | undefined): string {
  return applicationBasePath(basePath) || "/";
}

export function safeApplicationCallbackPath(
  value: string | null | undefined,
  basePath: string | undefined
): string {
  const canonicalBasePath = applicationBasePath(basePath);
  const fallback = applicationHomePath(canonicalBasePath);
  if (
    typeof value !== "string" ||
    value.length === 0 ||
    value !== value.trim() ||
    !value.startsWith("/") ||
    value.startsWith("//")
  ) {
    return fallback;
  }

  let parsed: URL;
  try {
    parsed = new URL(value, PATH_ORIGIN);
  } catch {
    return fallback;
  }
  if (
    parsed.origin !== PATH_ORIGIN ||
    `${parsed.pathname}${parsed.search}${parsed.hash}` !== value ||
    parsed.pathname.includes("%") ||
    /%(?![0-9a-f]{2})/i.test(value)
  ) {
    return fallback;
  }
  if (
    canonicalBasePath &&
    parsed.pathname !== canonicalBasePath &&
    !parsed.pathname.startsWith(`${canonicalBasePath}/`)
  ) {
    return fallback;
  }
  return value;
}

export function applicationLoginPath(
  callbackPath: string | null | undefined,
  basePath: string | undefined
): string {
  const callbackUrl = safeApplicationCallbackPath(callbackPath, basePath);
  const search = new URLSearchParams({
    [APPLICATION_CALLBACK_PARAM]: callbackUrl,
  });
  return `/login?${search.toString()}`;
}

export function browserApplicationLoginPath(
  callbackPath: string | null | undefined
): string {
  return applicationLoginPath(
    callbackPath,
    process.env.NEXT_PUBLIC_BASE_PATH ?? ""
  );
}

export function browserApplicationLoginHref(
  callbackPath: string | null | undefined
): string {
  const basePath = process.env.NEXT_PUBLIC_BASE_PATH ?? "";
  return applicationPath(
    applicationLoginPath(callbackPath, basePath),
    basePath
  );
}
