import assert from "node:assert/strict";
import {
  chmodSync,
  mkdtempSync,
  readFileSync,
  rmSync,
  statSync,
  writeFileSync,
} from "node:fs";
import { join } from "node:path";
import test from "node:test";

const origin = "https://staging.opencoven.test";
const deploymentId = `dpl_${"A1b2C3d4".repeat(4)}`;
const sourceSha = "a".repeat(40);
const sourceTreeSha = "b".repeat(40);
const fixedNow = new Date("2026-09-02T05:04:06.000Z");
const environment = {
  CRON_SECRET: "scheduled-reconciliation-fixture",
  OPERATOR_DIAGNOSTIC_TOKEN: "diagnostic-operator-fixture",
  RUNNER_MANUAL_RECONCILE_SECRET: "manual-reconciliation-fixture",
} as const;

type FetchHandler =
  | Response
  | ((
      input: string | URL | Request,
      init?: RequestInit
    ) => Promise<Response> | Response);

type RecordedRequest = {
  authorization: string | null;
  method: string;
  redirect: RequestRedirect | undefined;
  signal: AbortSignal | null;
  url: string;
};

function options(outputPath = "staging-certification.json") {
  return [
    "--origin",
    origin,
    "--deployment-id",
    deploymentId,
    "--source-sha",
    sourceSha,
    "--source-tree-sha",
    sourceTreeSha,
    "--app-build",
    "staging-build-2026-09-02",
    "--output",
    outputPath,
    "--confirm-effects",
  ];
}

function json(body: unknown, status = 200): Response {
  return new Response(JSON.stringify(body), {
    headers: { "content-type": "application/json; charset=utf-8" },
    status,
  });
}

function health() {
  return {
    apiVersion: "1.0",
    capabilities: [
      "agent-profiles",
      "async-runs",
      "idempotent-runs",
      "run-events",
      "run-cancel",
      "command-evidence",
      "file-evidence",
    ],
    minimumClientVersion: "1.0.0",
    mode: "cloud",
  };
}

function inventory(ambiguous = 4) {
  return {
    ambiguityReasons: {
      configurationDrift: 0,
      databaseBounded: 0,
      duplicateIdentity: 0,
      duplicateProviderId: 0,
      multipleMappings: 0,
      pendingLifecycle: 0,
      unresolved: ambiguous,
    },
    ambiguous,
    appOwnedMappings: ambiguous,
    configurationDrift: [],
    databaseCapped: false,
    examined: ambiguous,
    matched: 0,
    providerCapped: false,
    states: {
      active: 0,
      archived: 0,
      other: 0,
      stopped: ambiguous,
    },
    status: "complete",
    unowned: 0,
    version: 1,
  };
}

function reconciliation() {
  return {
    adopted: 0,
    deferred: 0,
    dispatched: 0,
    execution: "executed",
    expiredScanned: 0,
    failures: 0,
    logEvents: 0,
    requeued: 0,
    sandboxRecovered: 0,
    terminalCleaned: 0,
    terminalized: 0,
    terminalLeaseCleaned: 0,
  };
}

function unauthorized(requestId: string) {
  return {
    apiVersion: "1.0",
    error: {
      code: "unauthorized",
      message: "Operator token was rejected.",
      retryable: false,
    },
    requestId,
  };
}

function successfulHandlers(): FetchHandler[] {
  return [
    json(health()),
    new Response(null, {
      headers: { location: "/login?beta=1" },
      status: 307,
    }),
    json({
      containment: {
        credentialRemoved: true,
        detachedDescendantObserved: true,
        reusePolicy: "sandbox_reset_required",
      },
      exitCode: 0,
      ok: true,
      output: "coven-agents",
      snapshot: {
        name: "coven-agents-copilot-2",
        resources: { cpu: 2, disk: 10, memory: 4 },
        target: "us",
      },
    }),
    json({
      applied: 0,
      conflicts: 0,
      deferred: 0,
      execution: "executed",
      failures: 0,
      scanned: 0,
      unchanged: 0,
    }),
    json(inventory()),
    json(reconciliation()),
    json(reconciliation()),
    json(inventory()),
    json(unauthorized("8069c025-0add-454a-9b5e-4f5ccdc9a23b"), 401),
    json(unauthorized("2dd79a06-62a7-4396-86e6-00971899024e"), 401),
    json(unauthorized("14389c8a-5db2-4c96-a784-e7b8f4985808"), 401),
  ];
}

