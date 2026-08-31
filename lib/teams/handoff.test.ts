import assert from "node:assert/strict";
import test from "node:test";
import {
  TEAM_LIMITS,
  type TeamHandoff,
  teamHandoffSchema,
} from "@opencoven/agent-contracts";
import { buildTeamHandoff, TEAM_HANDOFF_TRUNCATION_MARKER } from "./handoff";

const NOW = "2026-08-31T08:00:00.000Z";

function serializedBytes(value: unknown): number {
  return Buffer.byteLength(JSON.stringify(value));
}

function built(result: ReturnType<typeof buildTeamHandoff>) {
  if (result.kind !== "built") {
    assert.fail(result.message);
  }
  return result;
}

function handoff(output: string): TeamHandoff {
  return {
    commandEvidence: [],
    fileEvidence: [],
    output,
  };
}

test("sanitizes final output and normalized command and file evidence", () => {
  const secret = ["sk", "proj", "abcdefghijklmnopqrstuvwxyz"].join("-");
  const authorization = "Bearer top-secret-authorization";
  const result = built(
    buildTeamHandoff({
      commandEvidence: [
        {
          command: `curl -H "Authorization: ${authorization}"`,
          completedAt: NOW,
          exitCode: 0,
          stderr: "password=hunter2",
          stdout: `OPENAI_API_KEY=${secret}`,
        },
      ],
      fileEvidence: [
        {
          byteLength: 12,
          occurredAt: NOW,
          operation: "create",
          path: "/Users/alice/project/.env",
        },
      ],
      output: [
        `Authorization: ${authorization}`,
        `token=${secret}`,
        'record={"credential":{"encrypted":"ciphertext"},"safe":"ok"}',
        "HOME=/Users/alice",
        "PATH=/usr/bin",
      ].join("\n"),
    })
  );
  const serialized = JSON.stringify(result.handoff);

  assert.equal(serialized.includes(secret), false);
  assert.equal(serialized.includes("top-secret-authorization"), false);
  assert.equal(serialized.includes("hunter2"), false);
  assert.equal(serialized.includes("ciphertext"), false);
  assert.equal(serialized.includes("/Users/alice"), false);
  assert.match(serialized, /\[REDACTED\]/u);
  assert.match(result.handoff.fileEvidence[0]?.path ?? "", /^~\/project/u);
  assert.equal(teamHandoffSchema.safeParse(result.handoff).success, true);
});

test("omits malformed evidence and never copies provider metadata fields", () => {
  const result = built(
    buildTeamHandoff({
      commandEvidence: [
        {
          command: null,
          daytonaLogs: "RAW DAYTONA LOGS",
          encryptedCredential: "encrypted-record",
          sessionId: "daytona-session-123",
          tenantId: "tenant-secret",
        },
        {
          command: "pnpm test",
          commandId: "daytona-command-456",
          daytonaLogs: "OTHER RAW LOGS",
          exitCode: 0,
          stderr: "",
          stdout: "passed",
          tenantId: "tenant-secret",
        },
      ],
      fileEvidence: [
        {
          operation: "unsafe",
          path: "/workspace/file.ts",
          rawLogs: "FILE RAW LOGS",
          sessionId: "daytona-session-789",
        },
      ],
      output: "Tests passed.",
    })
  );
  const serialized = JSON.stringify(result.handoff);

  assert.equal(result.handoff.commandEvidence.length, 1);
  assert.equal(result.handoff.fileEvidence.length, 0);
  for (const forbidden of [
    "RAW DAYTONA LOGS",
    "OTHER RAW LOGS",
    "FILE RAW LOGS",
    "daytona-session",
    "daytona-command",
    "tenant-secret",
    "encrypted-record",
  ]) {
    assert.equal(serialized.includes(forbidden), false);
  }
});

