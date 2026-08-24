import { execFile, spawn } from "node:child_process";
import { promisify } from "node:util";
import { type ProjectItem, parseBeadsJson } from "./beads-project-model";
import type { ReconciliationPlan } from "./beads-project-reconcile";
import { parseManagedBeadId } from "./beads-project-reconcile";

const exec = promisify(execFile);

const MAX_BUFFER = 20 * 1024 * 1024;
const GRAPHQL_ERROR_LIMIT = 5;
const GRAPHQL_MESSAGE_LIMIT = 160;

const EXPECTED_PROJECT_FIELDS = {
  "Bead ID": null,
  Blocked: ["No", "Yes"],
  Priority: ["P0", "P1", "P2"],
  Runner: ["Cloud", "Control plane", "Local", "Shared"],
  Size: ["L", "M", "S", "XL", "XS"],
  Status: ["Done", "In Progress", "In review", "Todo"],
  Type: ["bug", "epic", "feature", "task"],
  Workstream: [
    "Cloud runner",
    "Contracts & harnesses",
    "Data lifecycle",
    "Developer experience",
    "Local runner",
    "Observability",
    "Product",
    "Releases & docs",
    "Security & privacy",
    "Testing & reliability",
  ],
} as const satisfies Readonly<Record<string, readonly string[] | null>>;

const PROJECT_SNAPSHOT_QUERY = `
  query BeadsProjectSnapshot($owner: String!, $number: Int!, $after: String) {
    organization(login: $owner) {
      projectV2(number: $number) {
        id
        fields(first: 100) {
          nodes {
            __typename
            ... on ProjectV2Field {
              id
              name
              dataType
            }
            ... on ProjectV2SingleSelectField {
              id
              name
              options {
                id
                name
              }
            }
          }
          pageInfo {
            hasNextPage
            endCursor
          }
        }
        items(first: 100, after: $after) {
          nodes {
            id
            content {
              __typename
              ... on DraftIssue {
                id
                title
                body
              }
              ... on Issue {
                id
                title
                body
              }
              ... on PullRequest {
                id
                title
                body
              }
            }
            fieldValues(first: 100) {
              nodes {
                __typename
                ... on ProjectV2ItemFieldTextValue {
                  text
                  field {
                    __typename
                    ... on ProjectV2Field {
                      name
                    }
                    ... on ProjectV2SingleSelectField {
                      name
                    }
                  }
                }
                ... on ProjectV2ItemFieldSingleSelectValue {
                  name
                  field {
                    __typename
                    ... on ProjectV2Field {
                      name
                    }
                    ... on ProjectV2SingleSelectField {
                      name
                    }
                  }
                }
              }
              pageInfo {
                hasNextPage
                endCursor
              }
            }
          }
          pageInfo {
            hasNextPage
            endCursor
          }
        }
      }
    }
    rateLimit {
      cost
      remaining
      resetAt
    }
  }
`;

export const MIN_GRAPHQL_REMAINING = 100;
export const CREATE_BATCH_SIZE = 20;
export const MUTATION_OPERATION_LIMIT = 40;
export const MAX_GRAPHQL_CONCURRENCY = 2;

export type CommandRunner = (
  command: string,
  args: string[]
) => Promise<string>;

export type InputCommandRunner = (
  command: string,
  args: string[],
  input: string
) => Promise<string>;

export type GraphqlVariables = Record<string, unknown>;

export type RateLimitSnapshot = {
  cost: number;
  remaining: number;
  resetAt: string;
};

export type GraphqlResponse<TData = unknown> = {
  data?: TData | null;
  errors?: unknown[];
  rateLimit?: RateLimitSnapshot;
};

export type GraphqlRunner = (
  query: string,
  variables: GraphqlVariables
) => Promise<GraphqlResponse>;

export type ProjectField = {
  dataType?: string;
  id: string;
  options: Record<string, string>;
  type: "ProjectV2Field" | "ProjectV2SingleSelectField";
};

export type ProjectSnapshot = {
  fields: Record<string, ProjectField>;
  items: ProjectItem[];
  projectId: string;
  rateLimit: RateLimitSnapshot;
};

export type ReconciliationMutationStats = {
  contentUpdateCount: number;
  createCount: number;
  createRequests: number;
  fieldUpdateCount: number;
  totalMutationOperations: number;
  totalMutationRequests: number;
  updateRequests: number;
};

type SnapshotQueryData = {
  organization?: {
    projectV2?: {
      fields?: {
        nodes?: unknown[];
        pageInfo?: {
          endCursor?: string | null;
          hasNextPage?: boolean;
        };
      };
      id?: string;
      items?: {
        nodes?: unknown[];
        pageInfo?: {
          endCursor?: string | null;
          hasNextPage?: boolean;
        };
      };
    } | null;
  } | null;
  rateLimit?: RateLimitSnapshot;
};

type DraftMutationInput = {
  body: string;
  projectId: string;
  title: string;
};

type DraftIssueUpdateInput = {
  body: string;
  draftIssueId: string;
  title: string;
};

type FieldMutationInput = {
  fieldId: string;
  itemId: string;
  projectId: string;
  value: {
    singleSelectOptionId?: string;
    text?: string;
  };
};

type CreateAction = Extract<
  ReconciliationPlan["actions"][number],
  { kind: "create" }
>;

