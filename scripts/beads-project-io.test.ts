import assert from "node:assert/strict";
import test from "node:test";
import {
  applyReconciliation,
  type CommandRunner,
  CREATE_BATCH_SIZE,
  type GraphqlRunner,
  loadBeads,
  loadDependencyCycles,
  loadProject,
  MAX_GRAPHQL_CONCURRENCY,
  MIN_GRAPHQL_REMAINING,
  MUTATION_OPERATION_LIMIT,
  type ProjectField,
  type ProjectSnapshot,
  runCommand,
  runInputCommand,
  validateProjectSchema,
} from "./beads-project-io";
import { MARKER_PREFIX } from "./beads-project-policy";
import type { ReconciliationPlan } from "./beads-project-reconcile";

const BASE_RATE_LIMIT = {
  cost: 1,
  remaining: 5000,
  resetAt: "2026-08-24T16:00:00Z",
};

type GraphqlCall = {
  query: string;
  variables: Record<string, unknown>;
};

function resolved<T>(value: T): Promise<T> {
  return Promise.resolve(value);
}

function managedBody(beadId: string, body = "Body"): string {
  return `${MARKER_PREFIX}${beadId} -->\n\n${body}`;
}

function makeProjectFields(
  overrides: Partial<Record<string, ProjectField>> = {}
): Record<string, ProjectField> {
  return {
    "Bead ID": {
      dataType: "TEXT",
      id: "field-bead-id",
      options: {},
      type: "ProjectV2Field",
    },
    "Bead Type": {
      id: "field-bead-type",
      options: {
        bug: "type-bug",
        epic: "type-epic",
        feature: "type-feature",
        task: "type-task",
      },
      type: "ProjectV2SingleSelectField",
    },
    Blocked: {
      id: "field-blocked",
      options: {
        No: "blocked-no",
        Yes: "blocked-yes",
      },
      type: "ProjectV2SingleSelectField",
    },
    Owner: {
      id: "field-owner",
      options: {
        BunsDev: "owner-bunsdev",
        Copilot: "owner-copilot",
        Joint: "owner-joint",
      },
      type: "ProjectV2SingleSelectField",
    },
    Priority: {
      id: "field-priority",
      options: {
        P0: "priority-p0",
        P1: "priority-p1",
        P2: "priority-p2",
      },
      type: "ProjectV2SingleSelectField",
    },
    Runner: {
      id: "field-runner",
      options: {
        Cloud: "runner-cloud",
        "Control plane": "runner-control-plane",
        Local: "runner-local",
        Shared: "runner-shared",
      },
      type: "ProjectV2SingleSelectField",
    },
    Size: {
      id: "field-size",
      options: {
        L: "size-l",
        M: "size-m",
        S: "size-s",
        XL: "size-xl",
        XS: "size-xs",
      },
      type: "ProjectV2SingleSelectField",
    },
    Status: {
      id: "field-status",
      options: {
        Done: "status-done",
        "In Progress": "status-in-progress",
        "In review": "status-in-review",
        Todo: "status-todo",
      },
      type: "ProjectV2SingleSelectField",
    },
    Wave: {
      id: "field-wave",
      options: {
        "0 - Delivered": "wave-delivered",
        "1 - Now": "wave-now",
        "2 - Next": "wave-next",
        "3 - Certify": "wave-certify",
        "4 - Platform": "wave-platform",
        "5 - Product data": "wave-product-data",
        "6 - Operations": "wave-operations",
      },
      type: "ProjectV2SingleSelectField",
    },
    Workstream: {
      id: "field-workstream",
      options: {
        "Cloud runner": "workstream-cloud-runner",
        "Contracts & harnesses": "workstream-contracts-harnesses",
        "Data lifecycle": "workstream-data-lifecycle",
        "Developer experience": "workstream-developer-experience",
        "Local runner": "workstream-local-runner",
        Observability: "workstream-observability",
        Product: "workstream-product",
        "Releases & docs": "workstream-releases-docs",
        "Security & privacy": "workstream-security-privacy",
        "Testing & reliability": "workstream-testing-reliability",
      },
      type: "ProjectV2SingleSelectField",
    },
    ...overrides,
  };
}

function draftItem(
  beadId: string,
  index: number,
  fields: Record<string, string> = {}
): ProjectSnapshot["items"][number] {
  return {
    content: {
      body: managedBody(beadId),
      id: `DI_${index}`,
      title: `Title ${index}`,
      type: "DraftIssue",
    },
    fields,
    id: `PVTI_${index}`,
  };
}

function makeProjectSnapshot(
  overrides: Partial<ProjectSnapshot> = {}
): ProjectSnapshot {
  return {
    fields: makeProjectFields(),
    items: [],
    projectId: "PVT_project",
    rateLimit: BASE_RATE_LIMIT,
    ...overrides,
  };
}

