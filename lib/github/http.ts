// biome-ignore-all lint/performance/noAwaitInLoops lint/style/useDestructuring lint/style/useErrorCause lint/suspicious/noShadow lint/suspicious/useAwait: Bounded stream reads and sanitized provider failures intentionally preserve sequential control flow.
import "server-only";

import { createHash, randomUUID } from "node:crypto";
import {
  GITHUB_TOOL_LIMITS,
  GITHUB_TOOL_SERVER_DEADLINE_MS,
  type GitHubOperationReceipt,
  type GitHubToolOperation,
  type GitHubToolResult,
  githubOperationReceiptSchema,
  githubToolOperationSchema,
  githubToolRequestSchema,
  githubToolResultSchema,
} from "@opencoven/agent-contracts";
import type {
  AbuseAdmission,
  AbuseEnforcementInput,
} from "@/lib/abuse/enforce";
import type { RunnerOperator } from "@/lib/runner/types";
import type { GitHubAppClient, GitHubPermissionLevel } from "./app-auth";
import {
  type createGitHubGatewayStore,
  GITHUB_GATEWAY_DATABASE_PHASE_TIMEOUT_MS,
  type GitHubGatewayOperationRecord,
  type GitHubOperationExecutionContext,
  isGitHubDatabaseStatementTimeout,
} from "./capability";
import {
  githubOperationAuthority,
  githubOperationMarker,
  githubOperationRepository,
  githubOperationTarget,
  hashGitHubOperation,
} from "./operations";

const GITHUB_API_ORIGIN = "https://api.github.com";
const GITHUB_API_VERSION = "2022-11-28";
const REQUEST_ID = /^[A-Za-z0-9:-]{1,128}$/u;
const NODE_ID = /^[A-Za-z0-9_=-]{1,256}$/u;
const GIT_SHA = /^[a-f0-9]{40}$/u;
const DEFAULT_TIMEOUT_MS = 5000;
const DEFAULT_MAX_RESPONSE_BYTES = 256 * 1024;
const DEFAULT_AUTHORITY_REFRESH_TIMEOUT_MS = 15_000;
const MAX_TOOL_REQUEST_BYTES = 512 * 1024;
const DEFAULT_PRE_DATABASE_DEADLINE_MS = 5000;
const MAX_BODY_CANCELLATION_WAIT_MS = 25;
const MAX_PROJECT_ITEM_PAGES = 500;
const RAW_CAPABILITY = /^[A-Za-z0-9_-]{43}$/u;

type FetchLike = (input: string, init?: RequestInit) => Promise<Response>;

export type GitHubProviderOperationResult = Readonly<{
  providerRequestId: string | null;
  result: GitHubToolResult;
  resultNodeId: string | null;
  resultUrl: string | null;
}>;

export type GitHubOperationProvider = Readonly<{
  execute: (
    input: Readonly<{
      authorizeMutation: () => Promise<boolean>;
      context: GitHubOperationExecutionContext;
      deadlineAt?: number;
      mode: "execute" | "recover";
      operation: GitHubToolOperation;
    }>
  ) => Promise<GitHubProviderOperationResult>;
}>;

export class GitHubToolProviderError extends Error {
  readonly code: string;
  readonly mutationMayHaveReached: boolean;
  readonly providerRequestId: string | null;
  readonly retryable: boolean;
  readonly status: number;
  readonly uncertain: boolean;

  constructor(
    code: string,
    input: Readonly<{
      providerRequestId?: string | null;
      mutationMayHaveReached?: boolean;
      retryable: boolean;
      status: number;
      uncertain?: boolean;
    }>
  ) {
    super("GitHub tool provider request failed.");
    this.name = "GitHubToolProviderError";
    this.code = code;
    this.mutationMayHaveReached = input.mutationMayHaveReached ?? false;
    this.providerRequestId = input.providerRequestId ?? null;
    this.retryable = input.retryable;
    this.status = input.status;
    this.uncertain = input.uncertain ?? false;
  }
}

function object(value: unknown): Record<string, unknown> {
  if (!value || typeof value !== "object" || Array.isArray(value)) {
    throw invalidResponse();
  }
  return value as Record<string, unknown>;
}

function string(value: unknown, maximum: number, pattern?: RegExp): string {
  if (
    typeof value !== "string" ||
    value.length > maximum ||
    (pattern && !pattern.test(value))
  ) {
    throw invalidResponse();
  }
  return value;
}

function decimal(value: unknown): string {
  if (
    (typeof value !== "number" || !Number.isSafeInteger(value) || value < 1) &&
    (typeof value !== "string" || !/^[1-9][0-9]{0,19}$/u.test(value))
  ) {
    throw invalidResponse();
  }
  return String(value);
}

function invalidResponse(): GitHubToolProviderError {
  return new GitHubToolProviderError("github_provider_invalid_response", {
    retryable: false,
    status: 502,
  });
}

function boundedText(value: unknown, maxBytes: number): string {
  if (value === null || value === undefined) {
    return "";
  }

  if (typeof value !== "string") {
    throw invalidResponse();
  }
  const encoded = new TextEncoder().encode(value);
  if (encoded.byteLength <= maxBytes) {
    return value;
  }
  const decoder = new TextDecoder("utf-8", { fatal: true });
  for (let end = maxBytes; end >= 0; end -= 1) {
    try {
      return decoder.decode(encoded.slice(0, end));
    } catch {
      // Continue to the preceding complete UTF-8 boundary.
    }
  }
  return "";
}

function publicBody(value: unknown): string {
  if (value === null || value === undefined) {
    return "";
  }
  if (typeof value !== "string") {
    throw invalidResponse();
  }
  return boundedText(
    value
      .replace(/\s*<!-- coven-github:v1:[a-f0-9]{40} -->\s*/gu, "")
      .trimEnd(),
    GITHUB_TOOL_LIMITS.resultBodyBytes
  );
}

function gitSha(value: unknown): string {
  return string(value, 40, GIT_SHA);
}

function gitRefSha(value: unknown, expectedRef: string): string {
  const body = object(value);
  const target = object(body.object);
  if (body.ref !== expectedRef || target.type !== "commit") {
    throw invalidResponse();
  }
  return gitSha(target.sha);
}

function gitCommitTreeSha(value: unknown, expectedSha: string): string {
  const body = object(value);
  if (gitSha(body.sha) !== expectedSha) {
    throw invalidResponse();
  }
  return gitSha(object(body.tree).sha);
}

type GitBlobMode = "100644" | "100755";

type GitTreeEntry = Readonly<{
  mode: "040000" | "100644" | "100755" | "120000" | "160000";
  path: string;
  sha: string;
  type: "blob" | "commit" | "tree";
}>;

function gitTreeEntries(
  value: unknown,
  expectedSha: string
): readonly GitTreeEntry[] {
  const body = object(value);
  if (gitSha(body.sha) !== expectedSha || body.truncated === true) {
    throw invalidResponse();
  }
  if (body.truncated !== undefined && typeof body.truncated !== "boolean") {
    throw invalidResponse();
  }
  const entries = array(body.tree, 4096);
  const paths = new Set<string>();
  return entries.map((value) => {
    const entry = object(value);
    const mode = string(entry.mode, 6);
    const path = string(entry.path, 1024);
    const type = string(entry.type, 6);
    if (
      !["040000", "100644", "100755", "120000", "160000"].includes(mode) ||
      !["blob", "commit", "tree"].includes(type) ||
      (type === "tree" && mode !== "040000") ||
      (type === "commit" && mode !== "160000") ||
      (type === "blob" && !["100644", "100755", "120000"].includes(mode)) ||
      paths.has(path)
    ) {
      throw invalidResponse();
    }
    paths.add(path);
    return {
      mode: mode as GitTreeEntry["mode"],
      path,
      sha: gitSha(entry.sha),
      type: type as GitTreeEntry["type"],
    };
  });
}

async function readBoundedText(
  response: Response,
  maxBytes: number
): Promise<string> {
  const contentLength = response.headers.get("content-length");
  if (
    contentLength &&
    /^[0-9]+$/u.test(contentLength) &&
    Number(contentLength) > maxBytes
  ) {
    throw new GitHubToolProviderError("github_provider_response_too_large", {
      retryable: false,
      status: 502,
    });
  }
  if (!response.body) {
    return "";
  }
  const reader = response.body.getReader();
  const chunks: Uint8Array[] = [];
  let total = 0;
  try {
    while (true) {
      const { done, value } = await reader.read();
      if (done) {
        break;
      }
      total += value.byteLength;
      if (total > maxBytes) {
        throw new GitHubToolProviderError(
          "github_provider_response_too_large",
          { retryable: false, status: 502 }
        );
      }
      chunks.push(value);
    }
  } finally {
    reader.releaseLock();
  }
  const joined = new Uint8Array(total);
  let offset = 0;
  for (const chunk of chunks) {
    joined.set(chunk, offset);
    offset += chunk.byteLength;
  }
  return new TextDecoder().decode(joined);
}

function providerRequestId(response: Response): string | null {
  const value = response.headers.get("x-github-request-id");
  return value && REQUEST_ID.test(value) ? value : null;
}

function providerLastPage(response: Response): number | null {
  const link = response.headers.get("link");
  const match = link?.match(
    /<[^>]*[?&]page=([1-9][0-9]{0,8})[^>]*>;\s*rel="last"/u
  );
  if (!match) {
    return null;
  }
  const page = Number(match[1]);
  return Number.isSafeInteger(page) ? page : null;
}

function issueResult(
  context: GitHubOperationExecutionContext,
  value: unknown,
  kind: "issue.create" | "issue.get"
): GitHubProviderOperationResult {
  const body = object(value);
  const nodeId = string(body.node_id, 256, NODE_ID);
  const url = string(body.html_url, 2048);
  const state = body.state;
  if (
    (state !== "open" && state !== "closed") ||
    !url.startsWith(
      `https://github.com/${context.repositoryOwner}/${context.repositoryName}/issues/`
    )
  ) {
    throw invalidResponse();
  }
  const result = githubToolResultSchema.parse({
    issue: {
      body: publicBody(body.body),
      nodeId,
      number: decimal(body.number),
      state,
      title: boundedText(body.title, GITHUB_TOOL_LIMITS.resultTitleBytes),
      url,
    },
    kind,
    repository: `${context.repositoryOwner}/${context.repositoryName}`,
  });
  return {
    providerRequestId: null,
    result,
    resultNodeId: nodeId,
    resultUrl: url,
  };
}