function queuedFetch(
  handlers: FetchHandler[],
  calls: RecordedRequest[] = []
): typeof fetch {
  return (async (input: string | URL | Request, init?: RequestInit) => {
    const request = new Request(input, init);
    calls.push({
      authorization: request.headers.get("authorization"),
      method: request.method,
      redirect: init?.redirect,
      signal: init?.signal ?? null,
      url: request.url,
    });
    const handler = handlers[calls.length - 1];
    assert.ok(handler, `unexpected request ${calls.length}: ${request.url}`);
    return typeof handler === "function" ? await handler(input, init) : handler;
  }) as typeof fetch;
}

async function subject() {
  return await import("./staging-certification");
}

test("collects bounded staging evidence in deterministic credential-isolated order", async () => {
  const {
    collectStagingCertification,
    parseStagingCertificationArguments,
    stagingCertificationReceiptSchema,
  } = await subject();
  const calls: RecordedRequest[] = [];
  const parsed = parseStagingCertificationArguments(options());
  const receipt = await collectStagingCertification(parsed, environment, {
    fetch: queuedFetch(successfulHandlers(), calls),
    now: () => fixedNow,
  });

  assert.deepEqual(
    calls.map(({ method, url }) => [method, new URL(url).pathname]),
    [
      ["GET", "/api/health"],
      ["GET", "/agents"],
      ["POST", "/api/diagnostics/sandbox"],
      ["GET", "/api/internal/stripe-reconcile"],
      ["GET", "/api/internal/runner-resource-inventory"],
      ["POST", "/api/internal/runner-reconcile"],
      ["POST", "/api/internal/runner-reconcile"],
      ["GET", "/api/internal/runner-resource-inventory"],
      ["GET", "/api/internal/runner-resource-inventory"],
      ["POST", "/api/diagnostics/sandbox"],
      ["POST", "/api/internal/runner-reconcile"],
    ]
  );
  assert.deepEqual(
    calls.map(({ authorization }) => authorization),
    [
      null,
      null,
      `Bearer ${environment.OPERATOR_DIAGNOSTIC_TOKEN}`,
      `Bearer ${environment.CRON_SECRET}`,
      `Bearer ${environment.CRON_SECRET}`,
      `Bearer ${environment.RUNNER_MANUAL_RECONCILE_SECRET}`,
      `Bearer ${environment.RUNNER_MANUAL_RECONCILE_SECRET}`,
      `Bearer ${environment.CRON_SECRET}`,
      `Bearer ${environment.OPERATOR_DIAGNOSTIC_TOKEN}`,
      `Bearer ${environment.RUNNER_MANUAL_RECONCILE_SECRET}`,
      `Bearer ${environment.CRON_SECRET}`,
    ]
  );
  assert.ok(calls.every(({ redirect }) => redirect === "manual"));
  assert.equal(receipt.capturedAt, fixedNow.toISOString());
  assert.equal(receipt.checks.closedBetaRefusal.outcome, "refused");
  assert.equal(receipt.checks.sandboxDiagnostic.outcome, "passed");
  assert.deepEqual(receipt.checks.sandboxDiagnostic.containment, {
    credentialRemoved: true,
    detachedDescendantObserved: true,
    reusePolicy: "sandbox_reset_required",
  });
  assert.deepEqual(receipt.checks.sandboxDiagnostic.snapshot, {
    name: "coven-agents-copilot-2",
    resources: { cpu: 2, disk: 10, memory: 4 },
    target: "us",
  });
  assert.equal(receipt.checks.resourceInventory.before.ambiguous, 4);
  assert.equal(receipt.checks.resourceInventory.after.ambiguous, 4);
  assert.deepEqual(
    receipt.checks.credentialIsolation.map((probe) => probe.outcome),
    ["unauthorized", "unauthorized", "unauthorized"]
  );
  assert.deepEqual(receipt.evidenceFlags, {
    approvalsCompleted: false,
    diagnosticLifecycleCertified: true,
    observationWindowCompleted: false,
    persistentSandboxLifecycleCertified: false,
    resourceDispositionCertified: false,
    stripeCheckoutWebhookFailureRetryCertified: false,
    subscriberLifecycleCertified: false,
  });
  assert.deepEqual(receipt.certificationScope, {
    finalReadinessDecisionIncluded: false,
    stagingEvidenceCollectionOnly: true,
  });
  assert.equal(receipt.containsCredentialMaterial, false);
  assert.deepEqual(stagingCertificationReceiptSchema.parse(receipt), receipt);
});

