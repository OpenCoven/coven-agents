export declare const contractDescriptor: {
  readonly apiVersions: readonly ["1.0"];
  readonly capabilities: readonly [
    "agent-profiles",
    "async-runs",
    "idempotent-runs",
    "run-events",
    "run-cancel",
    "command-evidence",
    "file-evidence",
  ];
  readonly eventTypes: readonly [
    "accepted",
    "status",
    "output",
    "command",
    "file",
    "completed",
    "failed",
  ];
  readonly limits: {
    readonly maxCommandLength: number;
    readonly maxDescriptionLength: number;
    readonly maxDetailsLength: number;
    readonly maxEventOutputLength: number;
    readonly maxInstructionsLength: number;
    readonly maxMessageLength: number;
    readonly maxModelLength: number;
    readonly maxOwnerIdLength: number;
    readonly maxPathLength: number;
    readonly maxRequestIdLength: number;
    readonly maxSourceRevisionLength: number;
    readonly maxTaskLength: number;
    readonly maxWorkspaceLength: number;
  };
  readonly routes: readonly {
    readonly method: string;
    readonly path: string;
  }[];
  readonly statuses: readonly [
    "queued",
    "running",
    "completed",
    "failed",
    "cancelled",
  ];
};
