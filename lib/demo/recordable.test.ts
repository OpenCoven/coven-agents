import assert from "node:assert/strict";
import test from "node:test";
import {
  assertRecordable,
  DEMO_REPOSITORY,
  type RecordableOptions,
} from "./recordable";

const validOptions: RecordableOptions = {
  allowFailure: false,
  backend: "cloud",
  credential: "demo-token",
  repository: DEMO_REPOSITORY,
  status: "completed",
};

test("a valid cloud demo recording is allowed", () => {
  assert.doesNotThrow(() => assertRecordable(validOptions));
});

test("repositories other than the exact demo workspace are refused", () => {
  for (const repository of [
    "",
    "OpenCoven/demo-workspaces",
    "opencoven/demo-workspace",
    "OpenCoven/other",
  ]) {
    assert.throws(
      () => assertRecordable({ ...validOptions, repository }),
      /refus.*demo-workspace/i
    );
  }
});

test("local recordings are refused", () => {
  assert.throws(
    () => assertRecordable({ ...validOptions, backend: "local" }),
    /refus.*cloud/i
  );
});

test("empty or whitespace credentials are refused", () => {
  for (const credential of ["", " ", "\t\n"]) {
    assert.throws(
      () => assertRecordable({ ...validOptions, credential }),
      /refus.*credential/i
    );
  }
});

test("failed recordings are refused unless failure is explicitly allowed", () => {
  const failed = { ...validOptions, status: "failed" as const };

  assert.throws(() => assertRecordable(failed), /refus.*allow-failure/i);
  assert.doesNotThrow(() =>
    assertRecordable({ ...failed, allowFailure: true })
  );
});

test("allowing failure does not bypass repository or backend checks", () => {
  assert.throws(
    () =>
      assertRecordable({
        ...validOptions,
        allowFailure: true,
        backend: "local",
        repository: "OpenCoven/not-demo-workspace",
        status: "failed",
      }),
    /refus.*demo-workspace/i
  );
  assert.throws(
    () =>
      assertRecordable({
        ...validOptions,
        allowFailure: true,
        backend: "local",
        status: "failed",
      }),
    /cloud/i
  );
});
