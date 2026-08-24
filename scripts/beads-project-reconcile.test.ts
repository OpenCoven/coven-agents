import assert from "node:assert/strict";
import test from "node:test";
import type { ProjectItem } from "./beads-project-model";
import type { DesiredProjectItem } from "./beads-project-policy";
import { MARKER_PREFIX } from "./beads-project-policy";
import {
  parseManagedBeadId,
  planReconciliation,
} from "./beads-project-reconcile";

function managedBody(beadId: string, body = "Body"): string {
  return `${MARKER_PREFIX}${beadId} -->\n\n${body}`;
}

function desiredItem(
  beadId: string,
  overrides: Partial<DesiredProjectItem> = {}
): DesiredProjectItem {
  return {
    beadId,
    body: overrides.body ?? managedBody(beadId),
    fields: overrides.fields ?? { Runner: "Shared" },
    title: overrides.title ?? "Title",
  };
}

function existingItem(
  beadId: string,
  overrides: Partial<ProjectItem> = {}
): ProjectItem {
  return {
    content: {
      body: overrides.content?.body ?? managedBody(beadId),
      title: overrides.content?.title ?? "Title",
      type: overrides.content?.type ?? "Note",
      ...(overrides.content ?? {}),
    },
    fields: overrides.fields ?? { Runner: "Shared" },
    id: overrides.id ?? `${beadId}-item`,
    ...overrides,
  };
}

test("creates an item when the marker is absent", () => {
  const plan = planReconciliation(
    [desiredItem("coven-agents-create", { fields: { Runner: "Shared" } })],
    [
      {
        content: {
          body: "Unmanaged note",
          title: "Unmanaged",
          type: "Note",
        },
        fields: { Notes: "ignore me" },
        id: "unmanaged-item",
      },
    ]
  );

  assert.deepEqual(plan, {
    actions: [
      {
        desired: desiredItem("coven-agents-create", {
          fields: { Runner: "Shared" },
        }),
        kind: "create",
      },
    ],
    orphaned: [],
    unchanged: 0,
    unmanaged: 1,
  });
});

test("treats an exact match as a no-op and counts unchanged", () => {
  const desired = desiredItem("coven-agents-match", {
    body: managedBody("coven-agents-match", "Keep"),
    fields: {
      Runner: "Shared",
      Size: "M",
    },
    title: "Keep title",
  });

  const plan = planReconciliation(
    [desired],
    [
      existingItem("coven-agents-match", {
        content: {
          body: desired.body,
          title: desired.title,
          type: "Note",
        },
        fields: {
          Runner: "Shared",
          Size: "M",
        },
        id: "match-item",
      }),
    ]
  );

  assert.deepEqual(plan, {
    actions: [],
    orphaned: [],
    unchanged: 1,
    unmanaged: 0,
  });
});

test("updates content and one changed field only", () => {
  const desired = desiredItem("coven-agents-update", {
    body: managedBody("coven-agents-update", "Updated body"),
    fields: {
      Runner: "Control plane",
      Size: "L",
    },
    title: "Updated title",
  });

  const plan = planReconciliation(
    [desired],
    [
      existingItem("coven-agents-update", {
        content: {
          body: managedBody("coven-agents-update", "Old body"),
          title: "Old title",
          type: "Note",
        },
        fields: {
          Runner: "Shared",
          Size: "L",
        },
        id: "update-item",
      }),
    ]
  );

  assert.deepEqual(plan, {
    actions: [
      {
        changedFields: ["Runner"],
        contentChanged: true,
        desired,
        itemId: "update-item",
        kind: "update",
      },
    ],
    orphaned: [],
    unchanged: 0,
    unmanaged: 0,
  });
});

test("rejects duplicate existing managed markers", () => {
  assert.throws(
    () =>
      planReconciliation(
        [desiredItem("coven-agents-one")],
        [
          existingItem("coven-agents-dup", { id: "item-a" }),
          existingItem("coven-agents-dup", { id: "item-b" }),
        ]
      ),
    /Duplicate managed bead marker: coven-agents-dup/
  );
});

test("rejects duplicate desired bead IDs", () => {
  assert.throws(
    () =>
      planReconciliation(
        [
          desiredItem("coven-agents-dup"),
          desiredItem("coven-agents-dup", { title: "Duplicate" }),
        ],
        []
      ),
    /Duplicate desired bead ID: coven-agents-dup/
  );
});