function fieldNode(name: string, field: ProjectField): Record<string, unknown> {
  if (field.type === "ProjectV2Field") {
    return {
      __typename: "ProjectV2Field",
      dataType: field.dataType ?? "TEXT",
      id: field.id,
      name,
    };
  }

  return {
    __typename: "ProjectV2SingleSelectField",
    id: field.id,
    name,
    options: Object.entries(field.options).map(([optionName, optionId]) => ({
      id: optionId,
      name: optionName,
    })),
  };
}

function fieldValueNodes(
  fields: Record<string, string>,
  projectFields: Record<string, ProjectField>
): Record<string, unknown>[] {
  return Object.entries(fields).map(([fieldName, value]) => {
    const field = projectFields[fieldName];
    assert.ok(field, `Missing field fixture: ${fieldName}`);

    if (field.type === "ProjectV2Field") {
      return {
        __typename: "ProjectV2ItemFieldTextValue",
        field: {
          __typename: "ProjectV2Field",
          name: fieldName,
        },
        text: value,
      };
    }

    return {
      __typename: "ProjectV2ItemFieldSingleSelectValue",
      field: {
        __typename: "ProjectV2SingleSelectField",
        name: fieldName,
      },
      name: value,
    };
  });
}

function queryResponse(options: {
  endCursor?: string | null;
  extraFieldNodes?: Record<string, unknown>[];
  extraValueNodes?: Record<string, unknown>[][];
  fieldValuePageInfos?: Array<{
    endCursor?: string | null;
    hasNextPage?: boolean;
  }>;
  fields?: Record<string, ProjectField>;
  hasNextPage?: boolean;
  items?: ProjectSnapshot["items"];
  projectId?: string;
  rateLimit?: typeof BASE_RATE_LIMIT;
}) {
  const {
    endCursor = null,
    extraFieldNodes = [],
    extraValueNodes = [],
    fieldValuePageInfos = [],
    fields = makeProjectFields(),
    hasNextPage = false,
    items = [],
    projectId = "PVT_project",
    rateLimit = BASE_RATE_LIMIT,
  } = options;

  return {
    data: {
      organization: {
        projectV2: {
          fields: {
            nodes: [
              ...Object.entries(fields).map(([name, field]) =>
                fieldNode(name, field)
              ),
              ...extraFieldNodes,
            ],
            pageInfo: {
              endCursor: null,
              hasNextPage: false,
            },
          },
          id: projectId,
          items: {
            nodes: items.map((item, index) => ({
              content: {
                __typename: item.content.type,
                body: item.content.body,
                id: item.content.id,
                title: item.content.title,
              },
              fieldValues: {
                nodes: [
                  ...fieldValueNodes(item.fields, fields),
                  ...(extraValueNodes[index] ?? []),
                ],
                pageInfo: {
                  endCursor: fieldValuePageInfos[index]?.endCursor ?? null,
                  hasNextPage: fieldValuePageInfos[index]?.hasNextPage ?? false,
                },
              },
              id: item.id,
            })),
            pageInfo: {
              endCursor,
              hasNextPage,
            },
          },
        },
      },
      rateLimit,
    },
  };
}

function mutationResponse(
  data: Record<string, unknown> = {},
  options: {
    errors?: unknown[];
    rateLimit?: typeof BASE_RATE_LIMIT;
  } = {}
) {
  const { errors, rateLimit = BASE_RATE_LIMIT } = options;

  return {
    data,
    ...(errors === undefined ? {} : { errors }),
    rateLimit,
  };
}

