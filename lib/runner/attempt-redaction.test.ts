import assert from "node:assert/strict";
import test from "node:test";
import { generateKek } from "@/lib/credentials/envelope";
import type { CredentialKekRing } from "@/lib/credentials/key-ring";
import {
  openRunnerAttemptRedaction,
  sealRunnerAttemptRedaction,
} from "./attempt-redaction";

const credential = "credential-which-must-never-persist";
const input = {
  attemptId: "53af1a29-4e98-43d6-ac5b-3b9dcba5e730",
  runId: "53af1a29-4e98-43d6-ac5b-3b9dcba5e731",
  tenant: "tenant_a",
};

async function ring(): Promise<CredentialKekRing> {
  const current = await generateKek();
  return {
    current,
    currentVersion: "v1",
    keyFor: () => current,
    versions: ["v1"],
  };
}

test("attempt redaction encrypts an exact credential with run tenant and attempt binding", async () => {
  const keyRing = await ring();
  const sealed = await sealRunnerAttemptRedaction(
    { ...input, credential },
    keyRing
  );

  assert.equal(JSON.stringify(sealed).includes(credential), false);
  assert.equal(
    await openRunnerAttemptRedaction(input, sealed, keyRing),
    credential
  );
  await assert.rejects(() =>
    openRunnerAttemptRedaction(
      {
        ...input,
        attemptId: "53af1a29-4e98-43d6-ac5b-3b9dcba5e732",
      },
      sealed,
      keyRing
    )
  );
  await assert.rejects(() =>
    openRunnerAttemptRedaction(
      {
        ...input,
        runId: "53af1a29-4e98-43d6-ac5b-3b9dcba5e733",
      },
      sealed,
      keyRing
    )
  );
  await assert.rejects(() =>
    openRunnerAttemptRedaction(
      { ...input, tenant: "tenant_b" },
      sealed,
      keyRing
    )
  );
});
