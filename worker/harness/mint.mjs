import { createPrivateKey, sign } from "node:crypto";
import { readFileSync } from "node:fs";
import { readHarnessConfig } from "./config.mjs";

const subject = "3f1a0f4e-1f4d-4a2e-9c1b-7d2f5a6b8c90";
const { authVersion, keyId } = readHarnessConfig();

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