function issueSummary(
  context: GitHubOperationExecutionContext,
  value: unknown
) {
  const body = object(value);
  const url = string(body.html_url, 2048);
  const state = body.state;
  if (
    (state !== "open" && state !== "closed") ||
    !url.startsWith(
      `https://github.com/${context.repositoryOwner}/${context.repositoryName}/issues/`
    )
  ) {
    throw invalidResponse();
  }
  return {
    nodeId: string(body.node_id, 256, NODE_ID),
    number: decimal(body.number),
    state,
    title: boundedText(body.title, GITHUB_TOOL_LIMITS.resultTitleBytes),
    url,
  } as const;
}

function pullResult(
  context: GitHubOperationExecutionContext,
  value: unknown,
  kind: "pull.create" | "pull.get"
): GitHubProviderOperationResult {
  const body = object(value);
  const base = object(body.base);
  const head = object(body.head);
  const nodeId = string(body.node_id, 256, NODE_ID);
  const url = string(body.html_url, 2048);
  const state = body.state;
  if (
    (state !== "open" && state !== "closed") ||
    typeof body.draft !== "boolean" ||
    typeof body.merged !== "boolean" ||
    !url.startsWith(
      `https://github.com/${context.repositoryOwner}/${context.repositoryName}/pull/`
    )
  ) {
    throw invalidResponse();
  }
  const result = githubToolResultSchema.parse({
    kind,
    pull: {
      base: string(base.ref, GITHUB_TOOL_LIMITS.branchBytes),
      body: publicBody(body.body),
      draft: body.draft,
      head: string(head.ref, GITHUB_TOOL_LIMITS.branchBytes),
      merged: body.merged,
      nodeId,
      number: decimal(body.number),
      state,
      title: boundedText(body.title, GITHUB_TOOL_LIMITS.resultTitleBytes),
      url,
    },
    repository: `${context.repositoryOwner}/${context.repositoryName}`,
  });
  return {
    providerRequestId: null,
    result,
    resultNodeId: nodeId,
    resultUrl: url,
  };
}

function commentResult(
  context: GitHubOperationExecutionContext,
  value: unknown,
  kind: "issue.comment" | "pull.comment"
): GitHubProviderOperationResult {
  const body = object(value);
  const nodeId = string(body.node_id, 256, NODE_ID);
  const url = string(body.html_url, 2048);
  if (
    !url.startsWith(
      `https://github.com/${context.repositoryOwner}/${context.repositoryName}/`
    )
  ) {
    throw invalidResponse();
  }
  return {
    providerRequestId: null,
    result: githubToolResultSchema.parse({
      comment: { nodeId, url },
      kind,
      repository: `${context.repositoryOwner}/${context.repositoryName}`,
    }),
    resultNodeId: nodeId,
    resultUrl: url,
  };
}

function reviewResult(
  context: GitHubOperationExecutionContext,
  value: unknown
): GitHubProviderOperationResult {
  const body = object(value);
  const nodeId = string(body.node_id, 256, NODE_ID);
  const url = string(body.html_url, 2048);
  const states = {
    APPROVED: "approved",
    CHANGES_REQUESTED: "changes_requested",
    COMMENTED: "commented",
  } as const;
  const state = states[body.state as keyof typeof states];
  if (
    !state ||
    !url.startsWith(
      `https://github.com/${context.repositoryOwner}/${context.repositoryName}/pull/`
    )
  ) {
    throw invalidResponse();
  }
  return {
    providerRequestId: null,
    result: githubToolResultSchema.parse({
      kind: "pull.review",
      repository: `${context.repositoryOwner}/${context.repositoryName}`,
      review: { nodeId, state, url },
    }),
    resultNodeId: nodeId,
    resultUrl: url,
  };
}

function appendMarker(body: string, marker: string): string {
  return body ? `${body}\n\n${marker}` : marker;
}

function array(value: unknown, maximum = 100): unknown[] {
  if (!Array.isArray(value) || value.length > maximum) {
    throw invalidResponse();
  }
  return value;
}

function graphqlData(value: unknown): Record<string, unknown> {
  const envelope = object(value);
  if ("errors" in envelope) {
    throw new GitHubToolProviderError("github_provider_rejected", {
      retryable: false,
      status: 422,
    });
  }
  return object(envelope.data);
}

const PROJECT_ITEM_ADD_TARGETS = `query CovenProjectItemAddTargets($projectId: ID!, $contentId: ID!, $after: String) {
    project: node(id: $projectId) {
      ... on ProjectV2 {
        id
        owner { ... on Organization { login } ... on User { login } }
        items(first: 100, after: $after) {
          pageInfo { hasNextPage endCursor }
          nodes { id content { ... on Issue { id } ... on PullRequest { id } } }
        }
      }
    }
    content: node(id: $contentId) {
      __typename
      ... on Issue { id repository { databaseId nameWithOwner } }
      ... on PullRequest { id repository { databaseId nameWithOwner } }
    }
  }`;
const PROJECT_ITEM_ADD = `mutation CovenProjectItemAdd($projectId: ID!, $contentId: ID!) {
    addProjectV2ItemById(input: {projectId: $projectId, contentId: $contentId}) {
      item { id }
    }
  }`;
const PROJECT_FIELD_TARGETS = `query CovenProjectItemFieldTargets($projectId: ID!, $itemId: ID!) {
    project: node(id: $projectId) {
      ... on ProjectV2 {
        id
        owner { ... on Organization { login } ... on User { login } }
        fields(first: 100) {
          nodes {
            ... on ProjectV2Field { id }
            ... on ProjectV2SingleSelectField { id options { id } }
            ... on ProjectV2IterationField { id configuration { iterations { id } } }
          }
        }
      }
    }
    item: node(id: $itemId) {
      ... on ProjectV2Item {
        id
        project { id }
        content {
          __typename
          ... on Issue { id repository { databaseId nameWithOwner } }
          ... on PullRequest { id repository { databaseId nameWithOwner } }
        }
        fieldValues(first: 100) {
          nodes {
            __typename
            ... on ProjectV2ItemFieldTextValue { field { ... on ProjectV2FieldCommon { id } } text }
            ... on ProjectV2ItemFieldNumberValue { field { ... on ProjectV2FieldCommon { id } } number }
            ... on ProjectV2ItemFieldDateValue { field { ... on ProjectV2FieldCommon { id } } date }
            ... on ProjectV2ItemFieldSingleSelectValue { field { ... on ProjectV2FieldCommon { id } } optionId }
            ... on ProjectV2ItemFieldIterationValue { field { ... on ProjectV2FieldCommon { id } } iterationId }
            ... on ProjectV2ItemFieldLabelValue { field { ... on ProjectV2FieldCommon { id } } }
            ... on ProjectV2ItemFieldMilestoneValue { field { ... on ProjectV2FieldCommon { id } } }
            ... on ProjectV2ItemFieldMultiSelectValue { field { ... on ProjectV2FieldCommon { id } } }
            ... on ProjectV2ItemFieldPullRequestValue { field { ... on ProjectV2FieldCommon { id } } }
            ... on ProjectV2ItemFieldRepositoryValue { field { ... on ProjectV2FieldCommon { id } } }
            ... on ProjectV2ItemFieldReviewerValue { field { ... on ProjectV2FieldCommon { id } } }
            ... on ProjectV2ItemFieldUserValue { field { ... on ProjectV2FieldCommon { id } } }
            ... on ProjectV2ItemIssueFieldValue { field { ... on ProjectV2FieldCommon { id } } }
          }
        }
      }
    }
  }`;
const PROJECT_FIELD_UPDATE = `mutation CovenProjectItemFieldUpdate($projectId: ID!, $itemId: ID!, $fieldId: ID!, $value: ProjectV2FieldValue!) {
    updateProjectV2ItemFieldValue(input: {projectId: $projectId, itemId: $itemId, fieldId: $fieldId, value: $value}) {
      projectV2Item { id }
    }
  }`;
const PROJECT_FIELD_CLEAR = `mutation CovenProjectItemFieldClear($projectId: ID!, $itemId: ID!, $fieldId: ID!) {
    clearProjectV2ItemFieldValue(input: {projectId: $projectId, itemId: $itemId, fieldId: $fieldId}) {
      projectV2Item { id }
    }
}`;