type MutationAliasReference = {
  alias: string;
  beadId: string;
  fieldName: string;
  kind: "content" | "create" | "field";
};

type GraphqlMutationBatch = {
  aliases: MutationAliasReference[];
  query: string;
  variables: GraphqlVariables;
};

type CreateMutationBatch = GraphqlMutationBatch & {
  actions: CreateAction[];
};

type MutationOperation =
  | {
      beadId: string;
      fieldName: string;
      input: DraftIssueUpdateInput;
      kind: "content";
    }
  | {
      beadId: string;
      fieldName: string;
      input: FieldMutationInput;
      kind: "field";
    };

type MutationBatch = GraphqlMutationBatch & {
  operations: MutationOperation[];
};

type MutationBatchOutcome = {
  data: Record<string, unknown>;
  failures: MutationAliasReference[];
  rateLimit: RateLimitSnapshot;
  successes: MutationAliasReference[];
  unscopedErrorCount: number;
};

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null;
}

function readRecord(value: unknown, label: string): Record<string, unknown> {
  if (!isRecord(value)) {
    throw new Error(`${label} must be an object`);
  }

  return value;
}

function readString(value: unknown, label: string): string {
  if (typeof value !== "string") {
    throw new Error(`${label} must be a string`);
  }

  return value;
}

function readOptionalString(value: unknown): string | undefined {
  return typeof value === "string" ? value : undefined;
}

function readBoolean(value: unknown, label: string): boolean {
  if (typeof value !== "boolean") {
    throw new Error(`${label} must be a boolean`);
  }

  return value;
}

function readArray(value: unknown, label: string): unknown[] {
  if (!Array.isArray(value)) {
    throw new Error(`${label} must be an array`);
  }

  return value;
}

function compareStrings(left: string, right: string): number {
  return left.localeCompare(right);
}

function compareOperations(
  left: MutationOperation,
  right: MutationOperation
): number {
  return (
    compareStrings(left.beadId, right.beadId) ||
    compareStrings(left.fieldName, right.fieldName) ||
    compareStrings(left.kind, right.kind)
  );
}

function chunk<T>(values: readonly T[], size: number): T[][] {
  const chunks: T[][] = [];

  for (let index = 0; index < values.length; index += size) {
    chunks.push(values.slice(index, index + size));
  }

  return chunks;
}

function optionNames(options: Record<string, string>): string[] {
  return Object.keys(options).sort(compareStrings);
}

function sameOptions(
  left: readonly string[],
  right: readonly string[]
): boolean {
  return (
    JSON.stringify([...left].sort(compareStrings)) ===
    JSON.stringify([...right].sort(compareStrings))
  );
}

function createProcessError(
  command: string,
  category: string,
  error: unknown
): Error {
  const code =
    isRecord(error) && "code" in error ? String(error.code) : "unknown";

  return new Error(`${command} ${category} failed with exit code ${code}`);
}

function execCommandWithInput(
  command: string,
  args: string[],
  input: string,
  category: string
): Promise<string> {
  return new Promise((resolve, reject) => {
    const child = spawn(command, args, {
      stdio: ["pipe", "pipe", "pipe"],
    });
    const stdoutChunks: Buffer[] = [];
    let stdoutSize = 0;
    let stderrSize = 0;
    let settled = false;

    const finish = (error?: Error, stdout = ""): void => {
      if (settled) {
        return;
      }

      settled = true;

      if (error) {
        reject(error);
        return;
      }

      resolve(stdout);
    };

    const failForSize = (): void => {
      child.kill();
      finish(new Error(`${command} ${category} failed: output too large`));
    };

    child.on("error", (error) => {
      finish(createProcessError(command, category, error));
    });
    child.stdout.on("data", (dataChunk: Buffer) => {
      stdoutSize += dataChunk.length;

      if (stdoutSize > MAX_BUFFER) {
        failForSize();
        return;
      }

      stdoutChunks.push(dataChunk);
    });
    child.stderr.on("data", (dataChunk: Buffer) => {
      stderrSize += dataChunk.length;

      if (stderrSize > MAX_BUFFER) {
        failForSize();
      }
    });
    child.stdin.on("error", (error) => {
      finish(createProcessError(command, category, error));
    });
    child.on("close", (code) => {
      if (code !== 0) {
        finish(createProcessError(command, category, { code }));
        return;
      }

      finish(undefined, Buffer.concat(stdoutChunks).toString("utf8"));
    });
    child.stdin.end(input);
  });
}

function parseHeaderRateLimit(output: string): {
  body: string;
  rateLimit?: RateLimitSnapshot;
} {
  const separatorMatch = output.match(/\r?\n\r?\n/);

  if (!separatorMatch) {
    return { body: output };
  }

  const separatorIndex = separatorMatch.index ?? 0;
  const body = output.slice(separatorIndex + separatorMatch[0].length);
  const headers = output
    .slice(0, separatorIndex)
    .split(/\r?\n/)
    .filter((line) => line.includes(":"))
    .map((line) => {
      const colonIndex = line.indexOf(":");

      return [
        line.slice(0, colonIndex).trim().toLowerCase(),
        line.slice(colonIndex + 1).trim(),
      ] as const;
    });
  const headerMap = new Map(headers);
  const remainingRaw = headerMap.get("x-ratelimit-remaining");
  const resetRaw = headerMap.get("x-ratelimit-reset");

  if (remainingRaw === undefined || resetRaw === undefined) {
    return { body };
  }

  const remaining = Number.parseInt(remainingRaw, 10);
  const reset = Number.parseInt(resetRaw, 10);

  if (!Number.isFinite(remaining) || !Number.isFinite(reset)) {
    return { body };
  }

  return {
    body,
    rateLimit: {
      cost: 0,
      remaining,
      resetAt: new Date(reset * 1000).toISOString(),
    },
  };
}