test("truncates oversized multibyte content with a public-safe marker", () => {
  const result = built(
    buildTeamHandoff({
      commandEvidence: [],
      fileEvidence: [],
      output: "😀".repeat(TEAM_LIMITS.maxHandoffLength),
    })
  );

  assert.ok(serializedBytes(result.handoff) <= TEAM_LIMITS.maxHandoffLength);
  assert.ok(result.handoff.output.endsWith(TEAM_HANDOFF_TRUNCATION_MARKER));
  assert.equal(result.handoff.output.includes("\uFFFD"), false);
  assert.equal(
    new TextDecoder("utf-8", { fatal: true }).decode(
      new TextEncoder().encode(result.handoff.output)
    ),
    result.handoff.output
  );
});

test("fills the exact per-step serialized boundary when safe text is available", () => {
  const result = built(
    buildTeamHandoff({
      output: "x".repeat(TEAM_LIMITS.maxHandoffLength * 2),
    })
  );

  assert.equal(serializedBytes(result.handoff), TEAM_LIMITS.maxHandoffLength);
  assert.ok(result.handoff.output.endsWith(TEAM_HANDOFF_TRUNCATION_MARKER));
});

test("redacts labeled execution metadata and normalizes a missing exit code", () => {
  const result = built(
    buildTeamHandoff({
      commandEvidence: [
        {
          command: "pnpm test",
          stderr: "",
          stdout: "passed",
        },
      ],
      output: [
        "Daytona logs: raw-daytona-log",
        "Daytona session ID: session-123",
        "Daytona command ID: command-456",
        "Tenant ID: tenant-789",
      ].join("\n"),
    })
  );
  const serialized = JSON.stringify(result.handoff);

  assert.equal(result.handoff.commandEvidence[0]?.exitCode, null);
  for (const forbidden of [
    "raw-daytona-log",
    "session-123",
    "command-456",
    "tenant-789",
  ]) {
    assert.equal(serialized.includes(forbidden), false);
  }
});

test("redacts complete nested operational metadata values and fails closed for malformed JSON", () => {
  const nestedMarkers = [
    "HANDOFF_RAW_LOG_SECRET",
    "HANDOFF_PROVIDER_LOG_SECRET",
    "HANDOFF_SESSION_SECRET",
    "HANDOFF_TENANT_SECRET",
    "HANDOFF_CREDENTIAL_SECRET",
    "HANDOFF_ENCRYPTED_SECRET",
  ];
  const malformedMarker = "HANDOFF_MALFORMED_SECRET";
  const result = built(
    buildTeamHandoff({
      output: [
        JSON.stringify({
          credential: { records: [{ value: nestedMarkers[4] }] },
          encrypted: [{ record: { value: nestedMarkers[5] } }],
          providerLogs: [{ details: nestedMarkers[1] }],
          rawLogs: {
            first: "ordinary log",
            second: nestedMarkers[0],
          },
          safe: "preserved",
          session: { metadata: { value: nestedMarkers[2] } },
          tenant: [{ metadata: nestedMarkers[3] }],
        }),
        `{"rawLogs":{"first":"ordinary","second":"${malformedMarker}"},"safe":`,
      ].join("\n"),
    })
  );
  const serialized = JSON.stringify(result.handoff);

  for (const marker of [...nestedMarkers, malformedMarker]) {
    assert.equal(serialized.includes(marker), false);
  }
  assert.equal(serialized.includes("preserved"), true);
  assert.match(serialized, /\[REDACTED\]/u);
});

