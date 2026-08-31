const PATH_ORIGIN = "https://application-path.invalid";

type ApplicationBasePathEnvironment = Readonly<
  Record<string, string | undefined>
>;

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