export function createGitHubOperationProvider(
  input: Readonly<{
    clock?: () => number;
    fetch?: FetchLike;
    maxResponseBytes?: number;
    timeoutMs?: number;
    withInstallationAuthorization: GitHubAppClient["withInstallationAuthorization"];
  }>
): GitHubOperationProvider {
  const fetchImpl = input.fetch ?? ((url, init) => fetch(url, init));
  const clock = input.clock ?? Date.now;
  const timeoutMs = input.timeoutMs ?? DEFAULT_TIMEOUT_MS;
  const maxResponseBytes = input.maxResponseBytes ?? DEFAULT_MAX_RESPONSE_BYTES;

  async function requestJson(
    authorization: string,
    path: string,
    init: RequestInit = {},
    requestKind: "mutation" | "read" = "read",
    deadlineAt = Number.POSITIVE_INFINITY
  ): Promise<
    Readonly<{
      body: unknown;
      lastPage: number | null;
      requestId: string | null;
    }>
  > {
    const remaining = deadlineAt - clock();
    if (!(remaining > 0)) {
      throw new GitHubToolProviderError("github_provider_timeout", {
        mutationMayHaveReached: false,
        retryable: true,
        status: 503,
      });
    }
    const effectiveTimeout = Math.min(timeoutMs, remaining);
    const controller = new AbortController();
    let timedOut = false;
    let timer: ReturnType<typeof setTimeout> | undefined;
    const timeout = new Promise<never>((_resolve, reject) => {
      timer = globalThis.setTimeout(() => {
        timedOut = true;
        controller.abort();
        reject(
          new GitHubToolProviderError("github_provider_timeout", {
            mutationMayHaveReached: requestKind === "mutation",
            retryable: true,
            status: 503,
          })
        );
      }, effectiveTimeout);
    });
    const operation = async () => {
      let response: Response;
      try {
        response = await fetchImpl(`${GITHUB_API_ORIGIN}${path}`, {
          ...init,
          headers: {
            accept: "application/vnd.github+json",
            authorization,
            "content-type": "application/json",
            "user-agent": "OpenCoven-GitHub-Tool",
            "x-github-api-version": GITHUB_API_VERSION,
            ...Object.fromEntries(new Headers(init.headers).entries()),
          },
          method: init.method ?? "GET",
          signal: controller.signal,
        });
      } catch {
        throw new GitHubToolProviderError(
          timedOut || controller.signal.aborted
            ? "github_provider_timeout"
            : "github_provider_unavailable",
          {
            mutationMayHaveReached: requestKind === "mutation",
            retryable: true,
            status: 503,
          }
        );
      }
      const requestId = providerRequestId(response);
      if (!response.ok) {
        const rateLimited =
          response.status === 429 ||
          ((response.status === 403 || response.status === 422) &&
            (response.headers.has("retry-after") ||
              response.headers.get("x-ratelimit-remaining") === "0"));
        throw new GitHubToolProviderError(
          rateLimited
            ? "github_provider_rate_limited"
            : response.status === 404
              ? "github_provider_not_found"
              : response.status >= 500
                ? "github_provider_unavailable"
                : "github_provider_rejected",
          {
            mutationMayHaveReached:
              requestKind === "mutation" &&
              (response.status >= 500 || rateLimited),
            providerRequestId: requestId,
            retryable: rateLimited || response.status >= 500,
            status: rateLimited
              ? 429
              : response.status >= 500
                ? 503
                : response.status,
          }
        );
      }
      let text: string;
      try {
        text = await readBoundedText(response, maxResponseBytes);
      } catch (error) {
        if (error instanceof GitHubToolProviderError) {
          throw new GitHubToolProviderError(error.code, {
            mutationMayHaveReached: requestKind === "mutation",
            providerRequestId: requestId ?? error.providerRequestId,
            retryable: error.retryable,
            status: error.status,
          });
        }
        throw new GitHubToolProviderError("github_provider_response_reset", {
          mutationMayHaveReached: requestKind === "mutation",
          providerRequestId: requestId,
          retryable: requestKind === "read",
          status: 502,
        });
      }
      try {
        return {
          body: text ? (JSON.parse(text) as unknown) : null,
          lastPage: providerLastPage(response),
          requestId,
        };
      } catch {
        throw new GitHubToolProviderError("github_provider_invalid_response", {
          mutationMayHaveReached: requestKind === "mutation",
          providerRequestId: requestId,
          retryable: requestKind === "read",
          status: 502,
        });
      }
    };
    try {
      return await Promise.race([operation(), timeout]);
    } finally {
      if (timer !== undefined) {
        globalThis.clearTimeout(timer);
      }
    }
  }

  function permissions(
    operation: GitHubToolOperation
  ): Readonly<Record<string, GitHubPermissionLevel>> {
    switch (operation.kind) {
      case "issue.get":
      case "issue.search":
        return { issues: "read", metadata: "read" };
      case "issue.create":
      case "issue.comment":
        return { issues: "write", metadata: "read" };
      case "pull.get":
        return { metadata: "read", pull_requests: "read" };
      case "pull.create":
      case "pull.comment":
      case "pull.review":
        return { metadata: "read", pull_requests: "write" };
      case "repository.commit":
        return { contents: "write", metadata: "read" };
      case "project.item.add":
      case "project.item.field.update":
        return {
          organization_projects: "write",
          [operation.contentType === "issue" ? "issues" : "pull_requests"]:
            "read",
          metadata: "read",
        };
      default:
        throw new GitHubToolProviderError("github_operation_unsupported", {
          retryable: false,
          status: 400,
        });
    }
  }

  function repositoryPath(context: GitHubOperationExecutionContext): string {
    return `/repos/${encodeURIComponent(context.repositoryOwner)}/${encodeURIComponent(context.repositoryName)}`;
  }

  function withRequestId(
    result: GitHubProviderOperationResult,
    requestId: string | null
  ): GitHubProviderOperationResult {
    return { ...result, providerRequestId: requestId };
  }

  function marker(context: GitHubOperationExecutionContext): string {
    const value = context.operation.operationMarker;
    if (!value) {
      throw new GitHubToolProviderError("github_operation_marker_missing", {
        retryable: false,
        status: 409,
      });
    }
    return value;
  }

  async function authorizeMutation(
    callback: () => Promise<boolean>,
    deadlineAt: number
  ): Promise<void> {
    if (!(deadlineAt - clock() > 0)) {
      throw new GitHubToolProviderError("github_provider_timeout", {
        mutationMayHaveReached: false,
        retryable: true,
        status: 503,
      });
    }
    let authorized: boolean;
    try {
      authorized = await callback();
    } catch {
      throw new GitHubToolProviderError("github_gateway_unavailable", {
        retryable: true,
        status: 503,
      });
    }
    if (!authorized) {
      throw new GitHubToolProviderError("github_operation_authority_changed", {
        retryable: false,
        status: 401,
      });
    }
  }

  function uncertain(
    providerRequestIdValue: string | null = null
  ): GitHubToolProviderError {
    return new GitHubToolProviderError("github_write_uncertain", {
      providerRequestId: providerRequestIdValue,
      retryable: false,
      status: 409,
      uncertain: true,
    });
  }

  function parseMutationResult<T>(
    response: Readonly<{ body: unknown; requestId: string | null }>,
    parse: () => T
  ): T {
    try {
      return parse();
    } catch (error) {
      if (error instanceof GitHubToolProviderError) {
        throw new GitHubToolProviderError(error.code, {
          mutationMayHaveReached: true,
          providerRequestId: response.requestId ?? error.providerRequestId,
          retryable: error.retryable,
          status: error.status,
          uncertain: error.uncertain,
        });
      }
      throw new GitHubToolProviderError("github_provider_invalid_response", {
        mutationMayHaveReached: true,
        providerRequestId: response.requestId,
        retryable: false,
        status: 502,
      });
    }
  }

  async function executeWrite(
    execution: Parameters<GitHubOperationProvider["execute"]>[0],
    mutate: () => Promise<GitHubProviderOperationResult>,
    recover: () => Promise<GitHubProviderOperationResult | null>
  ): Promise<GitHubProviderOperationResult> {
    if (execution.mode === "recover") {
      const recovered = await recover();
      if (!recovered) {
        throw uncertain();
      }
      return recovered;
    }
    try {
      return await mutate();
    } catch (error) {
      if (
        !(
          error instanceof GitHubToolProviderError &&
          error.mutationMayHaveReached
        )
      ) {
        throw error;
      }
      try {
        const recovered = await recover();
        if (recovered) {
          return {
            ...recovered,
            providerRequestId:
              error.providerRequestId ?? recovered.providerRequestId,
          };
        }
      } catch {
        // The original write may have succeeded; never issue it again.
      }
      throw uncertain(error.providerRequestId);
    }
  }

  async function graphqlJson(
    authorization: string,
    operationName: string,
    query: string,
    variables: Readonly<Record<string, unknown>>,
    requestKind: "mutation" | "read" = "read",
    deadlineAt = Number.POSITIVE_INFINITY
  ) {
    return requestJson(
      authorization,
      "/graphql",
      {
        body: JSON.stringify({ operationName, query, variables }),
        method: "POST",
      },
      requestKind,
      deadlineAt
    );
  }

  function validateContentIdentity(
    context: GitHubOperationExecutionContext,
    value: unknown,
    input: Readonly<{ contentId: string; contentType: "issue" | "pull" }>
  ): void {
    const content = object(value);
    const repository = object(content.repository);
    const expectedType =
      input.contentType === "issue" ? "Issue" : "PullRequest";
    if (
      content.__typename !== expectedType ||
      content.id !== input.contentId ||
      decimal(repository.databaseId) !== context.repositoryId ||
      String(repository.nameWithOwner).toLowerCase() !==
        `${context.repositoryOwner}/${context.repositoryName}`.toLowerCase()
    ) {
      throw new GitHubToolProviderError("github_target_mismatch", {
        retryable: false,
        status: 409,
      });
    }
  }

  function validateProjectIdentity(
    context: GitHubOperationExecutionContext,
    value: unknown,
    projectId: string
  ): Record<string, unknown> {
    const project = object(value);
    const owner = object(project.owner);
    if (
      project.id !== projectId ||
      typeof owner.login !== "string" ||
      owner.login.toLowerCase() !== context.accountLogin.toLowerCase()
    ) {
      throw new GitHubToolProviderError("github_target_mismatch", {
        retryable: false,
        status: 409,
      });
    }
    return project;
  }

  function projectResult(
    context: GitHubOperationExecutionContext,
    input: Readonly<{
      fieldId?: string;
      itemId: string;
      kind: "project.item.add" | "project.item.field.update";
      projectId: string;
    }>
  ): GitHubProviderOperationResult {
    return {
      providerRequestId: null,
      result: githubToolResultSchema.parse({
        ...(input.fieldId ? { fieldId: input.fieldId } : {}),
        itemId: input.itemId,
        kind: input.kind,
        projectId: input.projectId,
        repository: `${context.repositoryOwner}/${context.repositoryName}`,
      }),
      resultNodeId: input.itemId,
      resultUrl: null,
    };
  }

  function projectValue(
    operation: Extract<
      GitHubToolOperation,
      { kind: "project.item.field.update" }
    >
  ): Record<string, unknown> | null {
    switch (operation.value.kind) {
      case "clear":
        return null;
      case "date":
        return { date: operation.value.date };
      case "iteration":
        return { iterationId: operation.value.iterationId };
      case "number":
        return { number: operation.value.number };
      case "single_select":
        return { singleSelectOptionId: operation.value.optionId };
      case "text":
        return { text: operation.value.text };
      default:
        throw invalidResponse();
    }
  }

  function currentProjectValueMatches(
    nodes: unknown[],
    operation: Extract<
      GitHubToolOperation,
      { kind: "project.item.field.update" }
    >
  ): boolean {
    const supportedTypes = new Set([
      "ProjectV2ItemFieldTextValue",
      "ProjectV2ItemFieldNumberValue",
      "ProjectV2ItemFieldDateValue",
      "ProjectV2ItemFieldSingleSelectValue",
      "ProjectV2ItemFieldIterationValue",
    ]);
    const queriedTypes = new Set([
      ...supportedTypes,
      "ProjectV2ItemFieldLabelValue",
      "ProjectV2ItemFieldMilestoneValue",
      "ProjectV2ItemFieldMultiSelectValue",
      "ProjectV2ItemFieldPullRequestValue",
      "ProjectV2ItemFieldRepositoryValue",
      "ProjectV2ItemFieldReviewerValue",
      "ProjectV2ItemFieldUserValue",
      "ProjectV2ItemIssueFieldValue",
    ]);
    const matching = nodes.filter((node) => {
      const body = object(node);
      if (
        typeof body.__typename !== "string" ||
        !queriedTypes.has(body.__typename)
      ) {
        return false;
      }
      return object(body.field).id === operation.fieldId;
    });
    if (operation.value.kind === "clear") {
      return matching.length === 0;
    }
    return matching.some((node) => {
      const body = object(node);
      if (!supportedTypes.has(String(body.__typename))) {
        return false;
      }
      switch (operation.value.kind) {
        case "date":
          return (
            body.__typename === "ProjectV2ItemFieldDateValue" &&
            body.date === operation.value.date
          );
        case "iteration":
          return (
            body.__typename === "ProjectV2ItemFieldIterationValue" &&
            body.iterationId === operation.value.iterationId
          );
        case "number":
          return (
            body.__typename === "ProjectV2ItemFieldNumberValue" &&
            body.number === operation.value.number
          );
        case "single_select":
          return (
            body.__typename === "ProjectV2ItemFieldSingleSelectValue" &&
            body.optionId === operation.value.optionId
          );
        case "text":
          return (
            body.__typename === "ProjectV2ItemFieldTextValue" &&
            body.text === operation.value.text
          );
        default:
          return false;
      }
    });
  }

  async function executeWithAuthorization(
    execution: Parameters<GitHubOperationProvider["execute"]>[0],
    operation: GitHubToolOperation,
    authorization: string
  ): Promise<GitHubProviderOperationResult> {
    const { context } = execution;
    const deadlineAt =
      execution.deadlineAt ?? clock() + GITHUB_TOOL_SERVER_DEADLINE_MS;
    const request = (
      requestAuthorization: string,
      path: string,
      init: RequestInit = {},
      requestKind: "mutation" | "read" = "read"
    ) => requestJson(requestAuthorization, path, init, requestKind, deadlineAt);
    const graphql = (
      requestAuthorization: string,
      operationName: string,
      query: string,
      variables: Readonly<Record<string, unknown>>,
      requestKind: "mutation" | "read" = "read"
    ) =>
      graphqlJson(
        requestAuthorization,
        operationName,
        query,
        variables,
        requestKind,
        deadlineAt
      );
    const basePath = repositoryPath(context);
    switch (operation.kind) {
      case "issue.get": {
        const response = await request(
          authorization,
          `${basePath}/issues/${operation.issueNumber}`,
          { method: "GET" }
        );
        if ("pull_request" in object(response.body)) {
          throw new GitHubToolProviderError("github_target_mismatch", {
            retryable: false,
            status: 409,
          });
        }
        const parsed = withRequestId(
          issueResult(context, response.body, "issue.get"),
          response.requestId
        );
        if (
          parsed.result.kind !== "issue.get" ||
          parsed.result.issue.number !== operation.issueNumber
        ) {
          throw new GitHubToolProviderError("github_target_mismatch", {
            retryable: false,
            status: 409,
          });
        }
        return parsed;
      }
      case "issue.search": {
        const qualifiers = [
          `repo:${context.repositoryOwner}/${context.repositoryName}`,
          "is:issue",
          ...(operation.state === "all" ? [] : [`is:${operation.state}`]),
          operation.query,
        ].join(" ");
        const parameters = new URLSearchParams({
          page: "1",
          per_page: String(operation.limit),
          q: qualifiers,
        });
        const response = await request(
          authorization,
          `/search/issues?${parameters.toString()}`,
          { method: "GET" }
        );
        const body = object(response.body);
        const items = array(body.items, operation.limit).map((item) =>
          issueSummary(context, item)
        );
        return {
          providerRequestId: response.requestId,
          result: githubToolResultSchema.parse({
            items,
            kind: "issue.search",
            repository: `${context.repositoryOwner}/${context.repositoryName}`,
          }),
          resultNodeId: null,
          resultUrl: null,
        };
      }
      case "pull.get": {
        const response = await request(
          authorization,
          `${basePath}/pulls/${operation.pullNumber}`,
          { method: "GET" }
        );
        const parsed = withRequestId(
          pullResult(context, response.body, "pull.get"),
          response.requestId
        );
        if (
          parsed.result.kind !== "pull.get" ||
          parsed.result.pull.number !== operation.pullNumber
        ) {
          throw new GitHubToolProviderError("github_target_mismatch", {
            retryable: false,
            status: 409,
          });
        }
        return parsed;
      }
      case "issue.create": {
        const operationMarker = marker(context);
        const recover = async () => {
          const parameters = new URLSearchParams({
            page: "1",
            per_page: "30",
            q: `repo:${context.repositoryOwner}/${context.repositoryName} is:issue in:body "${operationMarker}"`,
          });
          const response = await request(
            authorization,
            `/search/issues?${parameters.toString()}`,
            { method: "GET" }
          );
          const found = array(object(response.body).items, 30).find((item) => {
            const candidate = object(item);
            return (
              !("pull_request" in candidate) &&
              typeof candidate.body === "string" &&
              candidate.body.includes(operationMarker)
            );
          });
          return found
            ? withRequestId(
                issueResult(context, found, "issue.create"),
                response.requestId
              )
            : null;
        };
        return executeWrite(
          execution,
          async () => {
            await authorizeMutation(execution.authorizeMutation, deadlineAt);
            const response = await request(
              authorization,
              `${basePath}/issues`,
              {
                body: JSON.stringify({
                  assignees: operation.assignees,
                  body: appendMarker(operation.body, operationMarker),
                  labels: operation.labels,
                  title: operation.title,
                }),
                method: "POST",
              },
              "mutation"
            );
            return parseMutationResult(response, () =>
              withRequestId(
                issueResult(context, response.body, "issue.create"),
                response.requestId
              )
            );
          },
          recover
        );
      }
      case "issue.comment": {
        const operationMarker = marker(context);
        const recover = async () => {
          const firstPage = await request(
            authorization,
            `${basePath}/issues/${operation.issueNumber}/comments?per_page=100&page=1`,
            { method: "GET" }
          );
          let response = firstPage;
          let found = array(response.body).find((item) => {
            const candidate = object(item);
            return (
              typeof candidate.body === "string" &&
              candidate.body.includes(operationMarker)
            );
          });
          if (!found && firstPage.lastPage && firstPage.lastPage > 1) {
            response = await request(
              authorization,
              `${basePath}/issues/${operation.issueNumber}/comments?per_page=100&page=${firstPage.lastPage}`,
              { method: "GET" }
            );
            found = array(response.body).find((item) => {
              const candidate = object(item);
              return (
                typeof candidate.body === "string" &&
                candidate.body.includes(operationMarker)
              );
            });
          }
          return found
            ? withRequestId(
                commentResult(context, found, "issue.comment"),
                response.requestId ?? firstPage.requestId
              )
            : null;
        };
        return executeWrite(
          execution,
          async () => {
            const target = await request(
              authorization,
              `${basePath}/issues/${operation.issueNumber}`,
              { method: "GET" }
            );
            if (
              "pull_request" in object(target.body) ||
              decimal(object(target.body).number) !== operation.issueNumber
            ) {
              throw new GitHubToolProviderError("github_target_mismatch", {
                retryable: false,
                status: 409,
              });
            }
            await authorizeMutation(execution.authorizeMutation, deadlineAt);
            const response = await request(
              authorization,
              `${basePath}/issues/${operation.issueNumber}/comments`,
              {
                body: JSON.stringify({
                  body: appendMarker(operation.body, operationMarker),
                }),
                method: "POST",
              },
              "mutation"
            );
            return parseMutationResult(response, () =>
              withRequestId(
                commentResult(context, response.body, "issue.comment"),
                response.requestId
              )
            );
          },
          recover
        );
      }
      case "pull.create": {
        const operationMarker = marker(context);
        const recover = async () => {
          const parameters = new URLSearchParams({
            page: "1",
            per_page: "30",
            q: `repo:${context.repositoryOwner}/${context.repositoryName} is:pr in:body "${operationMarker}"`,
          });
          const response = await request(
            authorization,
            `/search/issues?${parameters.toString()}`,
            { method: "GET" }
          );
          const found = array(object(response.body).items, 30).find((item) => {
            const candidate = object(item);
            return (
              "pull_request" in candidate &&
              typeof candidate.body === "string" &&
              candidate.body.includes(operationMarker)
            );
          });
          if (!found) {
            return null;
          }
          const number = decimal(object(found).number);
          const full = await request(
            authorization,
            `${basePath}/pulls/${number}`,
            { method: "GET" }
          );
          return withRequestId(
            pullResult(context, full.body, "pull.create"),
            response.requestId ?? full.requestId
          );
        };
        return executeWrite(
          execution,
          async () => {
            await authorizeMutation(execution.authorizeMutation, deadlineAt);
            const response = await request(
              authorization,
              `${basePath}/pulls`,
              {
                body: JSON.stringify({
                  base: operation.base,
                  body: appendMarker(operation.body, operationMarker),
                  draft: operation.draft,
                  head: operation.head,
                  title: operation.title,
                }),
                method: "POST",
              },
              "mutation"
            );
            return parseMutationResult(response, () =>
              withRequestId(
                pullResult(context, response.body, "pull.create"),
                response.requestId
              )
            );
          },
          recover
        );
      }
      case "pull.comment": {
        const operationMarker = marker(context);
        const recover = async () => {
          const firstPage = await request(
            authorization,
            `${basePath}/issues/${operation.pullNumber}/comments?per_page=100&page=1`,
            { method: "GET" }
          );
          let response = firstPage;
          let found = array(response.body).find((item) => {
            const candidate = object(item);
            return (
              typeof candidate.body === "string" &&
              candidate.body.includes(operationMarker)
            );
          });
          if (!found && firstPage.lastPage && firstPage.lastPage > 1) {
            response = await request(
              authorization,
              `${basePath}/issues/${operation.pullNumber}/comments?per_page=100&page=${firstPage.lastPage}`,
              { method: "GET" }
            );
            found = array(response.body).find((item) => {
              const candidate = object(item);
              return (
                typeof candidate.body === "string" &&
                candidate.body.includes(operationMarker)
              );
            });
          }
          return found
            ? withRequestId(
                commentResult(context, found, "pull.comment"),
                response.requestId ?? firstPage.requestId
              )
            : null;
        };
        return executeWrite(
          execution,
          async () => {
            const target = await request(
              authorization,
              `${basePath}/pulls/${operation.pullNumber}`,
              { method: "GET" }
            );
            if (decimal(object(target.body).number) !== operation.pullNumber) {
              throw new GitHubToolProviderError("github_target_mismatch", {
                retryable: false,
                status: 409,
              });
            }
            await authorizeMutation(execution.authorizeMutation, deadlineAt);
            const response = await request(
              authorization,
              `${basePath}/issues/${operation.pullNumber}/comments`,
              {
                body: JSON.stringify({
                  body: appendMarker(operation.body, operationMarker),
                }),
                method: "POST",
              },
              "mutation"
            );
            return parseMutationResult(response, () =>
              withRequestId(
                commentResult(context, response.body, "pull.comment"),
                response.requestId
              )
            );
          },
          recover
        );
      }
      case "pull.review": {
        const operationMarker = marker(context);
        const recover = async () => {
          const firstPage = await request(
            authorization,
            `${basePath}/pulls/${operation.pullNumber}/reviews?per_page=100&page=1`,
            { method: "GET" }
          );
          let response = firstPage;
          let found = array(response.body).find((item) => {
            const candidate = object(item);
            return (
              typeof candidate.body === "string" &&
              candidate.body.includes(operationMarker)
            );
          });
          if (!found && firstPage.lastPage && firstPage.lastPage > 1) {
            response = await request(
              authorization,
              `${basePath}/pulls/${operation.pullNumber}/reviews?per_page=100&page=${firstPage.lastPage}`,
              { method: "GET" }
            );
            found = array(response.body).find((item) => {
              const candidate = object(item);
              return (
                typeof candidate.body === "string" &&
                candidate.body.includes(operationMarker)
              );
            });
          }
          return found
            ? withRequestId(
                reviewResult(context, found),
                response.requestId ?? firstPage.requestId
              )
            : null;
        };
        return executeWrite(
          execution,
          async () => {
            const target = await request(
              authorization,
              `${basePath}/pulls/${operation.pullNumber}`,
              { method: "GET" }
            );
            if (decimal(object(target.body).number) !== operation.pullNumber) {
              throw new GitHubToolProviderError("github_target_mismatch", {
                retryable: false,
                status: 409,
              });
            }
            await authorizeMutation(execution.authorizeMutation, deadlineAt);
            const response = await request(
              authorization,
              `${basePath}/pulls/${operation.pullNumber}/reviews`,
              {
                body: JSON.stringify({
                  body: appendMarker(operation.body, operationMarker),
                  event:
                    operation.event === "approve"
                      ? "APPROVE"
                      : operation.event === "request_changes"
                        ? "REQUEST_CHANGES"
                        : "COMMENT",
                }),
                method: "POST",
              },
              "mutation"
            );
            return parseMutationResult(response, () =>
              withRequestId(
                reviewResult(context, response.body),
                response.requestId
              )
            );
          },
          recover
        );
      }
      case "repository.commit": {
        const operationMarker = marker(context);
        const branchRef = `refs/heads/${operation.branch}`;
        const branchPath = `${basePath}/git/ref/heads/${encodeURIComponent(operation.branch)}`;
        const resultFromCommit = (
          response: Readonly<{ body: unknown; requestId: string | null }>,
          expectedSha?: string
        ): GitHubProviderOperationResult => {
          const body = object(response.body);
          const sha = gitSha(body.sha);
          const url = string(body.html_url, 2048);
          if (
            (expectedSha !== undefined && sha !== expectedSha) ||
            body.message !== `${operation.message}\n\n${operationMarker}`
          ) {
            throw new GitHubToolProviderError("github_target_mismatch", {
              retryable: false,
              status: 409,
            });
          }
          if (
            !url.startsWith(
              `https://github.com/${context.repositoryOwner}/${context.repositoryName}/commit/`
            ) ||
            !url.endsWith(`/${sha}`)
          ) {
            throw invalidResponse();
          }
          return {
            providerRequestId: response.requestId,
            result: githubToolResultSchema.parse({
              branch: operation.branch,
              commit: { sha, url },
              kind: operation.kind,
              repository: `${context.repositoryOwner}/${context.repositoryName}`,
            }),
            resultNodeId: sha,
            resultUrl: url,
          };
        };
        const inspect = async () => {
          let branch: Awaited<ReturnType<typeof request>>;
          try {
            branch = await request(authorization, branchPath, {
              method: "GET",
            });
          } catch (error) {
            if (
              error instanceof GitHubToolProviderError &&
              error.code === "github_provider_not_found"
            ) {
              return null;
            }
            throw error;
          }
          const sha = gitRefSha(branch.body, branchRef);
          const commit = await request(
            authorization,
            `${basePath}/git/commits/${sha}`,
            { method: "GET" }
          );
          return resultFromCommit(commit, sha);
        };
        if (execution.mode === "recover") {
          return executeWrite(
            execution,
            () => Promise.reject(uncertain()),
            inspect
          );
        }
        const existing = await inspect();
        if (existing) {
          return existing;
        }
        const baseRef = `refs/heads/${operation.base}`;
        const base = await request(
          authorization,
          `${basePath}/git/ref/heads/${encodeURIComponent(operation.base)}`,
          { method: "GET" }
        );
        const baseSha = gitRefSha(base.body, baseRef);
        const baseCommit = await request(
          authorization,
          `${basePath}/git/commits/${baseSha}`,
          { method: "GET" }
        );
        const baseTreeSha = gitCommitTreeSha(baseCommit.body, baseSha);
        const treeCache = new Map<string, readonly GitTreeEntry[]>();
        const loadTree = async (sha: string) => {
          const cached = treeCache.get(sha);
          if (cached) {
            return cached;
          }
          const response = await request(
            authorization,
            `${basePath}/git/trees/${sha}`,
            { method: "GET" }
          );
          const entries = gitTreeEntries(response.body, sha);
          treeCache.set(sha, entries);
          return entries;
        };
        const existingBlobMode = async (path: string): Promise<GitBlobMode> => {
          const segments = path.split("/");
          let treeSha = baseTreeSha;
          for (const [index, segment] of segments.entries()) {
            const entry = (await loadTree(treeSha)).find(
              (candidate) => candidate.path === segment
            );
            if (!entry) {
              return "100644";
            }
            if (index === segments.length - 1) {
              if (
                entry.type === "blob" &&
                (entry.mode === "100644" || entry.mode === "100755")
              ) {
                return entry.mode;
              }
              throw new GitHubToolProviderError("github_target_mismatch", {
                retryable: false,
                status: 409,
              });
            }
            if (entry.type !== "tree" || entry.mode !== "040000") {
              throw new GitHubToolProviderError("github_target_mismatch", {
                retryable: false,
                status: 409,
              });
            }
            treeSha = entry.sha;
          }
          return "100644";
        };
        const upsertModes = new Map<string, GitBlobMode>();
        for (const file of operation.files) {
          if (file.operation === "upsert") {
            upsertModes.set(file.path, await existingBlobMode(file.path));
          }
        }
        return executeWrite(
          execution,
          async () => {
            await authorizeMutation(execution.authorizeMutation, deadlineAt);
            const tree: Array<{
              mode: GitBlobMode;
              path: string;
              sha: string | null;
              type: "blob";
            }> = [];
            for (const file of operation.files) {
              if (file.operation === "delete") {
                tree.push({
                  mode: "100644",
                  path: file.path,
                  sha: null,
                  type: "blob",
                });
                continue;
              }
              const mode = upsertModes.get(file.path);
              if (!mode) {
                throw invalidResponse();
              }
              const blob = await request(
                authorization,
                `${basePath}/git/blobs`,
                {
                  body: JSON.stringify({
                    content: file.content,
                    encoding: "utf-8",
                  }),
                  method: "POST",
                },
                "mutation"
              );
              tree.push({
                mode,
                path: file.path,
                sha: gitSha(object(blob.body).sha),
                type: "blob",
              });
            }
            const createdTree = await request(
              authorization,
              `${basePath}/git/trees`,
              {
                body: JSON.stringify({ base_tree: baseTreeSha, tree }),
                method: "POST",
              },
              "mutation"
            );
            const treeSha = gitSha(object(createdTree.body).sha);
            const createdCommit = await request(
              authorization,
              `${basePath}/git/commits`,
              {
                body: JSON.stringify({
                  message: `${operation.message}\n\n${operationMarker}`,
                  parents: [baseSha],
                  tree: treeSha,
                }),
                method: "POST",
              },
              "mutation"
            );
            const result = parseMutationResult(createdCommit, () =>
              resultFromCommit(createdCommit)
            );
            const commitSha = result.resultNodeId;
            if (!commitSha) {
              throw invalidResponse();
            }
            await authorizeMutation(execution.authorizeMutation, deadlineAt);
            const createdRef = await request(
              authorization,
              `${basePath}/git/refs`,
              {
                body: JSON.stringify({ ref: branchRef, sha: commitSha }),
                method: "POST",
              },
              "mutation"
            );
            if (gitRefSha(createdRef.body, branchRef) !== commitSha) {
              throw invalidResponse();
            }
            return {
              ...result,
              providerRequestId:
                createdRef.requestId ?? result.providerRequestId,
            };
          },
          inspect
        );
      }
      case "project.item.add": {
        const inspect = async () => {
          let after: string | null = null;
          let requestId: string | null = null;
          const seenCursors = new Set<string>();
          for (let page = 0; page < MAX_PROJECT_ITEM_PAGES; page += 1) {
            const response = await graphql(
              authorization,
              "CovenProjectItemAddTargets",
              PROJECT_ITEM_ADD_TARGETS,
              {
                after,
                contentId: operation.contentId,
                projectId: operation.projectId,
              }
            );
            requestId = response.requestId ?? requestId;
            const data = graphqlData(response.body);
            const project = validateProjectIdentity(
              context,
              data.project,
              operation.projectId
            );
            validateContentIdentity(context, data.content, operation);
            const items = object(project.items);
            const found = array(items.nodes).find((item) => {
              const candidate = object(item);
              const content = candidate.content;
              return (
                content !== null && object(content).id === operation.contentId
              );
            });
            if (found) {
              return {
                foundId: string(object(found).id, 256, NODE_ID),
                requestId,
              };
            }
            const pageInfo = object(items.pageInfo);
            if (typeof pageInfo.hasNextPage !== "boolean") {
              throw invalidResponse();
            }
            if (!pageInfo.hasNextPage) {
              return { foundId: null, requestId };
            }
            const endCursor = string(pageInfo.endCursor, 512);
            if (!endCursor || seenCursors.has(endCursor)) {
              throw invalidResponse();
            }
            seenCursors.add(endCursor);
            after = endCursor;
          }
          throw new GitHubToolProviderError(
            "github_provider_response_too_large",
            { retryable: true, status: 503 }
          );
        };
        const initial = await inspect();
        if (initial.foundId) {
          return withRequestId(
            projectResult(context, {
              itemId: initial.foundId,
              kind: operation.kind,
              projectId: operation.projectId,
            }),
            initial.requestId
          );
        }
        if (execution.mode === "recover") {
          throw uncertain(initial.requestId);
        }
        return executeWrite(
          execution,
          async () => {
            await authorizeMutation(execution.authorizeMutation, deadlineAt);
            const response = await graphql(
              authorization,
              "CovenProjectItemAdd",
              PROJECT_ITEM_ADD,
              {
                contentId: operation.contentId,
                projectId: operation.projectId,
              },
              "mutation"
            );
            return parseMutationResult(response, () => {
              const item = object(
                object(graphqlData(response.body).addProjectV2ItemById).item
              );
              return withRequestId(
                projectResult(context, {
                  itemId: string(item.id, 256, NODE_ID),
                  kind: operation.kind,
                  projectId: operation.projectId,
                }),
                response.requestId
              );
            });
          },
          async () => {
            const recovered = await inspect();
            return recovered.foundId
              ? withRequestId(
                  projectResult(context, {
                    itemId: recovered.foundId,
                    kind: operation.kind,
                    projectId: operation.projectId,
                  }),
                  recovered.requestId
                )
              : null;
          }
        );
      }
      case "project.item.field.update": {
        const inspect = async () => {
          const response = await graphql(
            authorization,
            "CovenProjectItemFieldTargets",
            PROJECT_FIELD_TARGETS,
            {
              itemId: operation.itemId,
              projectId: operation.projectId,
            }
          );
          const data = graphqlData(response.body);
          const project = validateProjectIdentity(
            context,
            data.project,
            operation.projectId
          );
          const item = object(data.item);
          if (
            item.id !== operation.itemId ||
            object(item.project).id !== operation.projectId
          ) {
            throw new GitHubToolProviderError("github_target_mismatch", {
              retryable: false,
              status: 409,
            });
          }
          validateContentIdentity(context, item.content, operation);
          const fields = array(object(project.fields).nodes);
          const field = fields.find(
            (candidate) => object(candidate).id === operation.fieldId
          );
          if (!field) {
            throw new GitHubToolProviderError("github_target_mismatch", {
              retryable: false,
              status: 409,
            });
          }
          if (operation.value.kind === "single_select") {
            const { optionId } = operation.value;
            if (
              !array(object(field).options).some(
                (option) => object(option).id === optionId
              )
            ) {
              throw new GitHubToolProviderError("github_target_mismatch", {
                retryable: false,
                status: 409,
              });
            }
          }
          if (operation.value.kind === "iteration") {
            const { iterationId } = operation.value;
            if (
              !array(object(object(field).configuration).iterations).some(
                (iteration) => object(iteration).id === iterationId
              )
            ) {
              throw new GitHubToolProviderError("github_target_mismatch", {
                retryable: false,
                status: 409,
              });
            }
          }
          return {
            matches: currentProjectValueMatches(
              array(object(item.fieldValues).nodes),
              operation
            ),
            requestId: response.requestId,
          };
        };
        const initial = await inspect();
        if (initial.matches) {
          return withRequestId(
            projectResult(context, {
              fieldId: operation.fieldId,
              itemId: operation.itemId,
              kind: operation.kind,
              projectId: operation.projectId,
            }),
            initial.requestId
          );
        }
        if (execution.mode === "recover") {
          throw uncertain(initial.requestId);
        }
        return executeWrite(
          execution,
          async () => {
            await authorizeMutation(execution.authorizeMutation, deadlineAt);
            const value = projectValue(operation);
            const clear = value === null;
            const response = await graphql(
              authorization,
              clear
                ? "CovenProjectItemFieldClear"
                : "CovenProjectItemFieldUpdate",
              clear ? PROJECT_FIELD_CLEAR : PROJECT_FIELD_UPDATE,
              {
                fieldId: operation.fieldId,
                itemId: operation.itemId,
                projectId: operation.projectId,
                ...(value ? { value } : {}),
              },
              "mutation"
            );
            return parseMutationResult(response, () => {
              const mutation = object(
                graphqlData(response.body)[
                  clear
                    ? "clearProjectV2ItemFieldValue"
                    : "updateProjectV2ItemFieldValue"
                ]
              );
              const item = object(mutation.projectV2Item);
              if (item.id !== operation.itemId) {
                throw invalidResponse();
              }
              return withRequestId(
                projectResult(context, {
                  fieldId: operation.fieldId,
                  itemId: operation.itemId,
                  kind: operation.kind,
                  projectId: operation.projectId,
                }),
                response.requestId
              );
            });
          },
          async () => {
            const recovered = await inspect();
            return recovered.matches
              ? withRequestId(
                  projectResult(context, {
                    fieldId: operation.fieldId,
                    itemId: operation.itemId,
                    kind: operation.kind,
                    projectId: operation.projectId,
                  }),
                  recovered.requestId
                )
              : null;
          }
        );
      }
      default:
        throw new GitHubToolProviderError("github_operation_unsupported", {
          retryable: false,
          status: 400,
        });
    }
  }

  return {
    async execute(execution) {
      const operation = githubToolOperationSchema.parse(execution.operation);
      const deadlineAt =
        execution.deadlineAt ?? clock() + GITHUB_TOOL_SERVER_DEADLINE_MS;
      if (!(deadlineAt > clock())) {
        throw new GitHubToolProviderError("github_provider_timeout", {
          retryable: true,
          status: 503,
        });
      }
      if (
        operation.kind !== execution.context.operation.kind ||
        githubOperationRepository(operation) !==
          execution.context.operation.repository ||
        githubOperationRepository(operation) !==
          `${execution.context.repositoryOwner.toLowerCase()}/${execution.context.repositoryName.toLowerCase()}`
      ) {
        throw new GitHubToolProviderError("github_target_mismatch", {
          retryable: false,
          status: 409,
        });
      }
      if (
        (operation.kind === "project.item.add" ||
          operation.kind === "project.item.field.update") &&
        execution.context.accountType !== "Organization"
      ) {
        throw new GitHubToolProviderError(
          "github_project_installation_unsupported",
          { retryable: false, status: 409 }
        );
      }
      return await input.withInstallationAuthorization(
        {
          installationId: execution.context.installationId,
          permissions: permissions(operation),
          repositoryIds: [execution.context.repositoryId],
        },
        (authorization) =>
          executeWithAuthorization(
            { ...execution, deadlineAt },
            operation,
            authorization
          )
      );
    },
  };
}

