import assert from "node:assert/strict";
import { readdirSync, readFileSync } from "node:fs";
import test from "node:test";
import {
  RUNNER_DATABASE_GUARDS,
  runnerAdmissionFailure,
} from "./admission-observability";

function postgresError(code: string, message: string): Error {
  return Object.assign(new Error(message), { code, name: "PostgresError" });
}

test("an allowlisted P0001 guard is named through a wrapped cause", () => {
  const wrapped = new Error(
    "Failed query: insert into private_table values ($1)"
  );
  Object.assign(wrapped, {
    cause: postgresError(
      "P0001",
      "Restricted execution requires a clean sandbox trust profile"
    ),
  });

  assert.deepEqual(runnerAdmissionFailure("run_insert", wrapped), {
    code: "P0001",
    guard: "Restricted execution requires a clean sandbox trust profile",
    name: "PostgresError",
    stage: "run_insert",
  });
});

test("a P0001 message outside the allowlist is never reported", () => {
  const failure = runnerAdmissionFailure(
    "run_insert",
    postgresError("P0001", "tenant secret=unsafe rejected")
  );

  assert.deepEqual(failure, {
    code: "P0001",
    name: "PostgresError",
    stage: "run_insert",
  });
  assert.equal(JSON.stringify(failure).includes("unsafe"), false);
});

test("an allowlisted message with a non-P0001 code is not a guard", () => {
  assert.deepEqual(
    runnerAdmissionFailure(
      "run_insert",
      postgresError(
        "23514",
        "Restricted execution requires a clean sandbox trust profile"
      )
    ),
    { code: "23514", name: "PostgresError", stage: "run_insert" }
  );
});

test("non-database failures report no guard key", () => {
  assert.deepEqual(
    runnerAdmissionFailure("admission", new Error("database=private")),
    { code: null, name: "Error", stage: "admission" }
  );
});

test("the guard allowlist is exactly the runtime RAISE messages in migrations", () => {
  const directory = new URL("../db/migrations/", import.meta.url);
  const messages = new Set<string>();
  for (const name of readdirSync(directory)) {
    if (!name.endsWith(".sql")) {
      continue;
    }
    const source = readFileSync(new URL(name, directory), "utf8");
    for (const match of source.matchAll(
      /RAISE EXCEPTION\s+'((?:[^']|'')+)'/gu
    )) {
      const message = (match[1] ?? "").replaceAll("''", "'");
      // Migration-time DO blocks prefix their message with the migration index.
      if (/^\d{4} /u.test(message)) {
        continue;
      }
      messages.add(message);
    }
  }

  assert.deepEqual([...RUNNER_DATABASE_GUARDS], [...messages].sort());
});
