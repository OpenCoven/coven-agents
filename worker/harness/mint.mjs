import { createPrivateKey, sign } from "node:crypto";
import { readFileSync } from "node:fs";

const key = createPrivateKey(
  readFileSync(new URL("./private.pem", import.meta.url))
);
const claims = {
  exp: Math.floor(Date.now() / 1000) + 900,
  plan: "subscriber",
  sub: "3f1a0f4e-1f4d-4a2e-9c1b-7d2f5a6b8c90",
  tenant: "u_harnesslocaltester0000000000000000",
};
const payload = Buffer.from(JSON.stringify(claims)).toString("base64url");
const signature = sign(null, Buffer.from(payload), key).toString("base64url");
process.stdout.write(`${payload}.${signature}`);