test("records signed-out redirect refusal only for the exact closed-beta redirect", async () => {
  const { collectStagingCertification, parseStagingCertificationArguments } =
    await subject();
  const handlers = successfulHandlers();
  handlers[1] = json({ page: "agents" });

  const receipt = await collectStagingCertification(
    parseStagingCertificationArguments(options()),
    environment,
    {
      fetch: queuedFetch(handlers),
      now: () => fixedNow,
    }
  );

  assert.equal(receipt.checks.closedBetaRefusal.outcome, "unexpected_response");
  assert.equal(receipt.checks.closedBetaRefusal.status, 200);
});

test("treats a wrong credential accepted by another operator channel as a bounded failure", async () => {
  const { collectStagingCertification, parseStagingCertificationArguments } =
    await subject();
  const handlers = successfulHandlers();
  handlers[8] = json(inventory());

  const receipt = await collectStagingCertification(
    parseStagingCertificationArguments(options()),
    environment,
    {
      fetch: queuedFetch(handlers),
      now: () => fixedNow,
    }
  );

  assert.equal(
    receipt.checks.credentialIsolation[0]?.outcome,
    "credential_accepted"
  );
  assert.equal(receipt.checks.credentialIsolation[0]?.status, 200);
});

test("does not certify a diagnostic when JSON has a failure status", async () => {
  const { collectStagingCertification, parseStagingCertificationArguments } =
    await subject();
  const handlers = successfulHandlers();
  handlers[2] = json({ exitCode: 0, ok: true, output: "coven-agents" }, 503);

  const receipt = await collectStagingCertification(
    parseStagingCertificationArguments(options()),
    environment,
    {
      fetch: queuedFetch(handlers),
      now: () => fixedNow,
    }
  );

  assert.equal(receipt.checks.sandboxDiagnostic.outcome, "unexpected_response");
  assert.equal(receipt.checks.sandboxDiagnostic.status, 503);
  assert.equal(receipt.evidenceFlags.diagnosticLifecycleCertified, false);
});

test("does not certify successful HTTP diagnostics with invalid receipts", async () => {
  const { collectStagingCertification, parseStagingCertificationArguments } =
    await subject();
  await Promise.all(
    [200, 202].map(async (status) => {
      const handlers = successfulHandlers();
      handlers[2] = json(
        { exitCode: 0, ok: true, output: "coven-agents" },
        status
      );

      const receipt = await collectStagingCertification(
        parseStagingCertificationArguments(options()),
        environment,
        {
          fetch: queuedFetch(handlers),
          now: () => fixedNow,
        }
      );

      assert.equal(
        receipt.checks.sandboxDiagnostic.outcome,
        "unexpected_response"
      );
      assert.equal(receipt.evidenceFlags.diagnosticLifecycleCertified, false);
    })
  );
});

test("categorizes malformed, oversized, and timed-out responses without raw output", async () => {
  const {
    collectStagingCertification,
    MAX_STAGING_CERTIFICATION_RESPONSE_BYTES,
    parseStagingCertificationArguments,
  } = await subject();

  const malformedHandlers = successfulHandlers();
  malformedHandlers[0] = new Response('{"apiVersion":', {
    headers: { "content-type": "application/json" },
  });
  const malformed = await collectStagingCertification(
    parseStagingCertificationArguments(options()),
    environment,
    {
      fetch: queuedFetch(malformedHandlers),
      now: () => fixedNow,
    }
  );
  assert.equal(malformed.checks.health.outcome, "malformed_response");

  let overflowAborted = false;
  const oversizedHandlers = successfulHandlers();
  oversizedHandlers[0] = (_input, init) => {
    init?.signal?.addEventListener("abort", () => {
      overflowAborted = true;
    });
    return Response.json({
      privateProviderOutput: "x".repeat(
        MAX_STAGING_CERTIFICATION_RESPONSE_BYTES
      ),
    });
  };
  const oversized = await collectStagingCertification(
    parseStagingCertificationArguments(options()),
    environment,
    {
      fetch: queuedFetch(oversizedHandlers),
      now: () => fixedNow,
    }
  );
  assert.equal(oversized.checks.health.outcome, "oversized_response");
  assert.equal(overflowAborted, true);

  const timeoutHandlers = successfulHandlers();
  timeoutHandlers[0] = (_input, init) =>
    new Promise<Response>((_resolve, reject) => {
      init?.signal?.addEventListener("abort", () => {
        reject(new Error("provider deadline contained private details"));
      });
    });
  const timedOut = await collectStagingCertification(
    parseStagingCertificationArguments(options()),
    environment,
    {
      fetch: queuedFetch(timeoutHandlers),
      now: () => fixedNow,
      requestTimeoutMs: 1,
    }
  );
  const serialized = JSON.stringify(timedOut);
  assert.equal(timedOut.checks.health.outcome, "timeout");
  assert.doesNotMatch(serialized, /provider deadline|private details/u);
});

