import "server-only";

import { createHash, createHmac } from "node:crypto";
import {
  type GitHubOperationKind,
  type GitHubToolOperation,
  githubToolOperationSchema as operationSchema,
  type TeamCapability,
} from "@opencoven/agent-contracts";

export {
  GITHUB_TOOL_LIMITS,
  githubToolOperationSchema,
  githubToolRequestSchema,
  githubToolResultSchema,
} from "@opencoven/agent-contracts";

export type GitHubOperationAuthority = Readonly<{
  capability: TeamCapability;
  classification: "read" | "write";
}>;

const OPERATION_AUTHORITY = {
  "issue.comment": {
    capability: "github.issues.write",
    classification: "write",
  },
  "issue.create": {
    capability: "github.issues.write",
    classification: "write",
  },
  "issue.get": {
    capability: "github.issues.read",
    classification: "read",
  },
  "issue.search": {
    capability: "github.issues.read",
    classification: "read",
  },
  "project.item.add": {
    capability: "github.projects.write",
    classification: "write",
  },
  "project.item.field.update": {
    capability: "github.projects.write",
    classification: "write",
  },
  "pull.comment": {
    capability: "github.pull_requests.write",
    classification: "write",
  },
  "pull.create": {
    capability: "github.pull_requests.write",
    classification: "write",
  },
  "pull.get": {
    capability: "github.pull_requests.read",
    classification: "read",
  },
  "pull.review": {
    capability: "github.pull_requests.write",
    classification: "write",
  },
} as const satisfies Record<GitHubOperationKind, GitHubOperationAuthority>;

export function githubOperationAuthority(
  kind: GitHubOperationKind
): GitHubOperationAuthority {
  return OPERATION_AUTHORITY[kind];
}

export function githubOperationRepository(
  operation: Pick<GitHubToolOperation, "owner" | "repo">
): string {
  return `${operation.owner.toLowerCase()}/${operation.repo.toLowerCase()}`;
}

function canonicalValue(value: unknown): unknown {
  if (Array.isArray(value)) {
    return value.map(canonicalValue);
  }
  if (value && typeof value === "object") {
    return Object.fromEntries(
      Object.entries(value)
        .sort(([left], [right]) => left.localeCompare(right))
        .map(([key, entry]) => [key, canonicalValue(entry)])
    );
  }
  return value;
}

export function canonicalGitHubOperation(
  value: GitHubToolOperation
): GitHubToolOperation {
  const operation = operationSchema.parse(value);
  return {
    ...operation,
    owner: operation.owner.toLowerCase(),
    repo: operation.repo.toLowerCase(),
  } as GitHubToolOperation;
}

export function hashGitHubOperation(value: GitHubToolOperation): string {
  const canonical = canonicalValue(canonicalGitHubOperation(value));
  return createHash("sha256")
    .update(JSON.stringify(canonical), "utf8")
    .digest("hex");
}

export function githubOperationMarker(
  input: Readonly<{
    capabilityBinding: string;
    operationId: string;
    requestHash: string;
    teamStepId: string;
  }>
): string {
  if (!/^[a-f0-9]{64}$/u.test(input.capabilityBinding)) {
    throw new TypeError("GitHub marker capability binding is invalid.");
  }
  const digest = createHmac(
    "sha256",
    Buffer.from(input.capabilityBinding, "hex")
  )
    .update(`coven-github:v1:${input.operationId}:${input.requestHash}`, "utf8")
    .digest("hex")
    .slice(0, 40);
  return `<!-- coven-github:v1:${digest} -->`;
}

export function githubOperationTarget(operation: GitHubToolOperation): string {
  const repository = githubOperationRepository(operation);
  const digest = (value: string) =>
    `sha256:${createHash("sha256").update(value, "utf8").digest("hex").slice(0, 40)}`;
  let resource: string;
  switch (operation.kind) {
    case "issue.get":
      resource = operation.issueNumber;
      break;
    case "issue.search":
      resource = digest(
        `${operation.state}\0${operation.limit}\0${operation.query}`
      );
      break;
    case "issue.create":
      resource = digest(hashGitHubOperation(operation));
      break;
    case "issue.comment":
      resource = operation.issueNumber;
      break;
    case "pull.get":
      resource = operation.pullNumber;
      break;
    case "pull.create":
      resource = digest(`${operation.head}\0${operation.base}`);
      break;
    case "pull.comment":
      resource = operation.pullNumber;
      break;
    case "pull.review":
      resource = operation.pullNumber;
      break;
    case "project.item.add":
      resource = digest(`${operation.projectId}\0${operation.contentId}`);
      break;
    case "project.item.field.update":
      resource = digest(
        `${operation.projectId}\0${operation.itemId}\0${operation.fieldId}`
      );
      break;
    default:
      throw new TypeError("Unsupported GitHub operation target.");
  }
  const target = `${repository}#${operation.kind}:${resource}`;
  if (Buffer.byteLength(target, "utf8") > 512) {
    throw new TypeError("GitHub operation target exceeds its audit bound.");
  }
  return target;
}
