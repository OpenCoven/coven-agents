import "server-only";

import type { RunnerExecutionProvenance } from "./execution-provenance";
import type { HarnessCredential } from "./harness";
import type { RunnerStore } from "./store";
import type {
  RunnerAgentRecord,
  RunnerDispatchAuthority,
  RunnerExecutionAttemptId,
  RunnerExecutionPermission,
  RunnerOperator,
} from "./types";

declare const runnerExecutionContextBrand: unique symbol;

/**
 * Opaque provider-owned execution context. Admission may pass it between
 * executor operations but never examines its provider-specific internals.
 */
export type RunnerExecutionContext = Readonly<{
  readonly [runnerExecutionContextBrand]: "RunnerExecutionContext";
}>;

export type RestrictedWorkspaceInspection =
  | Readonly<{ kind: "safe" }>
  | Readonly<{ kind: "unsafe" }>
  | Readonly<{ kind: "unavailable" }>;

export type RunnerPreparationAuthorization = Readonly<{
  runId: string;
}>;

export type RunnerLaunchAuthorization = Readonly<{
  attemptId: RunnerExecutionAttemptId;
  commandId?: string;
  runId: string;
  sessionId: string;
}>;

export type RunnerExecutionAuthorizers = Readonly<{
  authorizeLaunch: (
    launch: RunnerLaunchAuthorization
  ) => Promise<RunnerDispatchAuthority | null>;
  authorizePreparation: (
    preparation: RunnerPreparationAuthorization
  ) => Promise<RunnerExecutionAttemptId | null>;
  authorizeUnrestrictedExecution: (
    execution: Readonly<{
      attemptId: RunnerExecutionAttemptId;
      runId: string;
    }>
  ) => Promise<boolean>;
  currentAuthority: () => RunnerDispatchAuthority;
  releasePreparation: (
    release: Readonly<{
      attemptId: RunnerExecutionAttemptId;
      runId: string;
    }>
  ) => Promise<RunnerDispatchAuthority | null>;
}>;

export type RunnerExecutorStartInput = Readonly<{
  authorizers: RunnerExecutionAuthorizers;
  context: RunnerExecutionContext;
  credential: HarnessCredential;
  deleteAttemptRedaction: (
    input: Readonly<{
      attemptId: RunnerExecutionAttemptId;
      runId: string;
    }>
  ) => Promise<boolean>;
  executionPermission: RunnerExecutionPermission;
  instructions: string;
  model: string;
  persistAttemptRedaction: (
    input: Readonly<{
      attemptId: RunnerExecutionAttemptId;
      credential: string;
      runId: string;
    }>
  ) => Promise<boolean>;
  runId: string;
  runtime: string;
  task: string;
  workspace?: string;
}>;

export type RunnerStartedExecution = Readonly<{
  dispatchAuthority: RunnerDispatchAuthority;
}>;

export type RunnerExecutor = Readonly<{
  executionProvenance: RunnerExecutionProvenance;
  ensureExecutionContext: (authority: RunnerDispatchAuthority) => Promise<
    Readonly<{
      agent: RunnerAgentRecord;
      context: RunnerExecutionContext;
    }>
  >;
  inspectWorkspaceSafety: (
    context: RunnerExecutionContext,
    workspace: string
  ) => Promise<RestrictedWorkspaceInspection>;
  isCleanupPending: (error: unknown) => boolean;
  start: (input: RunnerExecutorStartInput) => Promise<RunnerStartedExecution>;
}>;

type DispatchAuthorizerStore = Pick<
  RunnerStore,
  | "authorizeDaytonaLaunch"
  | "authorizeDaytonaPreparation"
  | "authorizeUnrestrictedExecution"
  | "releaseDaytonaPreparation"
>;

/** Creates the run-fenced authority callbacks required by every executor. */
export function runnerDispatchAuthorizers(
  store: DispatchAuthorizerStore,
  operator: RunnerOperator,
  authority: RunnerDispatchAuthority,
  executionProvenance: RunnerExecutionProvenance
): RunnerExecutionAuthorizers {
  let prepared: RunnerDispatchAuthority | undefined;
  let latest = authority;

  return {
    authorizeLaunch: (launch) => {
      if (
        launch.runId !== authority.runId ||
        !prepared ||
        launch.attemptId !== prepared.attemptId
      ) {
        return Promise.resolve(null);
      }
      return store
        .authorizeDaytonaLaunch(operator, prepared, {
          attemptId: launch.attemptId,
          commandId: launch.commandId,
          sessionId: launch.sessionId,
        })
        .then((result) => {
          if (result.kind !== "authorized") {
            return null;
          }
          prepared = result.authority;
          latest = result.authority;
          return result.authority;
        });
    },
    authorizePreparation: async (preparation) => {
      if (preparation.runId !== authority.runId) {
        return null;
      }
      const result = await store.authorizeDaytonaPreparation(
        operator,
        authority,
        { executionProvenance }
      );
      if (result.kind !== "authorized") {
        return null;
      }
      prepared = result.authority;
      latest = result.authority;
      return result.attemptId;
    },
    authorizeUnrestrictedExecution: async (execution) => {
      if (
        execution.runId !== authority.runId ||
        !prepared ||
        execution.attemptId !== prepared.attemptId
      ) {
        return false;
      }
      return (
        (await store.authorizeUnrestrictedExecution(operator, prepared))
          .kind === "authorized"
      );
    },
    currentAuthority: () => latest,
    releasePreparation: async (release) => {
      if (
        release.runId !== authority.runId ||
        !prepared ||
        release.attemptId !== prepared.attemptId
      ) {
        return null;
      }
      const result = await store.releaseDaytonaPreparation(operator, prepared, {
        attemptId: release.attemptId,
      });
      if (result.kind !== "released") {
        return null;
      }
      prepared = undefined;
      latest = result.authority;
      return result.authority;
    },
  };
}