type GitHubToolGatewayStore = Pick<
  ReturnType<typeof createGitHubGatewayStore>,
  | "authorizeMutation"
  | "completeOperation"
  | "failOperation"
  | "releaseOperationForRetry"
  | "reserveOperation"
>;

async function runDatabasePhase<T>(
  operation: (abortSignal: AbortSignal) => Promise<T>,
  timeoutMs: number
): Promise<T> {
  const controller = new AbortController();
  let timer: ReturnType<typeof setTimeout> | undefined;
  try {
    return await Promise.race([
      operation(controller.signal),
      new Promise<never>((_resolve, reject) => {
        timer = globalThis.setTimeout(() => {
          const error = new Error("GitHub database phase deadline exceeded.");
          controller.abort(error);
          reject(error);
        }, timeoutMs);
      }),
    ]);
  } finally {
    if (timer !== undefined) {
      globalThis.clearTimeout(timer);
    }
  }
}

export class GitHubToolGatewayError extends Error {
  readonly code: string;
  readonly retryable: boolean;
  readonly status: number;

  constructor(
    code: string,
    message: string,
    input: Readonly<{ retryable: boolean; status: number }>
  ) {
    super(message);
    this.name = "GitHubToolGatewayError";
    this.code = code;
    this.retryable = input.retryable;
    this.status = input.status;
  }
}