function extractPayloadRateLimit(
  payload: GraphqlResponse<unknown>
): RateLimitSnapshot | undefined {
  if (payload.rateLimit !== undefined) {
    return payload.rateLimit;
  }

  if (!isRecord(payload.data) || !("rateLimit" in payload.data)) {
    return undefined;
  }

  const { rateLimit } = payload.data;

  if (!isRecord(rateLimit)) {
    return undefined;
  }

  const { cost, remaining, resetAt } = rateLimit;

  if (
    typeof cost !== "number" ||
    typeof remaining !== "number" ||
    typeof resetAt !== "string"
  ) {
    return undefined;
  }

  return { cost, remaining, resetAt };
}

function sanitizeGraphqlType(error: Record<string, unknown>): string {
  const raw =
    (isRecord(error.extensions) && "code" in error.extensions
      ? error.extensions.code
      : undefined) ??
    error.type ??
    "GRAPHQL_ERROR";
  const text = String(raw).replace(/[^A-Za-z0-9_.-]/g, "");

  return text === "" ? "GRAPHQL_ERROR" : text;
}

function sanitizeMutationIdentifier(value: string): string {
  const normalized = value
    .replace(/[^A-Za-z0-9_.-]+/g, "-")
    .replace(/^-+|-+$/g, "");

  return normalized === "" ? "unknown" : normalized;
}

function collectVariableStrings(
  value: unknown,
  strings: Set<string> = new Set<string>()
): Set<string> {
  if (typeof value === "string" && value !== "") {
    strings.add(value);
    return strings;
  }

  if (Array.isArray(value)) {
    for (const entry of value) {
      collectVariableStrings(entry, strings);
    }
    return strings;
  }

  if (isRecord(value)) {
    for (const entry of Object.values(value)) {
      collectVariableStrings(entry, strings);
    }
  }

  return strings;
}

function sanitizeGraphqlMessage(
  message: unknown,
  variables: GraphqlVariables
): string {
  const redacted = [...collectVariableStrings(variables)]
    .sort((left, right) => right.length - left.length)
    .reduce(
      (current, value) => current.split(value).join("[redacted]"),
      String(message ?? "Unknown GraphQL error")
    );
  const normalized = redacted
    .replace(/\s+/g, " ")
    .trim()
    .replace(/"[^"]*"/g, '"[redacted]"')
    .replace(/'[^']*'/g, "'[redacted]'")
    .replace(/\b(?:github_pat_|gh[pousr]_)[A-Za-z0-9_]+\b/gi, "[redacted]")
    .replace(/\bsk-[A-Za-z0-9_-]+\b/gi, "[redacted]");

  return normalized.slice(0, GRAPHQL_MESSAGE_LIMIT);
}

function formatGraphqlErrors(
  rawErrors: readonly unknown[],
  variables: GraphqlVariables
): string {
  const errors = rawErrors
    .slice(0, GRAPHQL_ERROR_LIMIT)
    .map((error) => {
      const record = readRecord(error, "GraphQL error");
      return `${sanitizeGraphqlType(record)}: ${sanitizeGraphqlMessage(
        record.message,
        variables
      )}`;
    })
    .join("; ");
  const suffix =
    rawErrors.length > GRAPHQL_ERROR_LIMIT
      ? `; +${rawErrors.length - GRAPHQL_ERROR_LIMIT} more`
      : "";

  return `${errors}${suffix}`;
}

function createGraphqlErrorsError(
  rawErrors: readonly unknown[],
  variables: GraphqlVariables
): Error {
  return new Error(
    `GitHub GraphQL errors: ${formatGraphqlErrors(rawErrors, variables)}`
  );
}

function readGraphqlErrorAlias(error: unknown): string | undefined {
  if (!isRecord(error) || !Array.isArray(error.path)) {
    return undefined;
  }

  const [pathSegment] = error.path;

  return typeof pathSegment === "string" ? pathSegment : undefined;
}

function describeMutationAlias(reference: MutationAliasReference): string {
  const alias = sanitizeMutationIdentifier(reference.alias);
  const beadId = sanitizeMutationIdentifier(reference.beadId);

  if (reference.kind === "field") {
    return `${alias}=${beadId}#${sanitizeMutationIdentifier(
      reference.fieldName
    )}`;
  }

  return `${alias}=${beadId}`;
}

function formatMutationAliasSummary(
  references: readonly MutationAliasReference[]
): string {
  if (references.length === 0) {
    return "0";
  }

  const entries = references
    .slice(0, GRAPHQL_ERROR_LIMIT)
    .map(describeMutationAlias)
    .join(", ");
  const suffix =
    references.length > GRAPHQL_ERROR_LIMIT
      ? `, +${references.length - GRAPHQL_ERROR_LIMIT} more`
      : "";

  return `${references.length} [${entries}${suffix}]`;
}