test("keeps identical command records associated with their own output after truncation", () => {
  const firstOutput = `FIRST_COMMAND_OUTPUT:${"a".repeat(12_000)}`;
  const secondOutput = `SECOND_COMMAND_OUTPUT:${"b".repeat(12_000)}`;
  const result = built(
    buildTeamHandoff({
      commandEvidence: [
        {
          command: "pnpm test",
          completedAt: NOW,
          exitCode: 11,
          startedAt: NOW,
          stderr: "",
          stdout: firstOutput,
        },
        {
          command: "pnpm test",
          completedAt: NOW,
          exitCode: 22,
          startedAt: NOW,
          stderr: "",
          stdout: secondOutput,
        },
      ],
      output: "Command evidence summary.",
    })
  );

  assert.ok(result.handoff.output.endsWith(TEAM_HANDOFF_TRUNCATION_MARKER));
  assert.equal(result.handoff.commandEvidence.length, 2);
  assert.equal(result.handoff.commandEvidence[0]?.exitCode, 11);
  assert.match(
    result.handoff.commandEvidence[0]?.stdout ?? "",
    /FIRST_COMMAND_OUTPUT/u
  );
  assert.doesNotMatch(
    result.handoff.commandEvidence[0]?.stdout ?? "",
    /SECOND_COMMAND_OUTPUT/u
  );
  assert.equal(result.handoff.commandEvidence[1]?.exitCode, 22);
  assert.match(
    result.handoff.commandEvidence[1]?.stdout ?? "",
    /SECOND_COMMAND_OUTPUT/u
  );
  assert.doesNotMatch(
    result.handoff.commandEvidence[1]?.stdout ?? "",
    /FIRST_COMMAND_OUTPUT/u
  );
});

test("uses the exact remaining aggregate byte budget without exceeding it", () => {
  const prior = handoff("prior");
  const remaining =
    serializedBytes(handoff(TEAM_HANDOFF_TRUNCATION_MARKER)) + 4;
  const consumedBytes = TEAM_LIMITS.maxTotalHandoffLength - remaining;
  const result = built(
    buildTeamHandoff({
      commandEvidence: [],
      consumedBytes,
      fileEvidence: [],
      output: "abcdefghijk".repeat(100),
    })
  );

  assert.equal(result.totalConsumedBytes, TEAM_LIMITS.maxTotalHandoffLength);
  assert.equal(
    result.serializedBytes,
    TEAM_LIMITS.maxTotalHandoffLength - consumedBytes
  );
  assert.ok(result.handoff.output.endsWith(TEAM_HANDOFF_TRUNCATION_MARKER));

  const priorResult = built(
    buildTeamHandoff({
      commandEvidence: [],
      fileEvidence: [],
      output: "next",
      priorHandoffs: [prior],
    })
  );
  assert.equal(
    priorResult.totalConsumedBytes,
    serializedBytes(prior) + priorResult.serializedBytes
  );
});

test("fails closed for invalid, ambiguous, or exhausted prior state", () => {
  const invalidPrior = buildTeamHandoff({
    output: "next",
    priorHandoffs: [{ ...handoff("prior"), secret: "leak" }],
  });
  const ambiguousPrior = buildTeamHandoff({
    consumedBytes: 1,
    output: "next",
    priorHandoffs: [],
  });
  const exhausted = buildTeamHandoff({
    consumedBytes: TEAM_LIMITS.maxTotalHandoffLength,
    output: "next",
  });

  assert.deepEqual(
    [invalidPrior.kind, ambiguousPrior.kind, exhausted.kind],
    ["invalid", "invalid", "invalid"]
  );
  if (
    invalidPrior.kind === "invalid" &&
    ambiguousPrior.kind === "invalid" &&
    exhausted.kind === "invalid"
  ) {
    assert.equal(invalidPrior.code, "invalid-prior-handoff");
    assert.equal(ambiguousPrior.code, "ambiguous-prior-budget");
    assert.equal(exhausted.code, "handoff-budget-exhausted");
    assert.equal(invalidPrior.message.includes("leak"), false);
  }
});

test("does not mutate caller-owned evidence or prior handoffs", () => {
  const command = Object.freeze({
    command: "echo ok",
    exitCode: 0,
    stderr: "",
    stdout: "ok",
  });
  const file = Object.freeze({
    operation: "create",
    path: "/Users/alice/project/file.ts",
  });
  const prior = Object.freeze(handoff("prior"));
  const commandEvidence = Object.freeze([command]);
  const fileEvidence = Object.freeze([file]);
  const priorHandoffs = Object.freeze([prior]);

  built(
    buildTeamHandoff({
      commandEvidence,
      fileEvidence,
      output: "done",
      priorHandoffs,
    })
  );

  assert.equal(commandEvidence[0], command);
  assert.equal(fileEvidence[0], file);
  assert.equal(priorHandoffs[0], prior);
});