export type GitHubToolGatewayResponse = Readonly<{
  receipt: GitHubOperationReceipt;
  result: GitHubToolResult;
}>;

function gatewayErrorForReservation(
  kind: "conflict" | "in_progress" | "unauthorized"
): GitHubToolGatewayError {
  switch (kind) {
    case "unauthorized":
      return new GitHubToolGatewayError(
        "github_capability_invalid",
        "GitHub tool capability is invalid or expired.",
        { retryable: false, status: 401 }
      );
    case "conflict":
      return new GitHubToolGatewayError(
        "github_operation_conflict",
        "The operation identifier is bound to a different request.",
        { retryable: false, status: 409 }
      );
    case "in_progress":
      return new GitHubToolGatewayError(
        "github_operation_in_progress",
        "The GitHub operation is already in progress.",
        { retryable: true, status: 409 }
      );
    default:
      return new GitHubToolGatewayError(
        "github_gateway_unavailable",
        "GitHub tool execution is unavailable.",
        { retryable: true, status: 503 }
      );
  }
}

function terminalResponse(
  operation: GitHubGatewayOperationRecord
): GitHubToolGatewayResponse {
  if (operation.status !== "completed" || operation.result === null) {
    const error = operation.error;
    throw new GitHubToolGatewayError(
      error?.code ?? "github_operation_failed",
      error?.message ?? "The GitHub operation failed.",
      {
        retryable: error?.retryable ?? false,
        status:
          error?.code === "github_write_uncertain"
            ? 409
            : error?.retryable
              ? 503
              : 422,
      }
    );
  }
  return {
    receipt: githubOperationReceiptSchema.parse(
      githubOperationReceipt(operation)
    ),
    result: githubToolResultSchema.parse(operation.result),
  };
}