// Successful mutations are already durable on GitHub. Recovery is a rerun with
// a fresh snapshot; we intentionally do not attempt rollback or delete.
function createPartialMutationFailureError(
  stage: "create" | "update",
  successes: readonly MutationAliasReference[],
  failures: readonly MutationAliasReference[],
  unscopedErrorCount: number
): Error {
  const unscopedSuffix =
    unscopedErrorCount > 0 ? `; unscopedErrors=${unscopedErrorCount}` : "";

  return new Error(
    `GitHub GraphQL partial mutation failure during ${stage} stage: succeeded=${formatMutationAliasSummary(
      successes
    )}; failed=${formatMutationAliasSummary(
      failures
    )}${unscopedSuffix}; rerun is idempotent recovery; no rollback/delete was attempted`
  );
}

function createMutationExecutionError(
  stage: "create" | "update",
  error: Error,
  successes: readonly MutationAliasReference[]
): Error {
  if (successes.length === 0) {
    return error;
  }

  return new Error(
    `${error.message}; successfulAliases=${formatMutationAliasSummary(
      successes
    )}; rerun is idempotent recovery; no rollback/delete was attempted during ${stage} stage`
  );
}

function selectMostConservativeRateLimit(
  snapshots: readonly RateLimitSnapshot[]
): RateLimitSnapshot {
  return snapshots.reduce((current, snapshot) => {
    if (snapshot.remaining < current.remaining) {
      return snapshot;
    }

    if (
      snapshot.remaining === current.remaining &&
      snapshot.resetAt > current.resetAt
    ) {
      return snapshot;
    }

    return current;
  });
}

function assertMutationBudget(
  rateLimit: RateLimitSnapshot,
  estimatedCost: number
): void {
  if (rateLimit.remaining < MIN_GRAPHQL_REMAINING) {
    throw new Error(
      `GitHub GraphQL mutation budget low: remaining=${rateLimit.remaining} resetAt=${rateLimit.resetAt}`
    );
  }

  if (rateLimit.remaining - estimatedCost < MIN_GRAPHQL_REMAINING) {
    throw new Error(
      `GitHub GraphQL mutation budget insufficient: remaining=${rateLimit.remaining} estimatedCost=${estimatedCost} minRemaining=${MIN_GRAPHQL_REMAINING} resetAt=${rateLimit.resetAt}`
    );
  }
}

function estimateMutationGroupCost(
  batches: readonly GraphqlMutationBatch[]
): number {
  return batches.reduce((total, batch) => total + batch.aliases.length, 0);
}

function validateGraphqlPayload<TData>(
  payload: GraphqlResponse<TData>,
  variables: GraphqlVariables = {}
): {
  data: TData;
  rateLimit: RateLimitSnapshot;
} {
  const rateLimit = extractPayloadRateLimit(payload);

  if (rateLimit === undefined) {
    throw new Error("GitHub GraphQL response missing rateLimit");
  }

  const rawErrors = payload.errors ?? [];

  if (rawErrors.length > 0) {
    throw createGraphqlErrorsError(rawErrors, variables);
  }

  if (payload.data === undefined || payload.data === null) {
    throw new Error("GitHub GraphQL response missing data");
  }

  return {
    data: payload.data,
    rateLimit,
  };
}

function readPageInfo(
  value: unknown,
  label: string
): {
  endCursor?: string | null;
  hasNextPage: boolean;
} {
  const pageInfo = readRecord(value, label);

  return {
    endCursor:
      pageInfo.endCursor === null
        ? null
        : readOptionalString(pageInfo.endCursor),
    hasNextPage: readBoolean(pageInfo.hasNextPage, `${label}.hasNextPage`),
  };
}

function mapProjectFields(nodes: unknown[]): Record<string, ProjectField> {
  const fields: Record<string, ProjectField> = {};

  for (const node of nodes) {
    const record = readRecord(node, "Project field");
    const typeName = readString(record.__typename, "Project field.__typename");

    if (typeName === "ProjectV2Field") {
      const name = readString(record.name, "Project field.name");

      fields[name] = {
        dataType: readOptionalString(record.dataType),
        id: readString(record.id, "Project field.id"),
        options: {},
        type: "ProjectV2Field",
      };
      continue;
    }

    if (typeName === "ProjectV2SingleSelectField") {
      const name = readString(record.name, "Project field.name");
      const options = readArray(record.options, "Project field.options");

      fields[name] = {
        id: readString(record.id, "Project field.id"),
        options: Object.fromEntries(
          options.map((option) => {
            const optionRecord = readRecord(option, "Project field option");

            return [
              readString(optionRecord.name, "Project field option.name"),
              readString(optionRecord.id, "Project field option.id"),
            ];
          })
        ),
        type: "ProjectV2SingleSelectField",
      };
    }
  }

  return fields;
}

function readFieldName(field: unknown): string | undefined {
  if (!isRecord(field)) {
    return undefined;
  }

  return readOptionalString(field.name);
}

