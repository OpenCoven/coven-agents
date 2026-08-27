export const DEFAULT_RUNNER_URL = "http://127.0.0.1:8788";

const KEY_ID_PATTERN = /^[A-Za-z0-9][A-Za-z0-9._-]{0,63}$/u;

function requiredSecret(environment, name) {
  const value = environment[name]?.trim();
  if (!value) {
    throw new Error(
      `${name} is required. Set it in worker/.dev.vars before running the harness.`
    );
  }
  return value;
}

function requiredValue(environment, name) {
  const value = environment[name]?.trim();
  if (!value) {
    throw new Error(
      `${name} is required. Set it in worker/.dev.vars before running the harness.`
    );
  }
  return value;
}

function parseAuthVersion(value) {
  const authVersion = Number(value);
  if (!Number.isSafeInteger(authVersion) || authVersion < 0) {
    throw new Error("RUNNER_AUTH_VERSION must be a non-negative integer.");
  }
  return authVersion;
}

function parseRunnerUrl(value) {
  let url;
  try {
    url = new URL(value);
  } catch (error) {
    throw new Error("RUNNER_URL must be a valid HTTP(S) URL.", {
      cause: error,
    });
  }
  if (
    (url.protocol !== "http:" && url.protocol !== "https:") ||
    url.username ||
    url.password
  ) {
    throw new Error("RUNNER_URL must be a valid HTTP(S) URL.");
  }
  return url.toString().replace(/\/$/u, "");
}

export function readHarnessConfig(environment = process.env) {
  const keyId = requiredValue(environment, "RUNNER_VERIFY_KEY_ID");
  if (!KEY_ID_PATTERN.test(keyId)) {
    throw new Error("RUNNER_VERIFY_KEY_ID must be a valid key id.");
  }

  const authVersion = parseAuthVersion(
    requiredValue(environment, "RUNNER_AUTH_VERSION")
  );
  const runnerUrl = parseRunnerUrl(
    environment.RUNNER_URL?.trim() || DEFAULT_RUNNER_URL
  );

  return {
    authVersion,
    controlToken: requiredSecret(environment, "AGENT_CONTROL_TOKEN"),
    keyId,
    runnerUrl,
    serviceToken: requiredSecret(environment, "RUNNER_SERVICE_TOKEN"),
  };
}