function providerFailure(error: unknown): Readonly<{
  error: { code: string; message: string; retryable: boolean };
  providerRequestId: string | null;
  status: number;
}> {
  if (error instanceof GitHubToolProviderError) {
    return {
      error: {
        code: error.code,
        message:
          error.code === "github_write_uncertain"
            ? "GitHub may have accepted the write; it was not replayed."
            : error.code === "github_operation_authority_changed"
              ? "GitHub operation authority changed before the write."
              : "GitHub provider execution failed.",
        retryable: error.retryable,
      },
      providerRequestId: error.providerRequestId,
      status: error.status,
    };
  }
  return {
    error: {
      code: "github_provider_unavailable",
      message: "GitHub provider execution failed.",
      retryable: true,
    },
    providerRequestId: null,
    status: 503,
  };
}

export function createGitHubToolGateway(
  input: Readonly<{
    authorityRefreshTimeoutMs?: number;
    clock?: () => Date;
    createId?: () => string;
    databasePhaseTimeoutMs?: number;
    operator: RunnerOperator;
    provider: GitHubOperationProvider;
    refreshAuthority: (
      input: Readonly<{
        abortSignal: AbortSignal;
        context: GitHubOperationExecutionContext;
        deadlineAt: number;
        operation: GitHubToolOperation;
      }>
    ) => Promise<void>;
    store: GitHubToolGatewayStore;
  }>
) {
  const clock = input.clock ?? (() => new Date());
  const createId = input.createId ?? randomUUID;
  const databasePhaseTimeoutMs =
    input.databasePhaseTimeoutMs ?? GITHUB_GATEWAY_DATABASE_PHASE_TIMEOUT_MS;
  const authorityRefreshTimeoutMs =
    input.authorityRefreshTimeoutMs ?? DEFAULT_AUTHORITY_REFRESH_TIMEOUT_MS;
  if (
    !Number.isSafeInteger(databasePhaseTimeoutMs) ||
    databasePhaseTimeoutMs < 1 ||
    databasePhaseTimeoutMs >= GITHUB_TOOL_SERVER_DEADLINE_MS
  ) {
    throw new Error("GitHub gateway database phase timeout is invalid.");
  }
  if (
    !Number.isSafeInteger(authorityRefreshTimeoutMs) ||
    authorityRefreshTimeoutMs < 1 ||
    authorityRefreshTimeoutMs >= GITHUB_TOOL_SERVER_DEADLINE_MS
  ) {
    throw new Error("GitHub authority refresh timeout is invalid.");
  }
  return {
    execute: async (
      request: Readonly<{
        operation: GitHubToolOperation;
        operationId: string;
        rawCapability: string;
      }>
    ): Promise<GitHubToolGatewayResponse> => {
      if (!RAW_CAPABILITY.test(request.rawCapability)) {
        throw new GitHubToolGatewayError(
          "github_capability_invalid",
          "GitHub tool capability is invalid or expired.",
          { retryable: false, status: 401 }
        );
      }
      const parsed = githubToolRequestSchema.parse({
        operation: request.operation,
        operationId: request.operationId,
      });
      const now = clock();
      if (Number.isNaN(now.valueOf())) {
        throw new GitHubToolGatewayError(
          "github_gateway_unavailable",
          "GitHub tool execution is unavailable.",
          { retryable: true, status: 503 }
        );
      }
      const deadlineAt = now.getTime() + GITHUB_TOOL_SERVER_DEADLINE_MS;
      const requestHash = hashGitHubOperation(parsed.operation);
      const tokenHash = createHash("sha256")
        .update(request.rawCapability, "utf8")
        .digest("hex");
      const classification = githubOperationAuthority(
        parsed.operation.kind
      ).classification;
      let reservation: Awaited<
        ReturnType<GitHubToolGatewayStore["reserveOperation"]>
      >;
      try {
        reservation = await runDatabasePhase(
          (abortSignal) =>
            input.store.reserveOperation(input.operator, {
              abortSignal,
              deadlineAt,
              executionLeaseExpiresAt: new Date(deadlineAt + 5000),
              id: createId(),
              operation: parsed.operation,
              operationId: parsed.operationId,
              requestHash,
              target: githubOperationTarget(parsed.operation),
              tokenHash,
            }),
          databasePhaseTimeoutMs
        );
      } catch {
        throw new GitHubToolGatewayError(
          "github_gateway_unavailable",
          "GitHub tool execution is unavailable.",
          { retryable: true, status: 503 }
        );
      }
      if (
        reservation.kind === "unauthorized" ||
        reservation.kind === "conflict" ||
        reservation.kind === "in_progress"
      ) {
        throw gatewayErrorForReservation(reservation.kind);
      }
      if (reservation.kind === "terminal") {
        return terminalResponse(reservation.operation);
      }
      if (reservation.kind === "intent_conflict") {
        throw new GitHubToolGatewayError(
          "github_write_intent_conflict",
          "An equivalent GitHub write intent already exists for this step.",
          { retryable: false, status: 409 }
        );
      }
      if (!("context" in reservation)) {
        throw new GitHubToolGatewayError(
          "github_gateway_unavailable",
          "GitHub tool execution is unavailable.",
          { retryable: true, status: 503 }
        );
      }

      const { context } = reservation;
      let executionContext = context;
      if (classification === "write") {
        const expectedMarker = githubOperationMarker({
          capabilityBinding: tokenHash,
          operationId: parsed.operationId,
          requestHash,
          teamStepId: context.capability.teamStepId,
        });
        if (context.operation.operationMarker !== expectedMarker) {
          const failed = await runDatabasePhase(
            (abortSignal) =>
              input.store.failOperation(input.operator, {
                abortSignal,
                deadlineAt,
                error: {
                  code: "github_operation_conflict",
                  message: "GitHub operation marker binding is invalid.",
                  retryable: false,
                },
                expectedVersion: context.operation.version,
                id: context.operation.id,
                providerRequestId: null,
              }),
            databasePhaseTimeoutMs
          );
          if (failed.kind === "failed") {
            return terminalResponse(failed.operation);
          }
          throw gatewayErrorForReservation("conflict");
        }
      }

      let providerResult: GitHubProviderOperationResult;
      let dispatchStateUncertain = false;
      try {
        const authorityRemaining = Math.min(
          authorityRefreshTimeoutMs,
          deadlineAt - clock().getTime()
        );
        if (!(authorityRemaining > 0)) {
          throw new Error("GitHub authority refresh deadline exceeded.");
        }
        await runDatabasePhase(
          (abortSignal) =>
            input.refreshAuthority({
              abortSignal,
              context: executionContext,
              deadlineAt,
              operation: parsed.operation,
            }),
          authorityRemaining
        );
        providerResult = await input.provider.execute({
          authorizeMutation: async () => {
            let authorization: Awaited<
              ReturnType<GitHubToolGatewayStore["authorizeMutation"]>
            >;
            try {
              const phaseNow = clock();
              if (
                Number.isNaN(phaseNow.valueOf()) ||
                deadlineAt - phaseNow.getTime() <= databasePhaseTimeoutMs
              ) {
                throw Object.assign(
                  new Error("GitHub database phase deadline exceeded."),
                  { code: "57014" }
                );
              }
              authorization = await runDatabasePhase(
                (abortSignal) =>
                  input.store.authorizeMutation(input.operator, {
                    abortSignal,
                    deadlineAt,
                    expectedVersion: executionContext.operation.version,
                    id: executionContext.operation.id,
                  }),
                databasePhaseTimeoutMs
              );
            } catch (error) {
              dispatchStateUncertain = !isGitHubDatabaseStatementTimeout(error);
              throw error;
            }
            if (authorization.kind !== "authorized") {
              return false;
            }
            executionContext = {
              ...executionContext,
              operation: authorization.operation ?? executionContext.operation,
            };
            return true;
          },
          context: executionContext,
          deadlineAt,
          mode: reservation.kind === "recover" ? "recover" : "execute",
          operation: parsed.operation,
        });
      } catch (error) {
        const failure = providerFailure(error);
        const knownSent =
          executionContext.operation.providerDispatchPhase === "sent" ||
          executionContext.operation.providerSentAt !== null;
        const persistedFailure = knownSent
          ? {
              code: "github_write_uncertain",
              message:
                "GitHub may have accepted the write; it was not replayed.",
              retryable: false,
            }
          : failure.error;
        if (classification === "write" && dispatchStateUncertain) {
          throw new GitHubToolGatewayError(
            "github_write_uncertain",
            "GitHub write dispatch state remains uncertain.",
            { retryable: false, status: 409 }
          );
        }
        if (
          classification === "write" &&
          executionContext.operation.providerDispatchPhase === "pre_send" &&
          failure.error.retryable
        ) {
          let released: Awaited<
            ReturnType<GitHubToolGatewayStore["releaseOperationForRetry"]>
          >;
          try {
            released = await runDatabasePhase(
              (abortSignal) =>
                input.store.releaseOperationForRetry(input.operator, {
                  abortSignal,
                  deadlineAt,
                  error: { ...failure.error, retryable: true },
                  expectedVersion: executionContext.operation.version,
                  id: executionContext.operation.id,
                  providerRequestId: failure.providerRequestId,
                }),
              databasePhaseTimeoutMs
            );
          } catch {
            throw new GitHubToolGatewayError(
              "github_gateway_unavailable",
              "GitHub tool execution is unavailable.",
              { retryable: true, status: 503 }
            );
          }
          if (released.kind === "released") {
            throw new GitHubToolGatewayError(
              failure.error.code,
              failure.error.message,
              {
                retryable: true,
                status: failure.status,
              }
            );
          }
          throw new GitHubToolGatewayError(
            "github_gateway_unavailable",
            "GitHub tool execution is unavailable.",
            { retryable: true, status: 503 }
          );
        }
        let failed: Awaited<
          ReturnType<GitHubToolGatewayStore["failOperation"]>
        >;
        try {
          failed = await runDatabasePhase(
            (abortSignal) =>
              input.store.failOperation(input.operator, {
                abortSignal,
                deadlineAt,
                error: persistedFailure,
                expectedVersion: executionContext.operation.version,
                id: executionContext.operation.id,
                providerRequestId: failure.providerRequestId,
              }),
            databasePhaseTimeoutMs
          );
        } catch {
          throw new GitHubToolGatewayError(
            classification === "write"
              ? "github_write_uncertain"
              : "github_provider_unavailable",
            classification === "write"
              ? "GitHub write outcome remains uncertain."
              : "GitHub provider execution failed.",
            {
              retryable: classification === "read" && failure.error.retryable,
              status: classification === "write" ? 409 : 503,
            }
          );
        }
        if (failed.kind === "failed") {
          return terminalResponse(failed.operation);
        }
        throw new GitHubToolGatewayError(
          persistedFailure.code,
          persistedFailure.message,
          {
            retryable: persistedFailure.retryable,
            status: knownSent ? 409 : failure.status,
          }
        );
      }

      let completed: Awaited<
        ReturnType<GitHubToolGatewayStore["completeOperation"]>
      >;
      const completionRemaining = Math.min(
        deadlineAt - clock().getTime(),
        databasePhaseTimeoutMs
      );
      if (!(completionRemaining > 0)) {
        throw new GitHubToolGatewayError(
          classification === "write"
            ? "github_write_uncertain"
            : "github_read_completion_pending",
          classification === "write"
            ? "GitHub write completion remains pending recovery."
            : "GitHub read completion remains pending recovery.",
          {
            retryable: classification === "read",
            status: classification === "write" ? 409 : 503,
          }
        );
      }
      try {
        completed = await runDatabasePhase(
          (abortSignal) =>
            input.store.completeOperation(input.operator, {
              abortSignal,
              deadlineAt,
              expectedVersion: executionContext.operation.version,
              id: executionContext.operation.id,
              providerRequestId: providerResult.providerRequestId,
              result: providerResult.result,
              resultNodeId: providerResult.resultNodeId,
              resultUrl: providerResult.resultUrl,
            }),
          completionRemaining
        );
      } catch {
        throw new GitHubToolGatewayError(
          classification === "write"
            ? "github_write_uncertain"
            : "github_read_completion_pending",
          classification === "write"
            ? "GitHub write completion remains pending recovery."
            : "GitHub read completion remains pending recovery.",
          {
            retryable: classification === "read",
            status: classification === "write" ? 409 : 503,
          }
        );
      }
      if (completed.kind !== "completed") {
        throw new GitHubToolGatewayError(
          classification === "write"
            ? "github_write_uncertain"
            : "github_read_completion_pending",
          classification === "write"
            ? "GitHub write completion remains pending recovery."
            : "GitHub read completion remains pending recovery.",
          {
            retryable: classification === "read",
            status: classification === "write" ? 409 : 503,
          }
        );
      }
      return terminalResponse(completed.operation);
    },
  };
}