function mapItemFields(fieldValues: unknown[]): Record<string, string> {
  const fields: Record<string, string> = {};

  for (const node of fieldValues) {
    const record = readRecord(node, "Project item field value");
    const typeName = readString(
      record.__typename,
      "Project item field value.__typename"
    );
    const fieldName = readFieldName(record.field);

    if (!fieldName) {
      continue;
    }

    if (typeName === "ProjectV2ItemFieldTextValue") {
      const text = readOptionalString(record.text);

      if (text !== undefined) {
        fields[fieldName] = text;
      }
      continue;
    }

    if (typeName === "ProjectV2ItemFieldSingleSelectValue") {
      const optionName = readOptionalString(record.name);

      if (optionName !== undefined) {
        fields[fieldName] = optionName;
      }
    }
  }

  return fields;
}

function mapProjectItem(node: unknown): ProjectItem {
  const record = readRecord(node, "Project item");
  const contentRecord = isRecord(record.content) ? record.content : {};
  const contentType =
    readOptionalString(contentRecord.__typename) ??
    readOptionalString(contentRecord.type) ??
    "Unknown";
  const fieldValuesConnection = readRecord(
    record.fieldValues,
    "Project item.fieldValues"
  );
  const fieldValuesPageInfo = readPageInfo(
    fieldValuesConnection.pageInfo,
    "Project item.fieldValues.pageInfo"
  );

  if (fieldValuesPageInfo.hasNextPage) {
    throw new Error(
      `Project item fieldValues pagination is not supported: ${readString(record.id, "Project item.id")}`
    );
  }

  const item: ProjectItem = {
    content: {
      body: readOptionalString(contentRecord.body) ?? "",
      id: readOptionalString(contentRecord.id),
      title: readOptionalString(contentRecord.title) ?? "",
      type: contentType,
    },
    fields: mapItemFields(
      readArray(fieldValuesConnection.nodes, "Project item.fieldValues.nodes")
    ),
    id: readString(record.id, "Project item.id"),
  };

  if (item.content.type === "DraftIssue" && item.content.id === undefined) {
    throw new Error(
      `DraftIssue content id missing for Project item ${item.id}`
    );
  }

  const managedBeadId = parseManagedBeadId(item.content.body);

  if (
    item.content.type !== "DraftIssue" &&
    (managedBeadId !== null || item.fields["Bead ID"] !== undefined)
  ) {
    throw new Error(
      `managed Project item must remain a DraftIssue: ${item.id}`
    );
  }

  return item;
}

function buildProjectSnapshotPage(
  data: SnapshotQueryData,
  owner: string,
  projectNumber: number
): {
  fields: Record<string, ProjectField>;
  items: ProjectItem[];
  pageInfo: {
    endCursor?: string | null;
    hasNextPage: boolean;
  };
  projectId: string;
} {
  const organization = readRecord(data.organization, `organization ${owner}`);
  const project = readRecord(
    organization.projectV2,
    `Project ${owner}#${projectNumber}`
  );
  const fieldsConnection = readRecord(project.fields, "Project fields");
  const fieldPageInfo = readPageInfo(
    fieldsConnection.pageInfo,
    "Project fields.pageInfo"
  );

  if (fieldPageInfo.hasNextPage) {
    throw new Error("Project fields pagination is not supported");
  }

  const itemsConnection = readRecord(project.items, "Project items");

  return {
    fields: mapProjectFields(
      readArray(fieldsConnection.nodes, "Project fields.nodes")
    ),
    items: readArray(itemsConnection.nodes, "Project items.nodes").map(
      mapProjectItem
    ),
    pageInfo: readPageInfo(itemsConnection.pageInfo, "Project items.pageInfo"),
    projectId: readString(project.id, "Project id"),
  };
}

function fieldInputForValue(
  project: ProjectSnapshot,
  fieldName: string,
  itemId: string,
  value: string
): FieldMutationInput {
  const field = project.fields[fieldName];

  if (field === undefined) {
    throw new Error(`missing Project field: ${fieldName}`);
  }

  if (field.type === "ProjectV2Field") {
    return {
      fieldId: field.id,
      itemId,
      projectId: project.projectId,
      value: { text: value },
    };
  }

  const optionId = field.options[value];

  if (optionId === undefined) {
    throw new Error(`missing option ${value} for Project field ${fieldName}`);
  }

  return {
    fieldId: field.id,
    itemId,
    projectId: project.projectId,
    value: { singleSelectOptionId: optionId },
  };
}

function buildCreateBatches(
  actions: CreateAction[],
  project: ProjectSnapshot
): CreateMutationBatch[] {
  const sorted = [...actions].sort((left, right) =>
    compareStrings(left.desired.beadId, right.desired.beadId)
  );

  return chunk(sorted, CREATE_BATCH_SIZE).map((group) => {
    const aliases: MutationAliasReference[] = [];
    const variables: GraphqlVariables = {};
    const declarations: string[] = [];
    const selections: string[] = [];

    group.forEach((action, index) => {
      const alias = `create_${String(index).padStart(3, "0")}`;
      aliases.push({
        alias,
        beadId: action.desired.beadId,
        fieldName: "",
        kind: "create",
      });

      declarations.push(`$${alias}: AddProjectV2DraftIssueInput!`);
      selections.push(
        `${alias}: addProjectV2DraftIssue(input: $${alias}) { projectItem { id content { __typename ... on DraftIssue { id title body } } } }`
      );
      variables[alias] = {
        body: action.desired.body,
        projectId: project.projectId,
        title: action.desired.title,
      } satisfies DraftMutationInput;
    });

    return {
      actions: group,
      aliases,
      query: `mutation BeadsProjectCreate(${declarations.join(
        ", "
      )}) { ${selections.join(" ")} }`,
      variables,
    };
  });
}

