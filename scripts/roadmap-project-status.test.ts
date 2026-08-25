import assert from "node:assert/strict";
import test from "node:test";
import type { GraphqlRunner } from "./beads-project-io";
import { PROJECT_STATUSES, WAVES } from "./beads-project-model";
import {
  loadRoadmapProjectItems,
  ROADMAP_STATUS_QUERY,
} from "./roadmap-project-status";
import { BLOCKED_OPTIONS } from "./roadmap-status-model";

type GraphqlCall = {
  query: string;
  variables: Record<string, unknown>;
};

type FieldSchemas = {
  beadIdField: Record<string, unknown> | null;
  blockedField: Record<string, unknown> | null;
  statusField: Record<string, unknown> | null;
  waveField: Record<string, unknown> | null;
};

type ItemValues = {
  beadId: string | null;
  blocked: string | null;
  status: string | null;
  wave: string | null;
};

function singleSelectField(
  options: readonly string[]
): Record<string, unknown> {
  return {
    __typename: "ProjectV2SingleSelectField",
    options: options.map((name) => ({ name })),
  };
}

function fieldSchemas(overrides: Partial<FieldSchemas> = {}): FieldSchemas {
  return {
    beadIdField: {
      __typename: "ProjectV2Field",
      dataType: "TEXT",
    },
    blockedField: singleSelectField(BLOCKED_OPTIONS),
    statusField: singleSelectField(PROJECT_STATUSES),
    waveField: singleSelectField(WAVES),
    ...overrides,
  };
}

function projectItem(
  id: string,
  overrides: Partial<ItemValues> = {}
): Record<string, unknown> {
  const values: ItemValues = {
    beadId: `coven-agents-product.${id}`,
    blocked: "No",
    status: "Todo",
    wave: "1 - Now",
    ...overrides,
  };

  return {
    beadId:
      values.beadId === null
        ? null
        : {
            __typename: "ProjectV2ItemFieldTextValue",
            text: values.beadId,
          },
    blocked:
      values.blocked === null
        ? null
        : {
            __typename: "ProjectV2ItemFieldSingleSelectValue",
            name: values.blocked,
          },
    id: `PVTI_${id}`,
    status:
      values.status === null
        ? null
        : {
            __typename: "ProjectV2ItemFieldSingleSelectValue",
            name: values.status,
          },
    wave:
      values.wave === null
        ? null
        : {
            __typename: "ProjectV2ItemFieldSingleSelectValue",
            name: values.wave,
          },
  };
}

function pageResponse(
  options: {
    endCursor?: string | null;
    fields?: Partial<FieldSchemas>;
    hasNextPage?: boolean;
    nodes?: unknown[];
  } = {}
) {
  const {
    endCursor = null,
    fields = {},
    hasNextPage = false,
    nodes = [],
  } = options;

  return {
    data: {
      organization: {
        projectV2: {
          ...fieldSchemas(fields),
          items: {
            nodes,
            pageInfo: {
              endCursor,
              hasNextPage,
            },
          },
        },
      },
    },
  };
}

test("queries only the four managed fields without private content", () => {
  assert.match(
    ROADMAP_STATUS_QUERY,
    /organization\s*\(\s*login:\s*\$owner\s*\)/
  );
  assert.match(
    ROADMAP_STATUS_QUERY,
    /projectV2\s*\(\s*number:\s*\$number\s*\)/
  );
  assert.match(
    ROADMAP_STATUS_QUERY,
    /beadIdField:\s*field\s*\(\s*name:\s*"Bead ID"\s*\)/
  );
  assert.match(
    ROADMAP_STATUS_QUERY,
    /statusField:\s*field\s*\(\s*name:\s*"Status"\s*\)/
  );
  assert.match(
    ROADMAP_STATUS_QUERY,
    /waveField:\s*field\s*\(\s*name:\s*"Wave"\s*\)/
  );
  assert.match(
    ROADMAP_STATUS_QUERY,
    /blockedField:\s*field\s*\(\s*name:\s*"Blocked"\s*\)/
  );
  assert.match(
    ROADMAP_STATUS_QUERY,
    /items\s*\(\s*first:\s*100\s*,\s*after:\s*\$after\s*\)/
  );
  assert.equal(ROADMAP_STATUS_QUERY.match(/\bfieldValueByName\b/g)?.length, 4);

  for (const prohibited of [
    "content",
    "title",
    "body",
    "description",
    "acceptance",
    "fieldValues",
  ]) {
    assert.doesNotMatch(
      ROADMAP_STATUS_QUERY,
      new RegExp(`\\b${prohibited}\\b`, "i")
    );
  }
});

test("requires exact managed field types and options", async () => {
  const invalidSchemas: Partial<FieldSchemas>[] = [
    {
      beadIdField: {
        __typename: "ProjectV2Field",
        dataType: "NUMBER",
      },
    },
    {
      statusField: singleSelectField(PROJECT_STATUSES.slice(1)),
    },
    {
      waveField: singleSelectField([...WAVES, "7 - Later"]),
    },
    {
      blockedField: {
        __typename: "ProjectV2Field",
        dataType: "TEXT",
      },
    },
  ];

  await Promise.all(
    invalidSchemas.map((fields) => {
      const run: GraphqlRunner = () =>
        Promise.resolve(pageResponse({ fields }));

      return assert.rejects(
        () => loadRoadmapProjectItems("OpenCoven", 17, run),
        /Project field/i
      );
    })
  );
});

