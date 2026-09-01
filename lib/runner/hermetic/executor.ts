import "server-only";

import { createHash } from "node:crypto";
import { daytonaRunSessionName } from "../daytona/names";
import type { RunnerExecutionProvenance } from "../execution-provenance";
import type {
  RestrictedWorkspaceInspection,
  RunnerExecutionContext,
  RunnerExecutor,
  RunnerExecutorStartInput,
} from "../executor";
import { requireHarness } from "../harness";
import type { RunnerStore } from "../store";
import type {
  RunnerAgentRecord,
  RunnerDispatchAuthority,
  RunnerExecutionAttemptId,
  RunnerOperator,
} from "../types";

declare const hermeticExecutionContextBrand: unique symbol;

type HermeticExecutionContext = Readonly<{
  attemptId: RunnerExecutionAttemptId;
  runId: string;
  readonly [hermeticExecutionContextBrand]: "HermeticExecutionContext";
}>;

type HermeticDispatchStore = Pick<
  RunnerStore,
  | "attachDaytonaSandboxForDispatch"
  | "getDispatchAgent"
  | "reserveDaytonaSandboxForDispatch"
>;

export const HERMETIC_EXECUTOR_ADAPTER_VERSION = "hermetic-adapter-v1";
export const HERMETIC_HOLD_TASK_MARKER = "[[hermetic:hold]]";

export const HERMETIC_EXECUTION_PROVENANCE: RunnerExecutionProvenance =
  Object.freeze({
    adapterVersion: HERMETIC_EXECUTOR_ADAPTER_VERSION,
    capabilityContractVersion: "hosted-v1",
    lifecycle: "ephemeral",
    pinnedSnapshot: "hermetic-e2e-v1",
    productExecutionClass: "hosted",
    provider: "hermetic",
    target: "e2e",
  });

function digest(value: string): string {
  return createHash("sha256").update(value, "utf8").digest("hex").slice(0, 40);
}

export function hermeticSandboxId(tenant: string, agentId: string): string {
  return `hermetic-${digest(`${tenant}\0${agentId}`)}`;
}

export function hermeticCommandId(
  runId: string,
  attemptId: RunnerExecutionAttemptId
): string {
  return `hermetic-command-${digest(`${runId}\0${attemptId}`)}`;
}

export function hermeticAttemptId(runId: string): RunnerExecutionAttemptId {
  const raw = digest(`attempt\0${runId}`);
  return `${raw.slice(0, 8)}-${raw.slice(8, 12)}-4${raw.slice(
    13,
    16
  )}-8${raw.slice(17, 20)}-${raw.slice(20, 32)}` as RunnerExecutionAttemptId;
}

function executionContext(
  runId: string,
  attemptId: RunnerExecutionAttemptId
): RunnerExecutionContext {
  return { attemptId, runId } as unknown as RunnerExecutionContext;
}

function currentContext(
  context: RunnerExecutionContext
): HermeticExecutionContext {
  return context as unknown as HermeticExecutionContext;
}

function unavailable(message: string): Error {
  return new Error(`Hermetic runner ${message}.`);
}

async function ensureHermeticContext(
  operator: RunnerOperator,
  authority: RunnerDispatchAuthority,
  store: HermeticDispatchStore
): Promise<RunnerAgentRecord> {
  const associated = await store.getDispatchAgent(operator, authority);
  if (associated.kind !== "found") {
    throw unavailable("dispatch is no longer live");
  }
  const expectedSandboxId = hermeticSandboxId(
    associated.agent.tenant,
    associated.agent.id
  );
  if (
    associated.agent.sandboxLifecycle === "ready" &&
    associated.agent.daytonaSandboxId === expectedSandboxId
  ) {
    return associated.agent;
  }

  const reserved = await store.reserveDaytonaSandboxForDispatch(
    operator,
    authority,
    { provisioningStaleBefore: new Date() }
  );
  if (reserved.kind !== "reserved") {
    throw unavailable("sandbox preparation was fenced");
  }
  const attached = await store.attachDaytonaSandboxForDispatch(
    operator,
    authority,
    {
      expectedGeneration: reserved.value.sandboxGeneration,
      expectedVersion: reserved.value.version,
      sandboxId: expectedSandboxId,
    }
  );
  if (attached.kind !== "updated") {
    throw unavailable("sandbox attachment was fenced");
  }
  return attached.value;
}

/**
 * Deterministic E2E-only executor. It obtains no provider client, performs no
 * network operation, and never serializes the credential passed to start.
 */
export function hermeticRunnerExecutor(input: {
  operator: RunnerOperator;
  store: HermeticDispatchStore;
}): RunnerExecutor {
  return {
    attemptIdForRun: hermeticAttemptId,
    ensureExecutionContext: async (authority) => {
      if (!authority.attemptId) {
        throw unavailable("attempt preparation is missing");
      }
      const agent = await ensureHermeticContext(
        input.operator,
        authority,
        input.store
      );
      return {
        agent,
        context: executionContext(authority.runId, authority.attemptId),
      };
    },
    executionProvenance: HERMETIC_EXECUTION_PROVENANCE,
    inspectWorkspaceSafety: async (
      _context,
      _workspace
    ): Promise<RestrictedWorkspaceInspection> => ({ kind: "safe" }),
    isCleanupPending: () => false,
    start: async (start: RunnerExecutorStartInput) => {
      const attemptId = await start.authorizers.authorizePreparation({
        runId: start.runId,
      });
      if (!attemptId) {
        throw unavailable("attempt preparation was rejected");
      }
      const context = currentContext(start.context);
      if (context.runId !== start.runId || context.attemptId !== attemptId) {
        throw unavailable("attempt context was fenced");
      }
      requireHarness(start.runtime, start.credential);
      if (
        start.executionPermission === "unrestricted" &&
        !(await start.authorizers.authorizeUnrestrictedExecution({
          attemptId,
          runId: start.runId,
        }))
      ) {
        throw unavailable("unrestricted execution was rejected");
      }
      const authorized = await start.authorizers.authorizeLaunch({
        attemptId,
        commandId: hermeticCommandId(start.runId, attemptId),
        runId: start.runId,
        sessionId: daytonaRunSessionName(start.runId, attemptId),
      });
      if (!authorized) {
        throw unavailable("launch was rejected");
      }
      return { dispatchAuthority: authorized };
    },
  };
}