test("keeps unmanaged items untouched and reports orphaned managed items", () => {
  const desired = desiredItem("coven-agents-live", {
    body: managedBody("coven-agents-live", "Live body"),
    fields: { Runner: "Shared" },
    title: "Live title",
  });

  const plan = planReconciliation(
    [desired],
    [
      {
        content: {
          body: "Unmanaged note body",
          title: "Unmanaged note",
          type: "Note",
        },
        fields: { Notes: "keep me" },
        id: "unmanaged-note",
      },
      existingItem("coven-agents-live", {
        content: {
          body: desired.body,
          title: desired.title,
          type: "Note",
        },
        fields: { Runner: "Shared" },
        id: "live-item",
      }),
      existingItem("coven-agents-orphan", {
        content: {
          body: managedBody("coven-agents-orphan", "Orphan body"),
          title: "Orphan title",
          type: "Note",
        },
        fields: { Runner: "Local" },
        id: "orphan-item",
      }),
    ]
  );

  assert.deepEqual(plan, {
    actions: [],
    orphaned: ["coven-agents-orphan"],
    unchanged: 1,
    unmanaged: 1,
  });
});

test("parses exact markers, returns null without prefix, and rejects malformed markers", () => {
  assert.equal(
    parseManagedBeadId(managedBody("coven-agents-parse", "Parsed")),
    "coven-agents-parse"
  );
  assert.equal(parseManagedBeadId("Plain body"), null);
  assert.throws(
    () =>
      parseManagedBeadId(
        "<!-- coven-agents-bead-sync:v2 id=coven-agents-bad -->"
      ),
    /Malformed managed bead marker/
  );
  assert.throws(
    () => parseManagedBeadId("<!-- coven-agents-bead-sync:v1 id=bad -->"),
    /Malformed managed bead marker/
  );
  assert.throws(
    () =>
      parseManagedBeadId(
        "<!-- coven-agents-bead-sync v1 id=coven-agents-bad -->"
      ),
    /Malformed managed bead marker/
  );
  assert.throws(
    () =>
      parseManagedBeadId(
        "<!-- coven-agents-bead-sync:v1 id=coven-agents-bad --> junk"
      ),
    /Malformed managed bead marker/
  );
});

test("rejects malformed namespace markers before planning creates", () => {
  assert.throws(
    () =>
      planReconciliation(
        [desiredItem("coven-agents-create")],
        [
          existingItem("coven-agents-old", {
            content: {
              body: "<!-- coven-agents-bead-sync:v2 id=coven-agents-old -->\n\nBody",
              title: "Old",
              type: "Note",
            },
            id: "old-item",
          }),
        ]
      ),
    /Malformed managed bead marker/
  );
});

test("orders actions and orphaned IDs deterministically", () => {
  const desiredA = desiredItem("coven-agents-alpha", {
    body: managedBody("coven-agents-alpha", "Alpha body"),
    fields: {
      Runner: "Shared",
    },
    title: "Alpha title",
  });
  const desiredZ = desiredItem("coven-agents-zulu", {
    body: managedBody("coven-agents-zulu", "Zulu body"),
    fields: {
      Runner: "Control plane",
    },
    title: "Zulu title",
  });

  const plan = planReconciliation(
    [desiredZ, desiredA],
    [
      existingItem("coven-agents-alpha", {
        content: {
          body: managedBody("coven-agents-alpha", "Old alpha"),
          title: "Old alpha",
          type: "Note",
        },
        fields: { Runner: "Shared" },
        id: "alpha-item",
      }),
      existingItem("coven-agents-beta", {
        content: {
          body: managedBody("coven-agents-beta", "Beta body"),
          title: "Beta title",
          type: "Note",
        },
        fields: { Runner: "Shared" },
        id: "beta-item",
      }),
      existingItem("coven-agents-alpha-orphan", {
        content: {
          body: managedBody("coven-agents-alpha-orphan", "Alpha orphan"),
          title: "Alpha orphan",
          type: "Note",
        },
        fields: { Runner: "Shared" },
        id: "alpha-orphan-item",
      }),
    ]
  );

  assert.deepEqual(plan.actions, [
    {
      changedFields: [],
      contentChanged: true,
      desired: desiredA,
      itemId: "alpha-item",
      kind: "update",
    },
    {
      desired: desiredZ,
      kind: "create",
    },
  ]);
  assert.deepEqual(plan.orphaned, [
    "coven-agents-alpha-orphan",
    "coven-agents-beta",
  ]);
});

test("ignores unrelated existing fields when deciding updates", () => {
  const desired = desiredItem("coven-agents-preserve", {
    body: managedBody("coven-agents-preserve", "Preserve body"),
    fields: { Runner: "Shared" },
    title: "Preserve title",
  });

  const plan = planReconciliation(
    [desired],
    [
      existingItem("coven-agents-preserve", {
        content: {
          body: desired.body,
          title: desired.title,
          type: "Note",
        },
        fields: {
          Roadmap: "v2",
          Runner: "Shared",
        },
        id: "preserve-item",
      }),
    ]
  );

  assert.deepEqual(plan, {
    actions: [],
    orphaned: [],
    unchanged: 1,
    unmanaged: 0,
  });
});
