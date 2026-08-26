import { z } from "zod";
import { type GraphqlRunner, runGraphql } from "./beads-project-io";
import { PROJECT_STATUSES, WAVES } from "./beads-project-model";
import {
  BLOCKED_OPTIONS,
  type RoadmapProjectItem,
} from "./roadmap-status-model";

export const ROADMAP_STATUS_QUERY = `
  query RoadmapProjectStatus(
    $owner: String!
    $number: Int!
    $after: String
  ) {
    organization(login: $owner) {
      projectV2(number: $number) {
        beadIdField: field(name: "Bead ID") {
          __typename
          ... on ProjectV2Field {
            dataType
          }
          ... on ProjectV2SingleSelectField {
            options {
              name
            }
          }
        }
        statusField: field(name: "Status") {
          __typename
          ... on ProjectV2Field {
            dataType
          }
          ... on ProjectV2SingleSelectField {
            options {
              name
            }
          }
        }
        waveField: field(name: "Wave") {
          __typename
          ... on ProjectV2Field {
            dataType
          }
          ... on ProjectV2SingleSelectField {
            options {
              name
            }
          }
        }
        blockedField: field(name: "Blocked") {
          __typename
          ... on ProjectV2Field {
            dataType
          }
          ... on ProjectV2SingleSelectField {
            options {
              name
            }
          }
        }
        items(first: 100, after: $after) {
          nodes {
            id
            beadId: fieldValueByName(name: "Bead ID") {
              __typename
              ... on ProjectV2ItemFieldTextValue {
                text
              }
            }
            status: fieldValueByName(name: "Status") {
              __typename
              ... on ProjectV2ItemFieldSingleSelectValue {
                name
              }
            }
            wave: fieldValueByName(name: "Wave") {
              __typename
              ... on ProjectV2ItemFieldSingleSelectValue {
                name
              }
            }
            blocked: fieldValueByName(name: "Blocked") {
              __typename
              ... on ProjectV2ItemFieldSingleSelectValue {
                name
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
  }
`;

const optionSchema = z
  .object({
    name: z.string(),
  })
  .strict();

const fieldSchema = z.discriminatedUnion("__typename", [
  z
    .object({
      __typename: z.literal("ProjectV2Field"),
      dataType: z.string(),
    })
    .strict(),
  z
    .object({
      __typename: z.literal("ProjectV2SingleSelectField"),
      options: z.array(optionSchema),
    })
    .strict(),
]);

const textValueSchema = z
  .object({
    __typename: z.literal("ProjectV2ItemFieldTextValue"),
    text: z.string().min(1),
  })
  .strict();

const singleSelectValueSchema = z
  .object({
    __typename: z.literal("ProjectV2ItemFieldSingleSelectValue"),
    name: z.string(),
  })
  .strict();

const projectItemSchema = z
  .object({
    beadId: textValueSchema.nullable(),
    blocked: singleSelectValueSchema.nullable(),
    id: z.string().min(1),
    status: singleSelectValueSchema.nullable(),
    wave: singleSelectValueSchema.nullable(),
  })
  .strict();

const projectPageSchema = z
  .object({
    beadIdField: fieldSchema.nullable(),
    blockedField: fieldSchema.nullable(),
    items: z
      .object({
        nodes: z.array(projectItemSchema),
        pageInfo: z
          .object({
            endCursor: z.string().min(1).nullable(),
            hasNextPage: z.boolean(),
          })
          .strict(),
      })
      .strict(),
    statusField: fieldSchema.nullable(),
    waveField: fieldSchema.nullable(),
  })
  .strict();

const responseDataSchema = z
  .object({
    organization: z
      .object({
        projectV2: projectPageSchema.nullable(),
      })
      .strict()
      .nullable(),
  })
  .strict();

const responseEnvelopeSchema = z
  .object({
    data: z.unknown().nullable().optional(),
    errors: z.array(z.unknown()).optional(),
    rateLimit: z
      .object({
        cost: z.number(),
        remaining: z.number(),
        resetAt: z.string(),
      })
      .strict()
      .optional(),
  })
  .strict();

