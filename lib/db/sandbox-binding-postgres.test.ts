import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import {
  cpSync,
  mkdtempSync,
  readFileSync,
  rmSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import { fileURLToPath } from "node:url";
import { DaytonaNotFoundError } from "@daytona/sdk";
import { drizzle } from "drizzle-orm/postgres-js";
import { migrate } from "drizzle-orm/postgres-js/migrator";
import postgres from "postgres";
import {
  admissionLimitsFromEnvironment,
  admitRunnerRun,
  dispatchRunnerClaim,
} from "@/lib/runner/admission";
import { configuredDaytonaRunnerExecutor } from "@/lib/runner/daytona/executor";
import type {
  DaytonaSandboxConfiguration,
  DaytonaSandboxService,
} from "@/lib/runner/daytona/sandbox";
import { hashRunRequest } from "@/lib/runner/evidence";
import {
  createRunnerStore,
  drizzleRunnerStoreDatabase,
} from "@/lib/runner/store";
import { withDisposableDatabase } from "../../scripts/disposable-postgres";

const url = process.env.SANDBOX_BINDING_POSTGRES_TEST_URL;

test("PostgreSQL binding constraints reject partial pairs and preserve real admission fences", {
  skip: !url,
}, async () => {
  assert.ok(url);
  const client = postgres(url, { max: 1, onnotice: () => undefined });
  const agentId = randomUUID();
  const tenant = "binding_qualification";
  const principal = {
    kind: "subscriber",
    tenant,
    userId: randomUUID(),
  } as const;
  const store = createRunnerStore(
    drizzleRunnerStoreDatabase(
      drizzle(client) as Parameters<typeof drizzleRunnerStoreDatabase>[0]
    )
  );
  const binding = { expectedGeneration: 3, expectedSandboxId: "sandbox-owned" };
  try {
    await client`INSERT INTO "RunnerAgent" (id, tenant, name, instructions, model, runtime, "daytonaSandboxId", "sandboxGeneration", "sandboxLifecycle") VALUES (${agentId}, ${tenant}, 'fixture', 'fixture', 'auto', 'copilot', ${binding.expectedSandboxId}, 3, 'ready')`;
    const insert = (id: string | null, generation: number | null) =>
      client`INSERT INTO "RunnerRun" ("agentId", tenant, "agentInstructions", "agentModel", "agentRuntime", "operationId", "requestHash", task, "boundSandboxId", "boundSandboxGeneration") VALUES (${agentId}, ${tenant}, 'fixture', 'auto', 'copilot', ${randomUUID()}, ${"a".repeat(64)}, 'fixture', ${id}, ${generation})`;
    for (const [id, generation] of [
      [null, 3],
      ["sandbox-owned", null],
      ["sandbox-owned", -1],
      ["../foreign", 3],
    ] as const) {
      // biome-ignore lint/performance/noAwaitInLoops: Each constraint refusal is checked against the real database.
      await assert.rejects(
        insert(id, generation),
        (error: unknown) =>
          error instanceof postgres.PostgresError &&
          error.code === "23514" &&
          error.constraint_name === "RunnerRun_sandboxBinding_valid"
      );
    }
    const start = (expected = binding) => ({
      agentId,
      authVersion: 1,
      id: randomUUID(),
      operationId: randomUUID(),
      requestHash: hashRunRequest(agentId, "fixture", "unrestricted", expected),
      sandboxBinding: expected,
      task: "fixture",
    });
    const mismatched = start({ ...binding, expectedGeneration: 4 });
    const foreign = start();
    assert.deepEqual(await store.startRun(principal, mismatched), {
      kind: "sandbox_binding_refused",
      reason: "generation_mismatch",
    });
    assert.deepEqual(
      await store.startRun({ ...principal, tenant: "foreign_tenant" }, foreign),
      { kind: "not_found" }
    );
    const [runs] =
      await client`SELECT count(*)::int AS n FROM "RunnerRun" WHERE "agentId" = ${agentId}`;
    const [after] =
      await client`SELECT count(*)::int AS n FROM "CredentialLease" WHERE "runId" IN (${mismatched.id}, ${foreign.id})`;
    assert.equal(runs.n, 0);
    assert.equal(after.n, 0);
    const input = start();
    assert.equal((await store.startRun(principal, input)).kind, "created");
    assert.equal((await store.startRun(principal, input)).kind, "duplicate");
    assert.equal(
      (
        await store.startRun(principal, {
          ...input,
          sandboxBinding: { ...binding, expectedGeneration: 4 },
        })
      ).kind,
      "conflict"
    );
    const [stored] =
      await client`SELECT "boundSandboxId", "boundSandboxGeneration" FROM "RunnerRun" WHERE id = ${input.id}`;
    assert.deepEqual(
      { ...stored },
      { boundSandboxGeneration: 3, boundSandboxId: "sandbox-owned" }
    );
    // An unresolved terminal provider reference still fences another bound start.
    await client`UPDATE "RunnerRun" SET status = 'failed', "dispatchState" = 'terminal', "completedAt" = now(), "updatedAt" = now(), "daytonaSessionId" = 'unreleased', "daytonaAttemptId" = ${randomUUID()} WHERE id = ${input.id}`;
    assert.deepEqual(await store.startRun(principal, start()), {
      kind: "sandbox_binding_refused",
      reason: "fence_outstanding",
    });
    await client`DELETE FROM "RunnerRun" WHERE "agentId" = ${agentId}`;
    const limits = {
      ...admissionLimitsFromEnvironment({}),
      tenantQueuedRuns: 0,
    };
    const admitted = await admitRunnerRun(
      { ...start(), principal },
      { limits, store }
    );
    assert.equal(
      admitted.kind,
      "claimed",
      admitted.kind === "refused" ? admitted.error.code : admitted.kind
    );
    assert.ok(admitted.kind === "claimed");
    const calls: string[] = [];
    const operator = { kind: "runner-operator" } as const;
    const configuration: DaytonaSandboxConfiguration = {
      autoArchiveInterval: 10_080,
      autoDeleteInterval: -1,
      autoStopInterval: 15,
      configurationId: "fixture",
      resources: { cpu: 2, disk: 10, memory: 4 },
      snapshotName: "coven-agents-copilot-2",
      target: "us",
      ttlMinutes: 0,
    };
    const provider = {
      get: (id: string) => {
        calls.push(`get:${id}`);
        return Promise.reject(new DaytonaNotFoundError("fixture absent"));
      },
      snapshot: {
        get: (name: string) => {
          calls.push(`snapshot.get:${name}`);
          return Promise.resolve({
            cpu: 2,
            disk: 10,
            mem: 4,
            name,
            state: "active",
          });
        },
      },
    } as unknown as DaytonaSandboxService;
    const executor = configuredDaytonaRunnerExecutor({
      operator,
      sandboxConfiguration: configuration,
      sandboxDependencies: { daytona: provider },
      store,
    });
    const result = await dispatchRunnerClaim(admitted.claimed, {
      acquireCredential: () => {
        assert.fail("credential acquisition must not occur");
      },
      credentialInput: () => {
        assert.fail("credential input must not be built");
      },
      executor,
      limits,
      operator,
      store,
    });
    assert.deepEqual(result, {
      kind: "refused",
      reason: "sandbox_binding",
      runId: admitted.claimed.run.id,
    });
    assert.deepEqual(calls, ["get:sandbox-owned"]);
    const [leasesAfterDispatch] =
      await client`SELECT count(*)::int AS n FROM "CredentialLease" WHERE "runId" = ${admitted.claimed.run.id}`;
    assert.equal(leasesAfterDispatch.n, 0);
    const [terminal] =
      await client`SELECT status, "dispatchState", error, "daytonaAttemptId", "daytonaSessionId" FROM "RunnerRun" WHERE id = ${admitted.claimed.run.id}`;
    assert.equal(terminal.status, "failed");
    assert.equal(terminal.dispatchState, "terminal");
    assert.equal(terminal.error.code, "sandbox_binding_refused");
    assert.equal(terminal.daytonaAttemptId, null);
    assert.equal(terminal.daytonaSessionId, null);
  } finally {
    await client`DELETE FROM "RunnerAgent" WHERE id = ${agentId}`;
    await client.end();
  }
});

test("an existing original-0044 database receives the additive binding constraint repair", {
  skip: !url,
}, async () => {
  assert.ok(url);
  const folder = mkdtempSync(join(tmpdir(), "coven-binding-upgrade-"));
  const source = fileURLToPath(new URL("./migrations/", import.meta.url));
  cpSync(source, folder, { recursive: true });
  const journalPath = join(folder, "meta", "_journal.json");
  const journal = JSON.parse(readFileSync(journalPath, "utf8")) as {
    entries: { idx: number; when: number }[];
  };
  journal.entries = journal.entries.filter((entry) => entry.idx <= 44);
  writeFileSync(journalPath, JSON.stringify(journal));
  try {
    await withDisposableDatabase(
      { E2E_POSTGRES_DISPOSABLE: "1", E2E_POSTGRES_URL: url, NODE_ENV: "test" },
      async (childUrl) => {
        const client = postgres(childUrl, {
          max: 1,
          onnotice: () => undefined,
        });
        const database = drizzle(client);
        const agentId = randomUUID();
        try {
          await migrate(database, { migrationsFolder: folder });
          await client`INSERT INTO "RunnerAgent" (id, tenant, name, instructions, model, runtime) VALUES (${agentId}, 'binding_upgrade', 'fixture', 'fixture', 'auto', 'copilot')`;
          const partial = () =>
            client`INSERT INTO "RunnerRun" ("agentId", tenant, "agentInstructions", "agentModel", "agentRuntime", "operationId", "requestHash", task, "boundSandboxId", "boundSandboxGeneration") VALUES (${agentId}, 'binding_upgrade', 'fixture', 'auto', 'copilot', ${randomUUID()}, ${"a".repeat(64)}, 'fixture', 'sandbox-owned', NULL)`;
          // The original source migration admits UNKNOWN; prove the upgrade starts with that actual schema.
          await partial();
          // A repair refuses malformed pre-existing rows rather than silently rewriting their authority.
          await assert.rejects(
            migrate(database, { migrationsFolder: source }),
            (error: unknown) => {
              const cause =
                error instanceof Error && "cause" in error
                  ? error.cause
                  : error;
              return (
                cause instanceof postgres.PostgresError &&
                cause.code === "23514" &&
                cause.constraint_name === "RunnerRun_sandboxBinding_valid"
              );
            }
          );
          await client`DELETE FROM "RunnerRun" WHERE "agentId" = ${agentId}`;
          await migrate(database, { migrationsFolder: source });
          await assert.rejects(partial(), {
            code: "23514",
            constraint_name: "RunnerRun_sandboxBinding_valid",
          });
          const [record] =
            await client`SELECT max(created_at)::text AS latest FROM drizzle.__drizzle_migrations`;
          const completeJournal = JSON.parse(
            readFileSync(join(source, "meta", "_journal.json"), "utf8")
          ) as { entries: { when: number }[] };
          assert.equal(
            record.latest,
            String(completeJournal.entries.at(-1)?.when)
          );
          await migrate(database, { migrationsFolder: source });
          await assert.rejects(partial(), {
            code: "23514",
            constraint_name: "RunnerRun_sandboxBinding_valid",
          });
        } finally {
          await client.end();
        }
      }
    );
  } finally {
    rmSync(folder, { force: true, recursive: true });
  }
});

test("guarded bind pins future starts and exposes execution evidence only after start", {
  skip: !url,
}, async () => {
  assert.ok(url);
  const client = postgres(url, { max: 1, onnotice: () => undefined });
  const store = createRunnerStore(
    drizzleRunnerStoreDatabase(
      drizzle(client) as Parameters<typeof drizzleRunnerStoreDatabase>[0]
    )
  );
  const agentId = randomUUID();
  const principal = {
    kind: "subscriber",
    tenant: "bind_owner",
    userId: randomUUID(),
  } as const;
  const binding = { expectedGeneration: 0, expectedSandboxId: randomUUID() };
  const denied = () => assert.fail("unexpected provider read");
  try {
    await client`insert into "RunnerAgent" (id,tenant,name,instructions,model,runtime) values (${agentId},${principal.tenant},'fixture','fixture','auto','copilot')`;
    assert.equal(
      await store.bindExistingSandbox(
        { ...principal, tenant: "foreign" },
        agentId,
        binding,
        denied
      ),
      "not_found"
    );
    assert.equal(
      await store.bindExistingSandbox(
        principal,
        agentId,
        { ...binding, expectedGeneration: 1 },
        denied
      ),
      "generation_mismatch"
    );
    let reads = 0;
    assert.equal(
      await store.bindExistingSandbox(principal, agentId, binding, (agent) => {
        assert.equal(agent.id, agentId);
        reads += 1;
        return Promise.resolve();
      }),
      "bound"
    );
    assert.equal(reads, 1);
    const pinned = await store.getAgent(principal, agentId);
    assert.ok(pinned);
    assert.equal(pinned.pinnedSandboxId, binding.expectedSandboxId);
    const fence = {
      agentId,
      expectedGeneration: pinned.sandboxGeneration,
      expectedVersion: pinned.version,
    };
    const operator = { kind: "runner-operator" } as const;
    assert.equal(
      await store.withUnpinnedDaytonaSandboxReuse(principal, pinned, denied),
      false
    );
    assert.deepEqual(await store.beginDaytonaSandboxWarm(principal, fence), {
      kind: "stale_version",
    });
    assert.deepEqual(
      await store.reserveDaytonaSandbox(principal, {
        ...fence,
        expectedSandboxId: pinned.daytonaSandboxId,
        provisioningStaleBefore: new Date(),
      }),
      { kind: "stale_version" }
    );
    assert.deepEqual(
      await store.beginDaytonaSandboxResize(operator, {
        ...fence,
        sandboxId: binding.expectedSandboxId,
        tenant: principal.tenant,
      }),
      { kind: "stale_version" }
    );
    assert.ok(
      !(await store.scanDaytonaSandboxRepairCandidates(operator, 100)).some(
        (candidate) => candidate.mapping.id === agentId
      )
    );
    const id = randomUUID();
    const result = await store.startRun(principal, {
      agentId,
      authVersion: 1,
      id,
      operationId: randomUUID(),
      requestHash: hashRunRequest(agentId, "fixture"),
      task: "fixture",
    });
    assert.equal(result.kind, "created");
    const [row] =
      await client`select "boundSandboxId","boundSandboxGeneration" from "RunnerRun" where id=${id}`;
    assert.equal(row.boundSandboxId, binding.expectedSandboxId);
    assert.equal(row.boundSandboxGeneration, 0);
    assert.equal(
      (await store.getRun(principal, id))?.executedSandbox,
      undefined
    );
    assert.equal(
      await store.bindExistingSandbox(principal, agentId, binding, denied),
      "fence_outstanding"
    );
    const claimed = await store.claimNextDispatch(operator, {
      leaseExpiresAt: new Date(Date.now() + 60_000),
      leaseToken: randomUUID(),
    });
    assert.ok(claimed);
    assert.equal(claimed.run.id, id);
    assert.equal(
      (await store.markDispatchRunningForDispatch(operator, claimed.authority))
        .kind,
      "updated"
    );
    const snapshot = await store.getRun(principal, id);
    assert.equal(snapshot?.executedSandbox?.generation, 0);
    assert.match(
      snapshot?.executedSandbox?.bindingDigest ?? "",
      /^[0-9a-f]{64}$/u
    );
    assert.equal(
      JSON.stringify(snapshot).includes(binding.expectedSandboxId),
      false
    );
    const [leases] =
      await client`select count(*)::int as count from "CredentialLease" where "runId"=${id}`;
    assert.equal(leases.count, 0);
  } finally {
    await client`delete from "RunnerRun" where "agentId"=${agentId}`;
    await client`delete from "RunnerAgent" where id=${agentId}`;
    await client.end();
  }
});