function buildMutationBatches(
  operations: MutationOperation[]
): MutationBatch[] {
  const sorted = [...operations].sort(compareOperations);

  return chunk(sorted, MUTATION_OPERATION_LIMIT).map((group) => {
    const aliases: MutationAliasReference[] = [];
    const variables: GraphqlVariables = {};
    const declarations: string[] = [];
    const selections: string[] = [];

    group.forEach((operation, index) => {
      const alias = `${operation.kind}_${String(index).padStart(3, "0")}`;
      aliases.push({
        alias,
        beadId: operation.beadId,
        fieldName: operation.fieldName,
        kind: operation.kind,
      });

      if (operation.kind === "content") {
        declarations.push(`$${alias}: UpdateProjectV2DraftIssueInput!`);
        selections.push(
          `${alias}: updateProjectV2DraftIssue(input: $${alias}) { draftIssue { id } }`
        );
        variables[alias] = operation.input;
        return;
      }

      declarations.push(`$${alias}: UpdateProjectV2ItemFieldValueInput!`);
      selections.push(
        `${alias}: updateProjectV2ItemFieldValue(input: $${alias}) { projectV2Item { id } }`
      );
      variables[alias] = operation.input;
    });

    return {
      aliases,
      operations: group,
      query: `mutation BeadsProjectMutate(${declarations.join(
        ", "
      )}) { ${selections.join(" ")} }`,
      variables,
    };
  });
}

function inspectMutationPayload(
  payload: GraphqlResponse<Record<string, unknown>>,
  batch: GraphqlMutationBatch
): MutationBatchOutcome {
  const rateLimit = extractPayloadRateLimit(payload);

  if (rateLimit === undefined) {
    throw new Error("GitHub GraphQL response missing rateLimit");
  }

  const rawErrors = payload.errors ?? [];
  const data: Record<string, unknown> =
    payload.data === undefined || payload.data === null
      ? {}
      : readRecord(payload.data, "GraphQL mutation data");
  const knownAliases = new Set(
    batch.aliases.map((reference) => reference.alias)
  );
  const failedAliases = new Set<string>();
  let unscopedErrorCount = 0;

  for (const error of rawErrors) {
    const alias = readGraphqlErrorAlias(error);

    if (alias !== undefined && knownAliases.has(alias)) {
      failedAliases.add(alias);
      continue;
    }

    unscopedErrorCount += 1;
  }

  const successes: MutationAliasReference[] = [];
  const failures: MutationAliasReference[] = [];

  for (const reference of batch.aliases) {
    const aliasData = data[reference.alias];

    if (rawErrors.length === 0 && aliasData !== null) {
      successes.push(reference);
      continue;
    }

    if (
      aliasData !== undefined &&
      aliasData !== null &&
      !failedAliases.has(reference.alias)
    ) {
      successes.push(reference);
      continue;
    }

    failures.push(reference);
  }

  if (
    rawErrors.length > 0 &&
    failedAliases.size === 0 &&
    successes.length === 0
  ) {
    throw createGraphqlErrorsError(rawErrors, batch.variables);
  }

  return {
    data,
    failures,
    rateLimit,
    successes,
    unscopedErrorCount,
  };
}

function executeMutationBatches<TBatch extends GraphqlMutationBatch>(
  stage: "create" | "update",
  batches: readonly TBatch[],
  graphql: GraphqlRunner,
  project: ProjectSnapshot
): Promise<{ data: Record<string, unknown>; rateLimit: RateLimitSnapshot }[]> {
  async function runGroup(
    batchIndex: number,
    results: {
      data: Record<string, unknown>;
      rateLimit: RateLimitSnapshot;
      successes: MutationAliasReference[];
    }[]
  ): Promise<
    {
      data: Record<string, unknown>;
      rateLimit: RateLimitSnapshot;
      successes: MutationAliasReference[];
    }[]
  > {
    if (batchIndex >= batches.length) {
      return results;
    }

    const group = batches.slice(
      batchIndex,
      batchIndex + MAX_GRAPHQL_CONCURRENCY
    );
    assertMutationBudget(project.rateLimit, estimateMutationGroupCost(group));

    const responses = await Promise.allSettled(
      group.map(
        async (batch) =>
          (await graphql(batch.query, batch.variables)) as GraphqlResponse<
            Record<string, unknown>
          >
      )
    );
    const executionErrors: Error[] = [];
    const groupResults: MutationBatchOutcome[] = [];

    responses.forEach((response, index) => {
      const batch = group[index];

      if (batch === undefined) {
        executionErrors.push(
          new Error("GraphQL mutation batch metadata missing")
        );
        return;
      }

      if (response.status === "rejected") {
        executionErrors.push(
          response.reason instanceof Error
            ? response.reason
            : new Error(String(response.reason))
        );
        return;
      }

      try {
        groupResults.push(inspectMutationPayload(response.value, batch));
      } catch (error) {
        executionErrors.push(
          error instanceof Error ? error : new Error(String(error))
        );
      }
    });

    if (groupResults.length > 0) {
      project.rateLimit = selectMostConservativeRateLimit(
        groupResults.map((result) => result.rateLimit)
      );
    }

    if (
      groupResults.some(
        (result) => result.failures.length > 0 || result.unscopedErrorCount > 0
      )
    ) {
      throw createPartialMutationFailureError(
        stage,
        [
          ...results.flatMap((result) => result.successes),
          ...groupResults.flatMap((result) => result.successes),
        ],
        groupResults.flatMap((result) => result.failures),
        groupResults.reduce(
          (total, result) => total + result.unscopedErrorCount,
          0
        )
      );
    }

    if (executionErrors.length > 0) {
      throw createMutationExecutionError(stage, executionErrors[0], [
        ...results.flatMap((result) => result.successes),
        ...groupResults.flatMap((result) => result.successes),
      ]);
    }

    results.push(
      ...groupResults.map((result) => ({
        data: result.data,
        rateLimit: result.rateLimit,
        successes: result.successes,
      }))
    );

    return runGroup(batchIndex + MAX_GRAPHQL_CONCURRENCY, results);
  }

  return runGroup(0, []).then((results) =>
    results.map(({ data, rateLimit }) => ({ data, rateLimit }))
  );
}

