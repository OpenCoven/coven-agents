import type { ProjectItem } from "./beads-project-model";
import type { DesiredProjectItem } from "./beads-project-policy";

export type ReconciliationAction =
  | {
      desired: DesiredProjectItem;
      kind: "create";
    }
  | {
      changedFields: string[];
      contentChanged: boolean;
      desired: DesiredProjectItem;
      itemId: string;
      kind: "update";
    };

export type ReconciliationPlan = {
  actions: ReconciliationAction[];
  orphaned: string[];
  unchanged: number;
  unmanaged: number;
};

const MALFORMED_MARKER_ERROR = "Malformed managed bead marker";
const MANAGED_MARKER_NAMESPACE = "coven-agents-bead-sync";
const MANAGED_MARKER_PATTERN =
  /^<!-- coven-agents-bead-sync:v1 id=(coven-agents-[a-z0-9.-]+) -->$/;

function firstLine(value: string): string {
  return value.split(/\r?\n/, 1)[0] ?? "";
}

function malformedMarkerError(): Error {
  return new Error(MALFORMED_MARKER_ERROR);
}

function compareStrings(left: string, right: string): number {
  return left.localeCompare(right);
}

export function parseManagedBeadId(body: string): string | null {
  const line = firstLine(body);

  if (!line.toLowerCase().includes(MANAGED_MARKER_NAMESPACE)) {
    return null;
  }

  const match = line.match(MANAGED_MARKER_PATTERN);

  if (!match) {
    throw malformedMarkerError();
  }

  if (
    body.slice(line.length).toLowerCase().includes(MANAGED_MARKER_NAMESPACE)
  ) {
    throw malformedMarkerError();
  }

  return match[1];
}

export function planReconciliation(
  desiredItems: DesiredProjectItem[],
  existingItems: ProjectItem[]
): ReconciliationPlan {
  const desiredById = new Map<string, DesiredProjectItem>();

  for (const desired of desiredItems) {
    if (desiredById.has(desired.beadId)) {
      throw new Error(`Duplicate desired bead ID: ${desired.beadId}`);
    }

    desiredById.set(desired.beadId, desired);
  }

  const managedExistingById = new Map<string, ProjectItem>();
  let unmanaged = 0;

  for (const item of existingItems) {
    const managedBeadId = parseManagedBeadId(item.content.body);

    if (managedBeadId === null) {
      unmanaged += 1;
      continue;
    }

    if (managedExistingById.has(managedBeadId)) {
      throw new Error(`Duplicate managed bead marker: ${managedBeadId}`);
    }

    managedExistingById.set(managedBeadId, item);
  }

  const actions: ReconciliationAction[] = [];
  let unchanged = 0;

  for (const desired of desiredItems) {
    const existing = managedExistingById.get(desired.beadId);

    if (existing === undefined) {
      actions.push({
        desired,
        kind: "create",
      });
      continue;
    }

    const changedFields = Object.keys(desired.fields).filter(
      (field) => existing.fields[field] !== desired.fields[field]
    );

    const contentChanged =
      existing.content.title !== desired.title ||
      existing.content.body !== desired.body;

    if (!contentChanged && changedFields.length === 0) {
      unchanged += 1;
      continue;
    }

    actions.push({
      changedFields: changedFields.sort(compareStrings),
      contentChanged,
      desired,
      itemId: existing.id,
      kind: "update",
    });
  }

  actions.sort((left, right) =>
    left.desired.beadId.localeCompare(right.desired.beadId)
  );

  return {
    actions,
    orphaned: [...managedExistingById.keys()]
      .filter((beadId) => !desiredById.has(beadId))
      .sort(compareStrings),
    unchanged,
    unmanaged,
  };
}