function createMutationResponse(
  query: string,
  rateLimit: typeof BASE_RATE_LIMIT = BASE_RATE_LIMIT
) {
  const data: Record<string, unknown> = {};
  let index = 0;

  for (const match of query.matchAll(/(\w+):\s+addProjectV2DraftIssue\(/g)) {
    data[match[1]] = {
      projectItem: {
        content: {
          __typename: "DraftIssue",
          body: `Created body ${index}`,
          id: `created-draft-${index}`,
          title: `Created title ${index}`,
        },
        id: `created-item-${index}`,
      },
    };
    index += 1;
  }

  return mutationResponse(data, { rateLimit });
}

function countOperations(query: string, name: string): number {
  return [...query.matchAll(new RegExp(`${name}\\(`, "g"))].length;
}

function createAction(
  beadId: string,
  fields: Record<string, string> = {
    Status: "Todo",
  }
): ReconciliationPlan["actions"][number] {
  return {
    desired: {
      beadId,
      body: managedBody(beadId),
      fields,
      title: `Title ${beadId}`,
    },
    kind: "create",
  };
}

function updateAction(options: {
  beadId: string;
  changedFields: string[];
  contentChanged?: boolean;
  fields: Record<string, string>;
  itemId?: string;
}): ReconciliationPlan["actions"][number] {
  const { beadId, changedFields, contentChanged = false, fields } = options;

  return {
    changedFields,
    contentChanged,
    desired: {
      beadId,
      body: managedBody(beadId, `Body ${beadId}`),
      fields,
      title: `Title ${beadId}`,
    },
    itemId: options.itemId ?? `item-${beadId}`,
    kind: "update",
  };
}

function collectMutationInputItemIds(
  variables: Record<string, unknown>
): readonly string[] {
  return Object.values(variables)
    .filter(
      (value): value is { itemId: string } =>
        typeof value === "object" &&
        value !== null &&
        "itemId" in value &&
        typeof value.itemId === "string"
    )
    .map((value) => value.itemId)
    .sort();
}

test("loads every bead in read-only mode", async () => {
  const calls: { command: string; args: string[] }[] = [];
  const run: CommandRunner = (command, args) => {
    calls.push({ args, command });
    return resolved("[]");
  };

  await loadBeads("/private/workspace", run);

  assert.deepEqual(calls, [
    {
      args: [
        "-C",
        "/private/workspace",
        "--readonly",
        "list",
        "--all",
        "--limit",
        "0",
        "--json",
      ],
      command: "bd",
    },
  ]);
});

test("loads dependency cycles without mutating Beads", async () => {
  const calls: { command: string; args: string[] }[] = [];
  const run: CommandRunner = (command, args) => {
    calls.push({ args, command });
    return resolved("[]");
  };

  assert.deepEqual(await loadDependencyCycles("/private/workspace", run), []);
  assert.deepEqual(calls, [
    {
      args: [
        "-C",
        "/private/workspace",
        "--readonly",
        "dep",
        "cycles",
        "--json",
      ],
      command: "bd",
    },
  ]);
});

test("the default runner does not echo command arguments on failure", async () => {
  await assert.rejects(
    () =>
      runCommand("false", [
        "private acceptance text",
        "github_pat_1234567890abcdefghijklmnopqrstuvwxyz",
      ]),
    (error: unknown) => {
      assert.ok(error instanceof Error);
      assert.match(error.message, /^false command failed /);
      assert.doesNotMatch(error.message, /private acceptance text/);
      assert.doesNotMatch(error.message, /github_pat_/);
      return true;
    }
  );
});

test("the stdin runner does not echo arguments or input on failure", async () => {
  await assert.rejects(
    () =>
      runInputCommand(
        "false",
        [
          "private roadmap title",
          "github_pat_1234567890abcdefghijklmnopqrstuvwxyz",
        ],
        [
          "Private acceptance text",
          "/Users/test/Secret Folder/private roadmap.json",
        ].join("\n")
      ),
    (error: unknown) => {
      assert.ok(error instanceof Error);
      assert.match(error.message, /^false command failed /);
      assert.doesNotMatch(error.message, /private roadmap title/i);
      assert.doesNotMatch(error.message, /Private acceptance text/);
      assert.doesNotMatch(error.message, /github_pat_/);
      assert.doesNotMatch(error.message, /Secret Folder|private roadmap\.json/);
      return true;
    }
  );
});

test("loads a one-page project snapshot in one GraphQL call", async () => {
  const calls: GraphqlCall[] = [];
  const fields = makeProjectFields();
  const run: GraphqlRunner = (query, variables) => {
    calls.push({ query, variables });
    return resolved(
      queryResponse({
        extraFieldNodes: [
          {
            __typename: "ProjectV2IterationField",
            id: "field-iteration",
            name: "Sprint",
          },
        ],
        fields,
        items: [
          draftItem("coven-agents-security.1", 1, {
            "Bead ID": "coven-agents-security.1",
            "Bead Type": "feature",
            Runner: "Shared",
            Status: "Todo",
            Workstream: "Security & privacy",
          }),
        ],
        rateLimit: {
          cost: 7,
          remaining: 1234,
          resetAt: "2026-08-24T17:00:00Z",
        },
      })
    );
  };

  const project = await loadProject("OpenCoven", 10, run);

  assert.equal(calls.length, 1);
  assert.match(calls[0]?.query ?? "", /items\(first: 100, after: \$after\)/);
  assert.match(calls[0]?.query ?? "", /fieldValues\(first: 100\)/);
  assert.equal(project.projectId, "PVT_project");
  assert.equal(project.rateLimit.cost, 7);
  assert.equal(project.rateLimit.remaining, 1234);
  assert.equal(project.fields.Status?.options.Todo, "status-todo");
  assert.equal(project.items[0]?.content.id, "DI_1");
  assert.equal(project.items[0]?.content.type, "DraftIssue");
  assert.equal(project.items[0]?.fields["Bead ID"], "coven-agents-security.1");
  assert.equal(project.items[0]?.fields["Bead Type"], "feature");
  assert.equal(project.items[0]?.fields.Workstream, "Security & privacy");
  assert.equal(project.fields.Sprint, undefined);
});

test("paginates project snapshots with exactly one call per page", async () => {
  const calls: GraphqlCall[] = [];
  const run: GraphqlRunner = (query, variables) => {
    calls.push({ query, variables });
    if (variables.after === "cursor-1") {
      return resolved(
        queryResponse({
          items: [
            draftItem("coven-agents-b", 2, {
              "Bead ID": "coven-agents-b",
            }),
          ],
        })
      );
    }

    return resolved(
      queryResponse({
        endCursor: "cursor-1",
        hasNextPage: true,
        items: [
          draftItem("coven-agents-a", 1, {
            "Bead ID": "coven-agents-a",
          }),
        ],
      })
    );
  };

  const project = await loadProject("OpenCoven", 10, run);

  assert.equal(calls.length, 2);
  assert.equal(calls[1]?.variables.after, "cursor-1");
  assert.deepEqual(
    project.items.map((item) => item.fields["Bead ID"]),
    ["coven-agents-a", "coven-agents-b"]
  );
});

test("fails closed when a project item fieldValues connection is truncated", async () => {
  const run: GraphqlRunner = () =>
    resolved(
      queryResponse({
        fieldValuePageInfos: [
          {
            endCursor: "cursor-field-1",
            hasNextPage: true,
          },
        ],
        items: [
          draftItem("coven-agents-field-values", 1, {
            "Bead ID": "coven-agents-field-values",
          }),
        ],
      })
    );

  await assert.rejects(
    () => loadProject("OpenCoven", 10, run),
    /fieldValues pagination is not supported/
  );
});

test("rejects non-draft managed content in the snapshot", async () => {
  const run: GraphqlRunner = () =>
    resolved(
      queryResponse({
        items: [
          {
            content: {
              body: managedBody("coven-agents-managed"),
              title: "Managed issue",
              type: "Issue",
            },
            fields: {
              "Bead ID": "coven-agents-managed",
            },
            id: "PVTI_issue",
          },
        ],
      })
    );

  await assert.rejects(
    () => loadProject("OpenCoven", 10, run),
    /managed Project item must remain a DraftIssue/
  );
});

test("ignores unrelated built-in fields during schema validation", () => {
  const project = makeProjectSnapshot({
    fields: {
      ...makeProjectFields(),
      Legacy: {
        dataType: "TEXT",
        id: "field-legacy",
        options: {},
        type: "ProjectV2Field",
      },
    },
  });

  assert.doesNotThrow(() => validateProjectSchema(project));
});

test("fails schema and desired option validation before any mutation", async () => {
  const calls: GraphqlCall[] = [];
  const run: GraphqlRunner = (query, variables) => {
    calls.push({ query, variables });
    return resolved(mutationResponse());
  };
  const plan: ReconciliationPlan = {
    actions: [createAction("coven-agents-schema")],
    orphaned: [],
    unchanged: 0,
    unmanaged: 0,
  };

  await assert.rejects(
    () =>
      applyReconciliation(
        plan,
        makeProjectSnapshot({
          fields: {
            Status: makeProjectFields().Status,
          } as ProjectSnapshot["fields"],
        }),
        run
      ),
    /Bead ID/
  );
  await assert.rejects(
    () =>
      applyReconciliation(
        {
          ...plan,
          actions: [
            createAction("coven-agents-option", {
              Runner: "Moon",
            }),
          ],
        },
        makeProjectSnapshot(),
        run
      ),
    /missing option Moon for Project field Runner/
  );
  assert.equal(calls.length, 0);
});

test("fails content updates without a DraftIssue content id before mutation", async () => {
  const calls: GraphqlCall[] = [];
  const run: GraphqlRunner = (query, variables) => {
    calls.push({ query, variables });
    return resolved(mutationResponse());
  };

  await assert.rejects(
    () =>
      applyReconciliation(
        {
          actions: [
            updateAction({
              beadId: "coven-agents-missing-draft-id",
              changedFields: [],
              contentChanged: true,
              fields: {},
              itemId: "PVTI_missing",
            }),
          ],
          orphaned: [],
          unchanged: 0,
          unmanaged: 0,
        },
        makeProjectSnapshot({
          items: [
            {
              content: {
                body: managedBody("coven-agents-missing-draft-id"),
                title: "Missing draft id",
                type: "DraftIssue",
              },
              fields: {},
              id: "PVTI_missing",
            },
          ],
        }),
        run
      ),
    /DraftIssue content id/
  );
  assert.equal(calls.length, 0);
});

test("fails safely before mutations when the remaining GraphQL budget is too low", async () => {
  const privateBody = "private acceptance text";
  const token = "github_pat_1234567890abcdefghijklmnopqrstuvwxyz";
  const calls: GraphqlCall[] = [];
  const run: GraphqlRunner = (query, variables) => {
    calls.push({ query, variables });
    return resolved(mutationResponse());
  };

  await assert.rejects(
    () =>
      applyReconciliation(
        {
          actions: [
            {
              desired: {
                beadId: "coven-agents-rate-limit",
                body: `${privateBody} ${token}`,
                fields: {},
                title: "Private title",
              },
              kind: "create",
            },
          ],
          orphaned: [],
          unchanged: 0,
          unmanaged: 0,
        },
        makeProjectSnapshot({
          rateLimit: {
            cost: 12,
            remaining: MIN_GRAPHQL_REMAINING - 1,
            resetAt: "2026-08-24T18:00:00Z",
          },
        }),
        run
      ),
    (error: unknown) => {
      assert.ok(error instanceof Error);
      assert.match(error.message, /remaining/i);
      assert.match(error.message, /2026-08-24T18:00:00Z/);
      assert.doesNotMatch(error.message, /private acceptance text/);
      assert.doesNotMatch(error.message, /github_pat_/);
      return true;
    }
  );
  assert.equal(calls.length, 0);
});

test("fails safely when GitHub GraphQL returns errors", async () => {
  const privateBody = "private acceptance text";
  const token = "github_pat_1234567890abcdefghijklmnopqrstuvwxyz";
  const run: GraphqlRunner = () =>
    resolved({
      data: {},
      errors: [
        {
          message: `Rejected "${privateBody}" ${token}`,
          type: "FORBIDDEN",
        },
      ],
      rateLimit: BASE_RATE_LIMIT,
    });

  await assert.rejects(
    () =>
      applyReconciliation(
        {
          actions: [
            {
              desired: {
                beadId: "coven-agents-graphql-error",
                body: `${privateBody} ${token}`,
                fields: {},
                title: "Private title",
              },
              kind: "create",
            },
          ],
          orphaned: [],
          unchanged: 0,
          unmanaged: 0,
        },
        makeProjectSnapshot(),
        run
      ),
    (error: unknown) => {
      assert.ok(error instanceof Error);
      assert.match(error.message, /FORBIDDEN/);
      assert.doesNotMatch(error.message, /private acceptance text/);
      assert.doesNotMatch(error.message, /github_pat_/);
      return true;
    }
  );
});

test("stops before the next mutation group when the remaining budget reaches the threshold", async () => {
  const calls: GraphqlCall[] = [];
  const actions = Array.from(
    { length: MUTATION_OPERATION_LIMIT * MAX_GRAPHQL_CONCURRENCY + 1 },
    (_, index) =>
      updateAction({
        beadId: `coven-agents-budget-${String(index).padStart(3, "0")}`,
        changedFields: ["Status"],
        fields: {
          Status: "Todo",
        },
        itemId: `PVTI_budget_${index}`,
      })
  );
  const items = actions.map((action, index) =>
    draftItem(action.desired.beadId, index, {
      Status: "In Progress",
    })
  );
  const run: GraphqlRunner = (query, variables) => {
    calls.push({ query, variables });
    return resolved(
      mutationResponse(
        {},
        {
          rateLimit: {
            cost: MUTATION_OPERATION_LIMIT,
            remaining: MIN_GRAPHQL_REMAINING,
            resetAt: "2026-08-24T18:30:00Z",
          },
        }
      )
    );
  };

  await assert.rejects(
    () =>
      applyReconciliation(
        {
          actions,
          orphaned: [],
          unchanged: 0,
          unmanaged: 0,
        },
        makeProjectSnapshot({
          items,
          rateLimit: {
            cost: 7,
            remaining:
              MIN_GRAPHQL_REMAINING +
              MUTATION_OPERATION_LIMIT * MAX_GRAPHQL_CONCURRENCY,
            resetAt: "2026-08-24T18:30:00Z",
          },
        }),
        run
      ),
    (error: unknown) => {
      assert.ok(error instanceof Error);
      assert.match(error.message, /estimatedCost=1/);
      assert.match(error.message, /remaining=100/);
      assert.match(error.message, /2026-08-24T18:30:00Z/);
      return true;
    }
  );

  assert.equal(calls.length, MAX_GRAPHQL_CONCURRENCY);
  assert.equal(
    countOperations(calls[0]?.query ?? "", "updateProjectV2ItemFieldValue"),
    MUTATION_OPERATION_LIMIT
  );
  assert.equal(
    countOperations(calls[1]?.query ?? "", "updateProjectV2ItemFieldValue"),
    MUTATION_OPERATION_LIMIT
  );
});

test("reports mixed create success and error as rerun-only recovery", async () => {
  const calls: GraphqlCall[] = [];
  const privateBody = "private acceptance text";
  const token = "github_pat_1234567890abcdefghijklmnopqrstuvwxyz";
  const plan: ReconciliationPlan = {
    actions: [
      {
        desired: {
          beadId: "coven-agents-create-alpha",
          body: managedBody(
            "coven-agents-create-alpha",
            `${privateBody} ${token}`
          ),
          fields: {},
          title: "Private title alpha",
        },
        kind: "create",
      },
      {
        desired: {
          beadId: "coven-agents-create-bravo",
          body: managedBody(
            "coven-agents-create-bravo",
            `${privateBody} ${token}`
          ),
          fields: {},
          title: "Private title bravo",
        },
        kind: "create",
      },
    ],
    orphaned: [],
    unchanged: 0,
    unmanaged: 0,
  };
  const run: GraphqlRunner = (query, variables) => {
    calls.push({ query, variables });
    assert.match(query, /addProjectV2DraftIssue/);

    return resolved(
      mutationResponse(
        {
          create_000: {
            projectItem: {
              content: {
                __typename: "DraftIssue",
                body: "Created body 0",
                id: "created-draft-0",
                title: "Created title 0",
              },
              id: "created-item-0",
            },
          },
          create_001: null,
        },
        {
          errors: [
            {
              message: `Rejected "${privateBody}" ${token}`,
              path: ["create_001"],
              type: "FORBIDDEN",
            },
          ],
        }
      )
    );
  };

  await assert.rejects(
    () => applyReconciliation(plan, makeProjectSnapshot(), run),
    (error: unknown) => {
      assert.ok(error instanceof Error);
      assert.match(error.message, /partial mutation failure/i);
      assert.match(error.message, /create stage/i);
      assert.match(error.message, /create_000=coven-agents-create-alpha/);
      assert.match(error.message, /create_001=coven-agents-create-bravo/);
      assert.match(error.message, /rerun is idempotent recovery/i);
      assert.match(error.message, /no rollback\/delete/i);
      assert.doesNotMatch(error.message, /private acceptance text/);
      assert.doesNotMatch(error.message, /github_pat_/);
      assert.doesNotMatch(error.message, /Private title/);
      return true;
    }
  );

  assert.equal(calls.length, 1);
});

test("reports mixed content and field update results without leaking sensitive content", async () => {
  const calls: GraphqlCall[] = [];
  const privateBody = "private acceptance text";
  const token = "github_pat_1234567890abcdefghijklmnopqrstuvwxyz";
  const action: ReconciliationPlan["actions"][number] = {
    changedFields: ["Runner"],
    contentChanged: true,
    desired: {
      beadId: "coven-agents-update-partial",
      body: managedBody(
        "coven-agents-update-partial",
        `${privateBody} ${token}`
      ),
      fields: {
        Runner: "Shared",
      },
      title: "Private title update",
    },
    itemId: "PVTI_update_partial",
    kind: "update",
  };
  const run: GraphqlRunner = (query, variables) => {
    calls.push({ query, variables });

    return resolved(
      mutationResponse(
        {
          content_000: {
            draftIssue: {
              id: "DI_update_partial",
            },
          },
          field_001: null,
        },
        {
          errors: [
            {
              message: `Rejected "${privateBody}" ${token}`,
              path: ["field_001"],
              type: "FORBIDDEN",
            },
          ],
        }
      )
    );
  };

  await assert.rejects(
    () =>
      applyReconciliation(
        {
          actions: [action],
          orphaned: [],
          unchanged: 0,
          unmanaged: 0,
        },
        makeProjectSnapshot({
          items: [
            {
              content: {
                body: managedBody("coven-agents-update-partial", "Old body"),
                id: "DI_update_partial",
                title: "Old title",
                type: "DraftIssue",
              },
              fields: {
                Runner: "Local",
              },
              id: "PVTI_update_partial",
            },
          ],
        }),
        run
      ),
    (error: unknown) => {
      assert.ok(error instanceof Error);
      assert.match(error.message, /partial mutation failure/i);
      assert.match(error.message, /update stage/i);
      assert.match(error.message, /content_000=coven-agents-update-partial/);
      assert.match(
        error.message,
        /field_001=coven-agents-update-partial#Runner/
      );
      assert.match(error.message, /rerun is idempotent recovery/i);
      assert.match(error.message, /no rollback\/delete/i);
      assert.doesNotMatch(error.message, /private acceptance text/);
      assert.doesNotMatch(error.message, /github_pat_/);
      assert.doesNotMatch(error.message, /Private title/);
      return true;
    }
  );

  assert.equal(calls.length, 1);
});

test("splits 41 field operations into two mutation requests", async () => {
  const calls: GraphqlCall[] = [];
  const actions = Array.from({ length: MUTATION_OPERATION_LIMIT + 1 }, (_, i) =>
    updateAction({
      beadId: `coven-agents-field-${String(i).padStart(2, "0")}`,
      changedFields: ["Status"],
      fields: {
        Status: "Todo",
      },
      itemId: `PVTI_${i}`,
    })
  );
  const items = actions.map((action, index) =>
    draftItem(action.desired.beadId, index, {
      Status: "In Progress",
    })
  );
  const run: GraphqlRunner = (query, variables) => {
    calls.push({ query, variables });
    return resolved(mutationResponse());
  };

  const stats = await applyReconciliation(
    {
      actions,
      orphaned: [],
      unchanged: 0,
      unmanaged: 0,
    },
    makeProjectSnapshot({ items }),
    run
  );

  assert.equal(calls.length, 2);
  assert.equal(
    countOperations(calls[0]?.query ?? "", "updateProjectV2ItemFieldValue"),
    MUTATION_OPERATION_LIMIT
  );
  assert.equal(
    countOperations(calls[1]?.query ?? "", "updateProjectV2ItemFieldValue"),
    1
  );
  assert.equal(stats.fieldUpdateCount, MUTATION_OPERATION_LIMIT + 1);
  assert.equal(stats.totalMutationRequests, 2);
});

test("batches twenty creates into one request", async () => {
  const calls: GraphqlCall[] = [];
  const run: GraphqlRunner = (query, variables) => {
    calls.push({ query, variables });
    return resolved(createMutationResponse(query));
  };

  const stats = await applyReconciliation(
    {
      actions: Array.from({ length: CREATE_BATCH_SIZE }, (_, i) =>
        createAction(`coven-agents-create-${String(i).padStart(2, "0")}`, {})
      ),
      orphaned: [],
      unchanged: 0,
      unmanaged: 0,
    },
    makeProjectSnapshot(),
    run
  );

  assert.equal(calls.length, 1);
  assert.equal(
    countOperations(calls[0]?.query ?? "", "addProjectV2DraftIssue"),
    CREATE_BATCH_SIZE
  );
  assert.equal(stats.createCount, CREATE_BATCH_SIZE);
  assert.equal(stats.createRequests, 1);
});

test("splits the twenty-first create into a second request", async () => {
  const calls: GraphqlCall[] = [];
  const run: GraphqlRunner = (query, variables) => {
    calls.push({ query, variables });
    return resolved(createMutationResponse(query));
  };

  const stats = await applyReconciliation(
    {
      actions: Array.from({ length: CREATE_BATCH_SIZE + 1 }, (_, i) =>
        createAction(`coven-agents-create-${String(i).padStart(2, "0")}`, {})
      ),
      orphaned: [],
      unchanged: 0,
      unmanaged: 0,
    },
    makeProjectSnapshot(),
    run
  );

  assert.equal(calls.length, 2);
  assert.equal(
    countOperations(calls[0]?.query ?? "", "addProjectV2DraftIssue"),
    CREATE_BATCH_SIZE
  );
  assert.equal(
    countOperations(calls[1]?.query ?? "", "addProjectV2DraftIssue"),
    1
  );
  assert.equal(stats.createRequests, 2);
});

test("combines content and field updates for an action into one chunk", async () => {
  const calls: GraphqlCall[] = [];
  const action = updateAction({
    beadId: "coven-agents-update",
    changedFields: ["Status", "Runner"],
    contentChanged: true,
    fields: {
      Runner: "Shared",
      Status: "Todo",
    },
    itemId: "PVTI_update",
  });
  const run: GraphqlRunner = (query, variables) => {
    calls.push({ query, variables });
    return resolved(mutationResponse());
  };

  await applyReconciliation(
    {
      actions: [action],
      orphaned: [],
      unchanged: 0,
      unmanaged: 0,
    },
    makeProjectSnapshot({
      items: [
        {
          content: {
            body: managedBody("coven-agents-update", "Old body"),
            id: "DI_update",
            title: "Old title",
            type: "DraftIssue",
          },
          fields: {
            Runner: "Local",
            Status: "In Progress",
          },
          id: "PVTI_update",
        },
      ],
    }),
    run
  );

  assert.equal(calls.length, 1);
  assert.equal(
    countOperations(calls[0]?.query ?? "", "updateProjectV2DraftIssue"),
    1
  );
  assert.equal(
    countOperations(calls[0]?.query ?? "", "updateProjectV2ItemFieldValue"),
    2
  );
  assert.ok(
    (calls[0]?.query ?? "").indexOf("updateProjectV2DraftIssue(") <
      (calls[0]?.query ?? "").indexOf("updateProjectV2ItemFieldValue(")
  );
});

test("runs the create stage before the field and update stage", async () => {
  const calls: GraphqlCall[] = [];
  const run: GraphqlRunner = (query, variables) => {
    calls.push({ query, variables });
    if (query.includes("addProjectV2DraftIssue")) {
      return resolved(createMutationResponse(query));
    }
    return resolved(mutationResponse());
  };

  await applyReconciliation(
    {
      actions: [
        createAction("coven-agents-create-first", {
          Status: "Todo",
        }),
        updateAction({
          beadId: "coven-agents-existing",
          changedFields: ["Runner"],
          contentChanged: true,
          fields: {
            Runner: "Shared",
          },
          itemId: "PVTI_existing",
        }),
      ],
      orphaned: [],
      unchanged: 0,
      unmanaged: 0,
    },
    makeProjectSnapshot({
      items: [
        {
          content: {
            body: managedBody("coven-agents-existing", "Old body"),
            id: "DI_existing",
            title: "Old title",
            type: "DraftIssue",
          },
          fields: {
            Runner: "Local",
          },
          id: "PVTI_existing",
        },
      ],
    }),
    run
  );

  assert.equal(calls.length, 2);
  assert.match(calls[0]?.query ?? "", /addProjectV2DraftIssue/);
  assert.doesNotMatch(calls[0]?.query ?? "", /updateProjectV2ItemFieldValue/);
  assert.match(calls[1]?.query ?? "", /updateProjectV2DraftIssue/);
  assert.match(calls[1]?.query ?? "", /updateProjectV2ItemFieldValue/);
  assert.deepEqual(collectMutationInputItemIds(calls[1]?.variables ?? {}), [
    "PVTI_existing",
    "created-item-0",
  ]);
});

test("never exceeds two concurrent mutation requests", async () => {
  const deferreds: {
    resolve: (value: ReturnType<typeof mutationResponse>) => void;
  }[] = [];
  let active = 0;
  let maxActive = 0;
  const run: GraphqlRunner = async () => {
    active += 1;
    maxActive = Math.max(maxActive, active);

    return await new Promise((resolve) => {
      deferreds.push({
        resolve: (value) => {
          active -= 1;
          resolve(value);
        },
      });
    });
  };

  const applyPromise = applyReconciliation(
    {
      actions: Array.from(
        { length: MUTATION_OPERATION_LIMIT * MAX_GRAPHQL_CONCURRENCY + 1 },
        (_, i) =>
          updateAction({
            beadId: `coven-agents-concurrency-${String(i).padStart(3, "0")}`,
            changedFields: ["Status"],
            fields: {
              Status: "Todo",
            },
            itemId: `PVTI_concurrency_${i}`,
          })
      ),
      orphaned: [],
      unchanged: 0,
      unmanaged: 0,
    },
    makeProjectSnapshot({
      items: Array.from(
        { length: MUTATION_OPERATION_LIMIT * MAX_GRAPHQL_CONCURRENCY + 1 },
        (_, i) =>
          draftItem(
            `coven-agents-concurrency-${String(i).padStart(3, "0")}`,
            i,
            {
              Status: "In Progress",
            }
          )
      ),
    }),
    run
  );

  await Promise.resolve();
  await Promise.resolve();

  assert.equal(active, MAX_GRAPHQL_CONCURRENCY);

  deferreds.shift()?.resolve(mutationResponse());
  deferreds.shift()?.resolve(mutationResponse());

  await new Promise((resolve) => setImmediate(resolve));

  assert.equal(active, 1);

  deferreds.shift()?.resolve(mutationResponse());

  await applyPromise;

  assert.equal(maxActive, MAX_GRAPHQL_CONCURRENCY);
});

test("generates deterministic aliases and variables regardless of input order", async () => {
  const firstCalls: GraphqlCall[] = [];
  const secondCalls: GraphqlCall[] = [];
  const project = makeProjectSnapshot({
    items: [
      {
        content: {
          body: managedBody("coven-agents-alpha", "Old alpha"),
          id: "DI_alpha",
          title: "Old alpha",
          type: "DraftIssue",
        },
        fields: {
          Runner: "Local",
          Status: "In Progress",
        },
        id: "PVTI_alpha",
      },
      {
        content: {
          body: managedBody("coven-agents-zulu", "Old zulu"),
          id: "DI_zulu",
          title: "Old zulu",
          type: "DraftIssue",
        },
        fields: {
          Runner: "Local",
          Status: "In Progress",
        },
        id: "PVTI_zulu",
      },
    ],
  });
  const unorderedPlan: ReconciliationPlan = {
    actions: [
      updateAction({
        beadId: "coven-agents-zulu",
        changedFields: ["Status", "Runner"],
        contentChanged: true,
        fields: {
          Runner: "Shared",
          Status: "Todo",
        },
        itemId: "PVTI_zulu",
      }),
      updateAction({
        beadId: "coven-agents-alpha",
        changedFields: ["Runner", "Status"],
        contentChanged: false,
        fields: {
          Runner: "Shared",
          Status: "Todo",
        },
        itemId: "PVTI_alpha",
      }),
    ],
    orphaned: [],
    unchanged: 0,
    unmanaged: 0,
  };
  const reorderedPlan: ReconciliationPlan = {
    ...unorderedPlan,
    actions: [...unorderedPlan.actions].reverse(),
  };

  await applyReconciliation(unorderedPlan, project, (query, variables) => {
    firstCalls.push({ query, variables });
    return resolved(mutationResponse());
  });
  await applyReconciliation(reorderedPlan, project, (query, variables) => {
    secondCalls.push({ query, variables });
    return resolved(mutationResponse());
  });

  assert.deepEqual(firstCalls, secondCalls);
});

test("returns zero stats and performs no mutations for an empty plan", async () => {
  let called = false;
  const run: GraphqlRunner = () => {
    called = true;
    return resolved(mutationResponse());
  };

  const stats = await applyReconciliation(
    {
      actions: [],
      orphaned: [],
      unchanged: 7,
      unmanaged: 3,
    },
    makeProjectSnapshot(),
    run
  );

  assert.equal(called, false);
  assert.deepEqual(stats, {
    contentUpdateCount: 0,
    createCount: 0,
    createRequests: 0,
    fieldUpdateCount: 0,
    totalMutationOperations: 0,
    totalMutationRequests: 0,
    updateRequests: 0,
  });
});