async function readBoundedRequestBody(
  request: Request,
  maximum: number,
  signal: AbortSignal
): Promise<string> {
  signal.throwIfAborted();
  const contentLength = request.headers.get("content-length");
  if (
    contentLength &&
    (!/^[0-9]+$/u.test(contentLength) || Number(contentLength) > maximum)
  ) {
    await cancelRequestBody(request);
    throw new GitHubToolGatewayError(
      "request_too_large",
      "GitHub tool request is too large.",
      { retryable: false, status: 413 }
    );
  }
  if (!request.body) {
    return "";
  }
  const reader = request.body.getReader();
  const decoder = new TextDecoder("utf-8", { fatal: true });
  let body = "";
  let total = 0;
  try {
    while (true) {
      const { done, value } = await withAbort(reader.read(), signal);
      if (done) {
        break;
      }
      total += value.byteLength;
      if (total > maximum) {
        throw new GitHubToolGatewayError(
          "request_too_large",
          "GitHub tool request is too large.",
          { retryable: false, status: 413 }
        );
      }
      try {
        body += decoder.decode(value, { stream: true });
      } catch {
        throw new GitHubToolGatewayError(
          "request_invalid",
          "GitHub tool request is invalid.",
          { retryable: false, status: 400 }
        );
      }
    }
    signal.throwIfAborted();
    try {
      body += decoder.decode();
    } catch {
      throw new GitHubToolGatewayError(
        "request_invalid",
        "GitHub tool request is invalid.",
        { retryable: false, status: 400 }
      );
    }
    return body;
  } catch (error) {
    await boundedCancellation(() => reader.cancel());
    throw error;
  } finally {
    try {
      reader.releaseLock();
    } catch {
      // A provider that never settles cancellation can retain its pending read.
    }
  }
}

