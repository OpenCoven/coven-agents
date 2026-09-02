import assert from "node:assert/strict";
import test from "node:test";
import {
  exactEvidenceRedactions,
  sanitizeEvidenceText,
} from "@opencoven/agent-contracts";
import { sanitizeRunText } from "./evidence";
import {
  decodeRunnerAttemptRedactionSecrets,
  encodeRunnerAttemptRedactionSecrets,
} from "./redaction-secrets";

test("attempt redaction material round-trips multiple exact secrets without exposing metadata", () => {
  const secrets = [
    "copilot-runtime-credential",
    Buffer.alloc(32, 0x6a).toString("base64url"),
  ];
  const encoded = encodeRunnerAttemptRedactionSecrets(secrets);
  assert.deepEqual(decodeRunnerAttemptRedactionSecrets(encoded), secrets);
  assert.notEqual(encoded, secrets[0]);
  assert.ok(encoded.length <= 16_384);
});

test("runner evidence redacts every encoded attempt secret and preserves legacy envelopes", () => {
  const secrets = [
    "copilot-runtime-credential",
    Buffer.alloc(32, 0x6b).toString("base64url"),
  ];
  const encoded = encodeRunnerAttemptRedactionSecrets(secrets);
  const text = `first=${secrets[0]} second=${secrets[1]}`;
  const sanitized = sanitizeRunText(
    text,
    exactEvidenceRedactions(...decodeRunnerAttemptRedactionSecrets(encoded))
  );
  assert.doesNotMatch(sanitized, new RegExp(secrets[0], "u"));
  assert.doesNotMatch(sanitized, new RegExp(secrets[1], "u"));
  assert.match(sanitized, /\[REDACTED\]/u);

  assert.deepEqual(
    decodeRunnerAttemptRedactionSecrets("legacy-single-secret"),
    ["legacy-single-secret"]
  );
  assert.equal(
    sanitizeEvidenceText(
      "legacy-single-secret",
      exactEvidenceRedactions(
        ...decodeRunnerAttemptRedactionSecrets("legacy-single-secret")
      )
    ),
    "[REDACTED]"
  );
});

test("redaction encoding rejects empty, duplicate, excessive, or control-bearing secrets", () => {
  for (const secrets of [
    [],
    [""],
    ["same", "same"],
    ["control\u0000value"],
    Array.from({ length: 9 }, (_, index) => `secret-${index}`),
    ["x".repeat(16_385)],
  ]) {
    assert.throws(
      () => encodeRunnerAttemptRedactionSecrets(secrets),
      /redaction secret/i
    );
  }
});