function collectCreatedItems(
  batches: readonly CreateMutationBatch[],
  responses: readonly { data: Record<string, unknown> }[]
): Map<string, { draftIssueId: string; itemId: string }> {
  const created = new Map<string, { draftIssueId: string; itemId: string }>();

  batches.forEach((batch, batchIndex) => {
    batch.aliases.forEach((reference, actionIndex) => {
      const action = batch.actions[actionIndex];

      if (action === undefined) {
        throw new Error(
          `create mutation metadata missing for ${reference.alias}`
        );
      }

      const payload = readRecord(
        responses[batchIndex]?.data[reference.alias],
        `create mutation ${reference.alias}`
      );
      const projectItem = readRecord(
        payload.projectItem,
        `${reference.alias}.projectItem`
      );
      const content = readRecord(
        projectItem.content,
        `${reference.alias}.projectItem.content`
      );
      const typeName = readString(
        content.__typename,
        `${reference.alias}.content.__typename`
      );

      if (typeName !== "DraftIssue") {
        throw new Error(
          `Created Project item is not a DraftIssue: ${action.desired.beadId}`
        );
      }

      created.set(action.desired.beadId, {
        draftIssueId: readString(content.id, `${reference.alias}.content.id`),
        itemId: readString(projectItem.id, `${reference.alias}.projectItem.id`),
      });
    });
  });

  return created;
}

function validateDesiredFields(
  plan: ReconciliationPlan,
  project: ProjectSnapshot
): Map<string, string> {
  validateProjectSchema(project);

  const contentIds = new Map<string, string>();
  const itemsById = new Map(project.items.map((item) => [item.id, item]));

  for (const action of plan.actions) {
    for (const [fieldName, value] of Object.entries(action.desired.fields).sort(
      ([left], [right]) => compareStrings(left, right)
    )) {
      const field = project.fields[fieldName];

      if (field === undefined) {
        throw new Error(`missing Project field: ${fieldName}`);
      }

      if (
        field.type === "ProjectV2SingleSelectField" &&
        field.options[value] === undefined
      ) {
        throw new Error(
          `missing option ${value} for Project field ${fieldName}`
        );
      }
    }

    if (action.kind === "update" && action.contentChanged) {
      const item = itemsById.get(action.itemId);

      if (
        item?.content.type !== "DraftIssue" ||
        item.content.id === undefined
      ) {
        throw new Error(
          `DraftIssue content id unavailable for Project item ${action.itemId}`
        );
      }

      contentIds.set(action.itemId, item.content.id);
    }
  }

  return contentIds;
}

function buildPostCreateOperations(
  plan: ReconciliationPlan,
  project: ProjectSnapshot,
  createdItems: ReadonlyMap<string, { draftIssueId: string; itemId: string }>,
  contentIds: ReadonlyMap<string, string>
): MutationOperation[] {
  const operations: MutationOperation[] = [];

  for (const action of plan.actions) {
    if (action.kind === "create") {
      const created = createdItems.get(action.desired.beadId);

      if (created === undefined) {
        throw new Error(
          `Created Project item missing for ${action.desired.beadId}`
        );
      }

      for (const fieldName of Object.keys(action.desired.fields).sort(
        compareStrings
      )) {
        operations.push({
          beadId: action.desired.beadId,
          fieldName,
          input: fieldInputForValue(
            project,
            fieldName,
            created.itemId,
            action.desired.fields[fieldName] ?? ""
          ),
          kind: "field",
        });
      }

      continue;
    }

    if (action.contentChanged) {
      operations.push({
        beadId: action.desired.beadId,
        fieldName: "",
        input: {
          body: action.desired.body,
          draftIssueId: contentIds.get(action.itemId) ?? "",
          title: action.desired.title,
        },
        kind: "content",
      });
    }

    for (const fieldName of [...action.changedFields].sort(compareStrings)) {
      operations.push({
        beadId: action.desired.beadId,
        fieldName,
        input: fieldInputForValue(
          project,
          fieldName,
          action.itemId,
          action.desired.fields[fieldName] ?? ""
        ),
        kind: "field",
      });
    }
  }

  return operations.sort(compareOperations);
}

export const runCommand: CommandRunner = async (command, args) => {
  try {
    const { stdout } = await exec(command, args, {
      maxBuffer: MAX_BUFFER,
    });

    return stdout;
  } catch (error) {
    throw createProcessError(command, "command", error);
  }
};