test("uses fatal UTF-8 and JSON-only response parsing", async () => {
  const { collectStagingCertification, parseStagingCertificationArguments } =
    await subject();
  const utf8Handlers = successfulHandlers();
  utf8Handlers[0] = new Response(Uint8Array.from([0xc3, 0x28]), {
    headers: { "content-type": "application/json" },
  });
  const invalidUtf8 = await collectStagingCertification(
    parseStagingCertificationArguments(options()),
    environment,
    {
      fetch: queuedFetch(utf8Handlers),
      now: () => fixedNow,
    }
  );
  assert.equal(invalidUtf8.checks.health.outcome, "malformed_response");

  const contentTypeHandlers = successfulHandlers();
  contentTypeHandlers[0] = new Response(JSON.stringify(health()), {
    headers: { "content-type": "text/plain" },
  });
  const nonJson = await collectStagingCertification(
    parseStagingCertificationArguments(options()),
    environment,
    {
      fetch: queuedFetch(contentTypeHandlers),
      now: () => fixedNow,
    }
  );
  assert.equal(nonJson.checks.health.outcome, "non_json_response");
});

test("rejects secret-bearing recognized responses and never retains tokens or raw bodies", async () => {
  const { collectStagingCertification, parseStagingCertificationArguments } =
    await subject();
  const secret = `ghp_${"A1b2C3d4E5f6G7h8I9j0".repeat(2)}`;
  const handlers = successfulHandlers();
  handlers[0] = json({
    ...health(),
    minimumClientVersion: secret,
    providerMessage: "raw-provider-private-output",
  });

  const receipt = await collectStagingCertification(
    parseStagingCertificationArguments(options()),
    environment,
    {
      fetch: queuedFetch(handlers),
      now: () => fixedNow,
    }
  );
  const serialized = JSON.stringify(receipt);

  assert.equal(receipt.checks.health.outcome, "unsafe_response");
  assert.doesNotMatch(serialized, new RegExp(secret, "u"));
  assert.doesNotMatch(serialized, /raw-provider-private-output/u);
  for (const token of Object.values(environment)) {
    assert.doesNotMatch(serialized, new RegExp(token, "u"));
  }
});

test("requires exact safe candidate arguments, one build metadata form, and effects confirmation", async () => {
  const { parseStagingCertificationArguments } = await subject();

  assert.throws(
    () =>
      parseStagingCertificationArguments(
        options().map((value) =>
          value === origin ? "http://staging.opencoven.test" : value
        )
      ),
    /usage/iu
  );
  assert.throws(
    () =>
      parseStagingCertificationArguments([
        ...options(),
        "--operator-diagnostic-token",
        "must-never-be-accepted",
      ]),
    /usage/iu
  );
  assert.throws(
    () =>
      parseStagingCertificationArguments(
        options().filter((value) => value !== "--confirm-effects")
      ),
    /usage/iu
  );
  assert.throws(
    () =>
      parseStagingCertificationArguments([
        ...options(),
        "--deployment-metadata",
        "vercel-staging",
      ]),
    /usage/iu
  );
  assert.throws(
    () =>
      parseStagingCertificationArguments(
        options().filter(
          (value) =>
            value !== "--app-build" && value !== "staging-build-2026-09-02"
        )
      ),
    /usage/iu
  );

  const metadataOnly = parseStagingCertificationArguments([
    ...options().filter(
      (value) => value !== "--app-build" && value !== "staging-build-2026-09-02"
    ),
    "--deployment-metadata",
    "vercel-staging-archive",
  ]);
  assert.deepEqual(metadataOnly.build, {
    kind: "deploymentMetadata",
    value: "vercel-staging-archive",
  });
});

test("refuses missing operator environment without making requests or printing credential values", async () => {
  const { runStagingCertificationCli } = await subject();
  const stderr: string[] = [];
  let requests = 0;
  const code = await runStagingCertificationCli(
    options(),
    {},
    {
      fetch: (() => {
        requests += 1;
        return Promise.reject(new Error("must not request"));
      }) as typeof fetch,
      stderr: (message: string) => stderr.push(message),
      stdout: () => {
        throw new Error("must not write stdout");
      },
    }
  );

  assert.equal(code, 2);
  assert.equal(requests, 0);
  assert.equal(stderr.length, 1);
  assert.doesNotMatch(stderr[0] ?? "", /OPERATOR|RUNNER|CRON|secret|token/iu);
});