async function boundedCancellation(
  cancel: () => Promise<unknown>
): Promise<void> {
  let timer: ReturnType<typeof setTimeout> | undefined;
  const cancellation = Promise.resolve()
    .then(cancel)
    .catch(() => undefined);
  try {
    await Promise.race([
      cancellation,
      new Promise<void>((resolve) => {
        timer = globalThis.setTimeout(resolve, MAX_BODY_CANCELLATION_WAIT_MS);
      }),
    ]);
  } finally {
    if (timer !== undefined) {
      globalThis.clearTimeout(timer);
    }
  }
}

function cancelRequestBody(request: Request): Promise<void> {
  return request.body && !request.body.locked
    ? boundedCancellation(() => request.body?.cancel() ?? Promise.resolve())
    : Promise.resolve();
}

function withAbort<T>(operation: Promise<T>, signal: AbortSignal): Promise<T> {
  if (signal.aborted) {
    return Promise.reject(signal.reason);
  }
  return new Promise<T>((resolve, reject) => {
    const aborted = () => reject(signal.reason);
    signal.addEventListener("abort", aborted, { once: true });
    operation.then(
      (value) => {
        signal.removeEventListener("abort", aborted);
        resolve(value);
      },
      (error: unknown) => {
        signal.removeEventListener("abort", aborted);
        reject(error);
      }
    );
  });
}

function jsonResponse(
  body: unknown,
  status: number,
  additionalHeaders: Readonly<Record<string, string>> = {}
): Response {
  return Response.json(body, {
    headers: {
      "cache-control": "no-store",
      "content-type": "application/json; charset=utf-8",
      ...additionalHeaders,
    },
    status,
  });
}

export function createGitHubToolHttpHandler(
  input: Readonly<{
    bodyDeadlineMs?: number;
    enforceAbuse: (request: AbuseEnforcementInput) => Promise<AbuseAdmission>;
    execute: (
      request: Readonly<{
        operation: GitHubToolOperation;
        operationId: string;
        rawCapability: string;
      }>
    ) => Promise<GitHubToolGatewayResponse>;
  }>
) {
  const bodyDeadlineMs =
    input.bodyDeadlineMs ?? DEFAULT_PRE_DATABASE_DEADLINE_MS;
  if (
    !Number.isSafeInteger(bodyDeadlineMs) ||
    bodyDeadlineMs < 1 ||
    bodyDeadlineMs >= GITHUB_TOOL_SERVER_DEADLINE_MS
  ) {
    throw new Error("GitHub tool pre-database deadline is invalid.");
  }
  return async (
    request: Request,
    ip: string | null = null
  ): Promise<Response> => {
    const controller = new AbortController();
    const timeoutError = new GitHubToolGatewayError(
      "request_timeout",
      "GitHub tool request timed out.",
      { retryable: true, status: 408 }
    );
    const deadlineAt = Date.now() + bodyDeadlineMs;
    let deadlineActive = true;
    const timer = globalThis.setTimeout(() => {
      if (deadlineActive) {
        controller.abort(timeoutError);
      }
    }, bodyDeadlineMs);
    const requestAborted = () => {
      if (deadlineActive) {
        controller.abort(timeoutError);
      }
    };
    request.signal.addEventListener("abort", requestAborted, { once: true });
    if (request.signal.aborted) {
      requestAborted();
    }
    const throwIfPreDatabaseExpired = () => {
      if (
        controller.signal.aborted ||
        request.signal.aborted ||
        Date.now() >= deadlineAt
      ) {
        if (!controller.signal.aborted) {
          controller.abort(timeoutError);
        }
        throw timeoutError;
      }
    };
    const clearDeadline = () => {
      if (!deadlineActive) {
        return;
      }
      deadlineActive = false;
      globalThis.clearTimeout(timer);
      request.signal.removeEventListener("abort", requestAborted);
    };
    try {
      throwIfPreDatabaseExpired();
      if (request.method !== "POST") {
        return jsonResponse(
          {
            error: {
              code: "method_not_allowed",
              message: "Only POST is supported.",
              retryable: false,
            },
          },
          405
        );
      }
      throwIfPreDatabaseExpired();
      const admission = await withAbort(
        input.enforceAbuse({
          failClosed: true,
          ip,
          route: "github_tool",
        }),
        controller.signal
      );
      throwIfPreDatabaseExpired();
      if (admission.kind === "denied") {
        controller.abort();
        return jsonResponse(
          {
            error: {
              code: "rate_limited",
              message: "Too many requests. Try again later.",
              retryable: true,
            },
          },
          admission.responseStatus,
          { "retry-after": String(admission.retryAfterSeconds) }
        );
      }
      if (admission.kind === "unavailable") {
        controller.abort();
        return jsonResponse(
          {
            error: {
              code: "abuse_control_unavailable",
              message: "GitHub tool execution is unavailable.",
              retryable: true,
            },
          },
          admission.responseStatus
        );
      }
      throwIfPreDatabaseExpired();
      const authorization = request.headers.get("authorization");
      const match = /^Bearer ([A-Za-z0-9_-]{43})$/u.exec(authorization ?? "");
      if (!match) {
        throw new GitHubToolGatewayError(
          "github_capability_invalid",
          "GitHub tool capability is invalid or expired.",
          { retryable: false, status: 401 }
        );
      }
      const rawBody = await readBoundedRequestBody(
        request,
        MAX_TOOL_REQUEST_BYTES,
        controller.signal
      );
      throwIfPreDatabaseExpired();
      let untrusted: unknown;
      try {
        untrusted = JSON.parse(rawBody);
      } catch {
        throw new GitHubToolGatewayError(
          "request_invalid",
          "GitHub tool request is invalid.",
          { retryable: false, status: 400 }
        );
      }
      const parsed = githubToolRequestSchema.safeParse(untrusted);
      if (!parsed.success) {
        throw new GitHubToolGatewayError(
          "request_invalid",
          "GitHub tool request is invalid.",
          { retryable: false, status: 400 }
        );
      }
      throwIfPreDatabaseExpired();
      clearDeadline();
      return jsonResponse(
        await input.execute({
          ...parsed.data,
          rawCapability: match[1],
        }),
        200
      );
    } catch (error) {
      const safe =
        error instanceof GitHubToolGatewayError
          ? error
          : new GitHubToolGatewayError(
              "github_gateway_unavailable",
              "GitHub tool execution is unavailable.",
              { retryable: true, status: 503 }
            );
      return jsonResponse(
        {
          error: {
            code: safe.code,
            message: safe.message,
            retryable: safe.retryable,
          },
        },
        safe.status
      );
    } finally {
      clearDeadline();
      if (controller.signal.aborted) {
        await cancelRequestBody(request);
      }
    }
  };
}

export function githubOperationReceipt(
  operation: GitHubGatewayOperationRecord
) {
  return {
    completedAt: operation.completedAt?.toISOString() ?? null,
    id: operation.id,
    kind: operation.kind,
    providerRequestId: operation.providerRequestId,
    requestHash: operation.requestHash,
    resultNodeId: operation.resultNodeId,
    resultUrl: operation.resultUrl,
    status: operation.status,
    stepId: operation.teamStepId,
    target: operation.target,
  };
}