test("paginates valid items with stable variables", async () => {
  const calls: GraphqlCall[] = [];
  const run: GraphqlRunner = (query, variables) => {
    calls.push({ query, variables });

    if (variables.after === "cursor-1") {
      return Promise.resolve(
        pageResponse({
          nodes: [
            projectItem("2", {
              blocked: "Yes",
              status: "Done",
              wave: "0 - Delivered",
            }),
          ],
        })
      );
    }

    return Promise.resolve(
      pageResponse({
        endCursor: "cursor-1",
        hasNextPage: true,
        nodes: [
          projectItem("1", {
            status: "In Progress",
          }),
        ],
      })
    );
  };

  const items = await loadRoadmapProjectItems("OpenCoven", 17, run);

  assert.deepEqual(items, [
    {
      beadId: "coven-agents-product.1",
      blocked: "No",
      status: "In Progress",
      wave: "1 - Now",
    },
    {
      beadId: "coven-agents-product.2",
      blocked: "Yes",
      status: "Done",
      wave: "0 - Delivered",
    },
  ]);
  assert.deepEqual(calls, [
    {
      query: ROADMAP_STATUS_QUERY,
      variables: {
        after: null,
        number: 17,
        owner: "OpenCoven",
      },
    },
    {
      query: ROADMAP_STATUS_QUERY,
      variables: {
        after: "cursor-1",
        number: 17,
        owner: "OpenCoven",
      },
    },
  ]);
});

test("validates managed field schemas on every page", async () => {
  const run: GraphqlRunner = (_query, variables) => {
    if (variables.after === "cursor-1") {
      return Promise.resolve(
        pageResponse({
          fields: {
            statusField: singleSelectField(["Todo"]),
          },
        })
      );
    }

    return Promise.resolve(
      pageResponse({
        endCursor: "cursor-1",
        hasNextPage: true,
      })
    );
  };

  await assert.rejects(
    () => loadRoadmapProjectItems("OpenCoven", 17, run),
    /Project field Status/i
  );
});

test("skips a fully empty unmanaged item", async () => {
  const run: GraphqlRunner = () =>
    Promise.resolve(
      pageResponse({
        nodes: [
          projectItem("unmanaged", {
            beadId: null,
            blocked: null,
            status: null,
            wave: null,
          }),
          projectItem("managed"),
        ],
      })
    );

  const items = await loadRoadmapProjectItems("OpenCoven", 17, run);

  assert.deepEqual(items, [
    {
      beadId: "coven-agents-product.managed",
      blocked: "No",
      status: "Todo",
      wave: "1 - Now",
    },
  ]);
});

test("rejects partial unmanaged field data", async () => {
  const run: GraphqlRunner = () =>
    Promise.resolve(
      pageResponse({
        nodes: [
          projectItem("partial-unmanaged", {
            beadId: null,
            blocked: null,
            status: "Todo",
            wave: null,
          }),
        ],
      })
    );

  await assert.rejects(
    () => loadRoadmapProjectItems("OpenCoven", 17, run),
    /partial unmanaged data/i
  );
});

test("rejects a managed item missing a required value", async () => {
  const run: GraphqlRunner = () =>
    Promise.resolve(
      pageResponse({
        nodes: [
          projectItem("partial-managed", {
            blocked: null,
          }),
        ],
      })
    );

  await assert.rejects(
    () => loadRoadmapProjectItems("OpenCoven", 17, run),
    /missing required value/i
  );
});

test("redacts GraphQL error messages and reports only their count", async () => {
  const secret = "private server message github_pat_secret";
  const run: GraphqlRunner = () =>
    Promise.resolve({
      data: {
        malformed: true,
      },
      errors: [{ message: secret }, { message: `second ${secret}` }],
    });

  await assert.rejects(
    () => loadRoadmapProjectItems("OpenCoven", 17, run),
    (error: unknown) => {
      assert.ok(error instanceof Error);
      assert.match(error.message, /2 GraphQL errors/i);
      assert.doesNotMatch(error.message, /private|github_pat|secret/i);
      return true;
    }
  );
});

test("rejects a missing organization or project", async () => {
  const missingOrganization: GraphqlRunner = () =>
    Promise.resolve({
      data: {
        organization: null,
      },
    });
  const missingProject: GraphqlRunner = () =>
    Promise.resolve({
      data: {
        organization: {
          projectV2: null,
        },
      },
    });

  await assert.rejects(
    () => loadRoadmapProjectItems("OpenCoven", 17, missingOrganization),
    /organization OpenCoven not found/i
  );
  await assert.rejects(
    () => loadRoadmapProjectItems("OpenCoven", 17, missingProject),
    /project 17 not found/i
  );
});

test("rejects malformed pages and a next page without a cursor", async () => {
  const malformedPage: GraphqlRunner = () =>
    Promise.resolve({
      data: {
        organization: {
          projectV2: {
            ...fieldSchemas(),
            items: {
              nodes: [],
              pageInfo: {
                endCursor: null,
                hasNextPage: false,
                unexpected: true,
              },
            },
          },
        },
      },
    });
  const missingCursor: GraphqlRunner = () =>
    Promise.resolve(
      pageResponse({
        endCursor: null,
        hasNextPage: true,
      })
    );

  await assert.rejects(() =>
    loadRoadmapProjectItems("OpenCoven", 17, malformedPage)
  );
  await assert.rejects(
    () => loadRoadmapProjectItems("OpenCoven", 17, missingCursor),
    /next page without a cursor/i
  );
});

test("rejects invalid managed enum values", async () => {
  const run: GraphqlRunner = () =>
    Promise.resolve(
      pageResponse({
        nodes: [
          projectItem("invalid-enum", {
            status: "Shipping",
          }),
        ],
      })
    );

  await assert.rejects(() => loadRoadmapProjectItems("OpenCoven", 17, run));
});
