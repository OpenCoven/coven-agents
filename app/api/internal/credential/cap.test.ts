import assert from "node:assert/strict";
import test from "node:test";
import { MONTHLY_RUN_CAP } from "@/lib/billing/limits";
import { capVerdict } from "./cap";

const RESETS = new Date("2026-09-20T12:00:00.000Z");

test("under the cap is allowed", () => {
  assert.equal(
    capVerdict({ resetsAt: RESETS, used: MONTHLY_RUN_CAP - 1 }).kind,
    "allowed"
  );
});

test("at the cap is refused", () => {
  // The boundary has to fall one way. At the cap means the included runs are
  // spent, which is what "750 runs included" says.
  assert.equal(
    capVerdict({ resetsAt: RESETS, used: MONTHLY_RUN_CAP }).kind,
    "refused"
  );
});

test("a refusal carries what the caller needs to explain it", () => {
  const verdict = capVerdict({ resetsAt: RESETS, used: MONTHLY_RUN_CAP });

  assert.equal(verdict.kind, "refused");
  if (verdict.kind === "refused") {
    assert.equal(verdict.cap, MONTHLY_RUN_CAP);
    assert.equal(verdict.used, MONTHLY_RUN_CAP);
    assert.equal(verdict.resetsAt, RESETS.toISOString());
  }
});

test("an unknown period refuses rather than allowing", () => {
  // An error reading usage is not permission to exceed the cap. Allowing on
  // error is how a cap quietly stops existing.
  assert.equal(capVerdict({ resetsAt: null, used: 0 }).kind, "refused");
});

test("usage beyond the cap is still refused", () => {
  // A counter that somehow ran past the cap must not wrap back to allowed.
  assert.equal(
    capVerdict({ resetsAt: RESETS, used: MONTHLY_RUN_CAP * 3 }).kind,
    "refused"
  );
});
