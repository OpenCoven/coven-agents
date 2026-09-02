type Environment = Readonly<Record<string, string | undefined>>;

export function e2eOrigin(environment: Environment = process.env): string {
  return environment.APP_ORIGIN ?? "http://localhost:3100";
}

export function e2eCookieDomain(
  environment: Environment = process.env
): string {
  return new URL(e2eOrigin(environment)).hostname;
}