export const runInputCommand: InputCommandRunner = async (
  command,
  args,
  input
) => execCommandWithInput(command, args, input, "command");

export const runGraphql: GraphqlRunner = async (query, variables) => {
  const payload = JSON.stringify({ query, variables });
  const output = await execCommandWithInput(
    "gh",
    ["api", "graphql", "--include", "--input", "-"],
    payload,
    "graphql"
  );
  const parsedOutput = parseHeaderRateLimit(output);
  const parsed = JSON.parse(parsedOutput.body) as GraphqlResponse;

  return {
    ...parsed,
    rateLimit: extractPayloadRateLimit(parsed) ?? parsedOutput.rateLimit,
  };
};

export function validateProjectSchema(project: ProjectSnapshot): void {
  for (const [fieldName, expectedOptions] of Object.entries(
    EXPECTED_PROJECT_FIELDS
  )) {
    const field = project.fields[fieldName];

    if (field === undefined) {
      throw new Error(`missing Project field: ${fieldName}`);
    }

    if (expectedOptions === null) {
      if (field.type !== "ProjectV2Field" || field.dataType !== "TEXT") {
        throw new Error(`Project field ${fieldName} must be a text field`);
      }
      continue;
    }

    if (field.type !== "ProjectV2SingleSelectField") {
      throw new Error(`Project field ${fieldName} must be single-select`);
    }

    if (!sameOptions(optionNames(field.options), expectedOptions)) {
      throw new Error(`Project field ${fieldName} has incorrect options`);
    }
  }
}

export async function loadBeads(
  directory: string,
  run: CommandRunner = runCommand
) {
  const output = await run("bd", [
    "-C",
    directory,
    "--readonly",
    "list",
    "--all",
    "--limit",
    "0",
    "--json",
  ]);

  return parseBeadsJson(output);
}

export async function loadDependencyCycles(
  directory: string,
  run: CommandRunner = runCommand
): Promise<unknown[]> {
  const output = await run("bd", [
    "-C",
    directory,
    "--readonly",
    "dep",
    "cycles",
    "--json",
  ]);
  const parsed = JSON.parse(output);

  if (!Array.isArray(parsed)) {
    throw new Error("Beads dependency cycles response must be an array");
  }

  return parsed;
}

export function loadProject(
  owner: string,
  projectNumber: number,
  graphql: GraphqlRunner = runGraphql
): Promise<ProjectSnapshot> {
  async function loadSnapshotPage(
    after?: string | null
  ): Promise<ProjectSnapshot> {
    const payload = (await graphql(PROJECT_SNAPSHOT_QUERY, {
      after,
      number: projectNumber,
      owner,
    })) as GraphqlResponse<SnapshotQueryData>;
    const validated = validateGraphqlPayload(payload, {
      after,
      number: projectNumber,
      owner,
    });
    const page = buildProjectSnapshotPage(validated.data, owner, projectNumber);
    const { fields, items, pageInfo, projectId } = page;

    if (!pageInfo.hasNextPage) {
      return {
        fields,
        items,
        projectId,
        rateLimit: validated.rateLimit,
      };
    }

    if (pageInfo.endCursor === undefined || pageInfo.endCursor === null) {
      throw new Error("Project items pageInfo missing endCursor");
    }

    const nextPage = await loadSnapshotPage(pageInfo.endCursor);

    return {
      fields,
      items: [...items, ...nextPage.items],
      projectId,
      rateLimit: nextPage.rateLimit,
    };
  }

  return loadSnapshotPage();
}

export async function applyReconciliation(
  plan: ReconciliationPlan,
  project: ProjectSnapshot,
  graphql: GraphqlRunner = runGraphql
): Promise<ReconciliationMutationStats> {
  const baseStats: ReconciliationMutationStats = {
    contentUpdateCount: 0,
    createCount: 0,
    createRequests: 0,
    fieldUpdateCount: 0,
    totalMutationOperations: 0,
    totalMutationRequests: 0,
    updateRequests: 0,
  };

  if (plan.actions.length === 0) {
    validateProjectSchema(project);
    return baseStats;
  }

  const contentIds = validateDesiredFields(plan, project);
  const createActions = plan.actions.filter(
    (action) => action.kind === "create"
  );
  const createBatches = buildCreateBatches(createActions, project);
  const createResponses = await executeMutationBatches(
    "create",
    createBatches,
    graphql,
    project
  );
  const createdItems = collectCreatedItems(createBatches, createResponses);
  const operations = buildPostCreateOperations(
    plan,
    project,
    createdItems,
    contentIds
  );
  const mutationBatches = buildMutationBatches(operations);

  await executeMutationBatches("update", mutationBatches, graphql, project);

  const createCount = createActions.length;
  const contentUpdateCount = plan.actions.filter(
    (action) => action.kind === "update" && action.contentChanged
  ).length;
  const fieldUpdateCount = operations.filter(
    (operation) => operation.kind === "field"
  ).length;

  return {
    contentUpdateCount,
    createCount,
    createRequests: createBatches.length,
    fieldUpdateCount,
    totalMutationOperations: createCount + operations.length,
    totalMutationRequests: createBatches.length + mutationBatches.length,
    updateRequests: mutationBatches.length,
  };
}
