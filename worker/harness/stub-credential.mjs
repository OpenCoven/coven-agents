import { createPublicKey, verify } from "node:crypto";
import { readFileSync } from "node:fs";
import { createServer } from "node:http";
import { pathToFileURL } from "node:url";
import { readHarnessConfig } from "./config.mjs";

const PORT = 9797;
const MAX_BODY_BYTES = 8192;
const TOKEN_CLOCK_SKEW_SECONDS = 0;
const FIXTURE_SUBJECT = "3f1a0f4e-1f4d-4a2e-9c1b-7d2f5a6b8c90";
const FIXTURE_TENANT = `u_${FIXTURE_SUBJECT.replaceAll("-", "")}`;

// Keep this boundary identical to verifyRunnerToken in agent-contracts.
function base64UrlDecode(value) {
  return Buffer.from(value, "base64url");
}

function readFixtureConfiguration() {
  const { authVersion, controlToken, keyId, serviceToken } =
    readHarnessConfig();
  const verifyKey = createPublicKey({
    format: "der",
    key: base64UrlDecode(
      readFileSync(new URL("./verify-key.txt", import.meta.url), "utf8").trim()
    ),
    type: "spki",
  });
  return { authVersion, controlToken, keyId, serviceToken, verifyKey };
}

export function fixtureClaims(configuration = readFixtureConfiguration()) {
  return {
    authVersion: configuration.authVersion,
    kid: configuration.keyId,
    plan: "subscriber",
    sub: FIXTURE_SUBJECT,
    tenant: FIXTURE_TENANT,
  };
}

export function isFixtureToken(
  token,
  configuration = readFixtureConfiguration(),
  now = Date.now()
) {
  if (typeof token !== "string") {
    return false;
  }
  const [payload, encodedSignature, extra] = token.split(".");
  if (!payload || !encodedSignature || extra !== undefined) {
    return false;
  }
  let claims;
  try {
    claims = JSON.parse(base64UrlDecode(payload).toString("utf8"));
  } catch {
    return false;
  }
  const expected = fixtureClaims(configuration);
  if (
    claims.authVersion !== expected.authVersion ||
    claims.kid !== expected.kid ||
    claims.plan !== expected.plan ||
    claims.sub !== expected.sub ||
    claims.tenant !== expected.tenant ||
    !Number.isSafeInteger(claims.exp) ||
    claims.exp + TOKEN_CLOCK_SKEW_SECONDS <= Math.floor(now / 1000)
  ) {
    return false;
  }
  try {
    return verify(
      null,
      Buffer.from(payload),
      configuration.verifyKey,
      base64UrlDecode(encodedSignature)
    );
  } catch {
    return false;
  }
}

function authorized(request, configuration) {
  return request.headers["x-service-token"] === configuration.serviceToken;
}

function bearerIdentity(request) {
  const value = request.headers.authorization;
  return typeof value === "string" && value.startsWith("Bearer ")
    ? value.slice("Bearer ".length)
    : null;
}

function readBody(request) {
  return new Promise((resolve, reject) => {
    let body = "";
    request.setEncoding("utf8");
    request.on("data", (chunk) => {
      body += chunk;
      if (Buffer.byteLength(body) > MAX_BODY_BYTES) {
        reject(new Error("body too large"));
        request.destroy();
      }
    });
    request.on("end", () => {
      try {
        resolve(body ? JSON.parse(body) : null);
      } catch {
        reject(new Error("invalid json"));
      }
    });
    request.on("error", reject);
  });
}

function send(response, status, body) {
  response.writeHead(status, { "content-type": "application/json" });
  response.end(JSON.stringify(body));
}

export function createStubServer(configuration = readFixtureConfiguration()) {
  return createServer(async (request, response) => {
    if (request.method !== "POST" || !authorized(request, configuration)) {
      send(response, 401, { error: "unauthorized" });
      return;
    }

    let body;
    try {
      body = await readBody(request);
    } catch {
      send(response, 400, { error: "invalid_request" });
      return;
    }

    const identity = bearerIdentity(request);
    if (!isFixtureToken(identity, configuration)) {
      send(response, 401, { error: "unauthorized" });
      return;
    }

    if (request.url === "/api/internal/runner-authority") {
      if (!body || body.token !== identity) {
        send(response, 401, { error: "unauthorized" });
        return;
      }
      send(response, 200, { allowed: true });
      return;
    }

    if (request.url === "/api/internal/credential") {
      if (
        !body ||
        body.tenant !== FIXTURE_TENANT ||
        typeof body.harnessId !== "string" ||
        typeof body.runId !== "string"
      ) {
        send(response, 403, { error: "tenant_mismatch" });
        return;
      }
      send(response, 200, {
        credential:
          process.env.COPILOT_GITHUB_TOKEN ?? "stub-credential-not-real",
      });
      return;
    }

    send(response, 404, {});
  });
}

if (
  process.argv[1] &&
  import.meta.url === pathToFileURL(process.argv[1]).href
) {
  const server = createStubServer();
  server.listen(PORT, () => {
    console.log(`stub credential server listening on ${PORT}`);
  });
}
