import { generateKeyPairSync } from "node:crypto";
import { writeFileSync } from "node:fs";

const { privateKey, publicKey } = generateKeyPairSync("ed25519");
writeFileSync(
  new URL("./private.pem", import.meta.url),
  privateKey.export({ format: "pem", type: "pkcs8" })
);
const spki = publicKey.export({ format: "der", type: "spki" });
writeFileSync(
  new URL("./verify-key.txt", import.meta.url),
  Buffer.from(spki).toString("base64url")
);
console.log("keys written");
