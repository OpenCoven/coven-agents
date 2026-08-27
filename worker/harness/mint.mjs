import { createPrivateKey, sign } from "node:crypto";
import { readFileSync } from "node:fs";

const subject = "3f1a0f4e-1f4d-4a2e-9c1b-7d2f5a6b8c90";
const keyId = process.env.RUNNER_VERIFY_KEY_ID ?? "key-local";
const authVersion = Number(process.env.RUNNER_AUTH_VERSION ?? "0");
if (!/^[A-Za-z0-9][A-Za-z0-9._-]{0,63}$/.test(keyId)) {
  throw new Error("RUNNER_VERIFY_KEY_ID must be a valid key id.");
}
if (!Number.isSafeInteger(authVersion) || authVersion < 0) {
  throw new Error("RUNNER_AUTH_VERSION must be a non-negative integer.");
}

const key = createPrivateKey(
  readFileSync(new URL("./private.pem", import.meta.url))
);
const claims = {
  authVersion,
  exp: Math.floor(Date.now() / 1000) + 900,
  kid: keyId,
  plan: "subscriber",
  sub: subject,
  tenant: `u_${subject.replaceAll("-", "")}`,
};
const payload = Buffer.from(JSON.stringify(claims)).toString("base64url");
const signature = sign(null, Buffer.from(payload), key).toString("base64url");
process.stdout.write(`${payload}.${signature}`);