const roadmapProjectItemSchema = z
  .object({
    beadId: z.string().min(1),
    blocked: z.enum(BLOCKED_OPTIONS),
    status: z.enum(PROJECT_STATUSES),
    wave: z.enum(WAVES),
  })
  .strict();

type ProjectPage = z.infer<typeof projectPageSchema>;
type ProjectItemNode = z.infer<typeof projectItemSchema>;

function sameOptions(
  actual: readonly string[],
  expected: readonly string[]
): boolean {
  if (actual.length !== expected.length) {
    return false;
  }

  const sortedActual = [...actual].sort();
  const sortedExpected = [...expected].sort();

  return sortedActual.every(
    (option, index) => option === sortedExpected[index]
  );
}

function validateTextField(
  field: ProjectPage["beadIdField"],
  fieldName: string
): void {
  if (
    field === null ||
    field.__typename !== "ProjectV2Field" ||
    field.dataType !== "TEXT"
  ) {
    throw new Error(`Project field ${fieldName} must be a TEXT field`);
  }
}

function validateSingleSelectField(
  field:
    | ProjectPage["blockedField"]
    | ProjectPage["statusField"]
    | ProjectPage["waveField"],
  fieldName: string,
  expectedOptions: readonly string[]
): void {
  if (field === null || field.__typename !== "ProjectV2SingleSelectField") {
    throw new Error(`Project field ${fieldName} must be single-select`);
  }

  if (
    !sameOptions(
      field.options.map((option) => option.name),
      expectedOptions
    )
  ) {
    throw new Error(`Project field ${fieldName} has incorrect options`);
  }
}

function validateProjectSchema(project: ProjectPage): void {
  validateTextField(project.beadIdField, "Bead ID");
  validateSingleSelectField(project.statusField, "Status", PROJECT_STATUSES);
  validateSingleSelectField(project.waveField, "Wave", WAVES);
  validateSingleSelectField(project.blockedField, "Blocked", BLOCKED_OPTIONS);
}

function readProjectPage(
  payload: unknown,
  owner: string,
  projectNumber: number
): ProjectPage {
  const envelope = responseEnvelopeSchema.parse(payload);
  const errorCount = envelope.errors?.length ?? 0;

  if (errorCount > 0) {
    const label = errorCount === 1 ? "error" : "errors";
    throw new Error(`GitHub GraphQL returned ${errorCount} GraphQL ${label}`);
  }

  if (envelope.data === undefined || envelope.data === null) {
    throw new Error("GitHub GraphQL response missing data");
  }

  const data = responseDataSchema.parse(envelope.data);

  if (data.organization === null) {
    throw new Error(`GitHub organization ${owner} not found`);
  }

  if (data.organization.projectV2 === null) {
    throw new Error(`GitHub Project ${projectNumber} not found`);
  }

  return data.organization.projectV2;
}

function parseProjectItem(
  item: ProjectItemNode
): RoadmapProjectItem | undefined {
  if (item.beadId === null) {
    return undefined;
  }

  if (item.status === null || item.wave === null || item.blocked === null) {
    throw new Error(
      `Managed Project item ${item.id} is missing required value`
    );
  }

  return roadmapProjectItemSchema.parse({
    beadId: item.beadId.text,
    blocked: item.blocked.name,
    status: item.status.name,
    wave: item.wave.name,
  });
}

export async function loadRoadmapProjectItems(
  owner: string,
  projectNumber: number,
  graphql: GraphqlRunner = runGraphql
): Promise<RoadmapProjectItem[]> {
  const items: RoadmapProjectItem[] = [];

  async function loadPage(after: string | null): Promise<void> {
    const variables = {
      after,
      number: projectNumber,
      owner,
    };
    const payload = await graphql(ROADMAP_STATUS_QUERY, variables);
    const project = readProjectPage(payload, owner, projectNumber);

    validateProjectSchema(project);

    for (const item of project.items.nodes) {
      const parsed = parseProjectItem(item);

      if (parsed !== undefined) {
        items.push(parsed);
      }
    }

    if (!project.items.pageInfo.hasNextPage) {
      return;
    }

    if (project.items.pageInfo.endCursor === null) {
      throw new Error("Project items reported a next page without a cursor");
    }

    await loadPage(project.items.pageInfo.endCursor);
  }

  await loadPage(null);

  return items;
}