test("requires the CLI's independently preapproved staging origin before requests", async () => {
  const { runStagingCertificationCli } = await subject();
  let requests = 0;
  const code = await runStagingCertificationCli(
    options(),
    {
      ...environment,
      STAGING_CERTIFICATION_ORIGIN: "https://different-staging.opencoven.test",
    },
    {
      fetch: (() => {
        requests += 1;
        return Promise.reject(new Error("must not request"));
      }) as typeof fetch,
      stderr: () => undefined,
      stdout: () => undefined,
    }
  );

  assert.equal(code, 2);
  assert.equal(requests, 0);
});

test("writes a receipt when the CLI origin matches its preapproved origin", async () => {
  const { runStagingCertificationCli } = await subject();
  const directory = mkdtempSync(
    join(process.cwd(), ".staging-certification-cli-test-")
  );
  const outputPath = join(directory, "receipt.json");
  const stdout: string[] = [];

  try {
    const code = await runStagingCertificationCli(
      options(outputPath),
      {
        ...environment,
        STAGING_CERTIFICATION_ORIGIN: origin,
      },
      {
        fetch: queuedFetch(successfulHandlers()),
        now: () => fixedNow,
        stderr: () => undefined,
        stdout: (message: string) => stdout.push(message),
      }
    );

    assert.equal(code, 0);
    assert.deepEqual(stdout, ["Staging certification evidence collected.\n"]);
    const serialized = readFileSync(outputPath, "utf8");
    for (const credential of Object.values(environment)) {
      assert.doesNotMatch(serialized, new RegExp(credential, "u"));
    }
  } finally {
    rmSync(directory, { force: true, recursive: true });
  }
});

test("writes a mode-0600 receipt atomically and refuses to overwrite", async () => {
  const {
    collectStagingCertification,
    parseStagingCertificationArguments,
    writeStagingCertificationReceipt,
  } = await subject();
  const directory = mkdtempSync(
    join(process.cwd(), ".staging-certification-test-")
  );
  const outputPath = join(directory, "receipt.json");

  try {
    const receipt = await collectStagingCertification(
      parseStagingCertificationArguments(options(outputPath)),
      environment,
      {
        fetch: queuedFetch(successfulHandlers()),
        now: () => fixedNow,
      }
    );
    await writeStagingCertificationReceipt(receipt, outputPath, environment, {
      randomSuffix: () => "atomic-write-fixture",
    });
    assert.equal(statSync(outputPath).mode & 0o777, 0o600);
    assert.deepEqual(JSON.parse(readFileSync(outputPath, "utf8")), receipt);

    writeFileSync(outputPath, "existing receipt\n");
    chmodSync(outputPath, 0o600);
    await assert.rejects(
      writeStagingCertificationReceipt(receipt, outputPath, environment, {
        randomSuffix: () => "second-atomic-write-fixture",
      }),
      /exists/iu
    );
    assert.equal(readFileSync(outputPath, "utf8"), "existing receipt\n");
  } finally {
    rmSync(directory, { force: true, recursive: true });
  }
});

test("refuses to serialize a receipt containing supplied or opaque credential material", async () => {
  const {
    collectStagingCertification,
    parseStagingCertificationArguments,
    writeStagingCertificationReceipt,
  } = await subject();
  const receipt = await collectStagingCertification(
    parseStagingCertificationArguments(options()),
    environment,
    {
      fetch: queuedFetch(successfulHandlers()),
      now: () => fixedNow,
    }
  );
  const directory = mkdtempSync(
    join(process.cwd(), ".staging-certification-secret-test-")
  );

  try {
    const supplied = structuredClone(receipt);
    supplied.candidate.build.value = environment.OPERATOR_DIAGNOSTIC_TOKEN;
    await assert.rejects(
      writeStagingCertificationReceipt(
        supplied,
        join(directory, "supplied.json"),
        environment
      ),
      /credential material/iu
    );

    const opaque = structuredClone(receipt);
    opaque.candidate.build.value = "q7V9m2K4p8R1t6W3x5Y0z9A2b4C6d8E0";
    await assert.rejects(
      writeStagingCertificationReceipt(
        opaque,
        join(directory, "opaque.json"),
        environment
      ),
      /credential material/iu
    );
  } finally {
    rmSync(directory, { force: true, recursive: true });
  }
});
