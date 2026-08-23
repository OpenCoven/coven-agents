import { z } from "zod";

export const RUNNERS = ["Cloud", "Local", "Control plane", "Shared"] as const;
export const SIZES = ["XS", "S", "M", "L", "XL"] as const;
export const WORKSTREAMS = [
  "Product",
  "Contracts & harnesses",
  "Cloud runner",
  "Local runner",
  "Data lifecycle",
  "Security & privacy",
  "Observability",
  "Testing & reliability",
  "Releases & docs",
  "Developer experience",
] as const;
export const PROJECT_STATUSES = [
  "Todo",
  "In Progress",
  "In review",
  "Done",
] as const;
export const BEAD_TYPES = ["epic", "feature", "task", "bug"] as const;
export const BEAD_STATUSES = [
  "open",
  "in_progress",
  "blocked",
  "deferred",
  "closed",
] as const;

const dependencySchema = z
  .object({
    depends_on_id: z.string().trim().min(1),
    issue_id: z.string().trim().min(1),
    type: z.string().trim().min(1),
  })
  .strict();

const metadataSchema = z
  .object({
    projectStatus: z.enum(PROJECT_STATUSES).optional(),
    runner: z.enum(RUNNERS),
    size: z.enum(SIZES),
    workstream: z.enum(WORKSTREAMS),
  })
  .strict();

const beadSourceSchema = z
  .object({
    acceptance_criteria: z.string().trim().min(1),
    dependencies: z.array(dependencySchema).default([]),
    description: z.string().trim().min(1),
    id: z.string().regex(/^coven-agents-[a-z0-9.-]+$/),
    issue_type: z.enum(BEAD_TYPES),
    metadata: metadataSchema,
    parent: z.string().trim().min(1).optional(),
    priority: z.number().int().min(0).max(2),
    status: z.enum(BEAD_STATUSES),
    title: z.string().trim().min(1),
  })
  .passthrough();

const beadSchema = beadSourceSchema;

export type Bead = z.infer<typeof beadSchema>;

export type ProjectItem = {
  content: {
    body: string;
    title: string;
    type: string;
  } & Record<string, unknown>;
  fields: Record<string, string>;
  id: string;
};

export type ProjectJson = {
  items: ProjectItem[];
  totalCount: number;
};

const projectContentSchema = z
  .object({
    body: z.string(),
    title: z.string(),
    type: z.string(),
  })
  .passthrough();

const projectItemSchema = z
  .object({
    content: projectContentSchema,
    id: z.string().min(1),
  })
  .passthrough();

const beadsJsonSchema = z.array(beadSchema);

const projectJsonSchema = z
  .object({
    items: z.array(projectItemSchema),
    totalCount: z.number().int().nonnegative(),
  })
  .passthrough();

const canonicalProjectFieldNames: Readonly<Record<string, string>> = {
  "bead id": "Bead ID",
  blocked: "Blocked",
  priority: "Priority",
  runner: "Runner",
  size: "Size",
  status: "Status",
  type: "Type",
  workstream: "Workstream",
};

function canonicalizeProjectFieldName(fieldName: string): string {
  const canonical = canonicalProjectFieldNames[fieldName.trim().toLowerCase()];
  return canonical ?? fieldName;
}

function extractProjectFields(
  item: Record<string, unknown>
): Record<string, string> {
  const fields: Record<string, string> = {};

  for (const [key, value] of Object.entries(item)) {
    if (key === "content" || key === "id") {
      continue;
    }

    if (typeof value !== "string") {
      continue;
    }

    fields[canonicalizeProjectFieldName(key)] = value;
  }

  return fields;
}

export function parseBeadsJson(input: string): Bead[] {
  return beadsJsonSchema.parse(JSON.parse(input));
}

export function parseProjectJson(input: string): ProjectJson {
  const parsed = projectJsonSchema.parse(JSON.parse(input));

  return {
    items: parsed.items.map((item) => ({
      content: item.content,
      fields: extractProjectFields(item),
      id: item.id,
    })),
    totalCount: parsed.totalCount,
  };
}
