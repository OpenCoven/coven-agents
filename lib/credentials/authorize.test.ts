import assert from "node:assert/strict";
import test from "node:test";
import { toSession } from "@/lib/session";
import { decideCredentialWrite } from "./authorize";

const body = { credential: "ghp_token", harnessId: "copilot" };

function subscriber() {
  return toSession({ id: "user-1", type: "subscriber" });
}

test("an anonymous caller is unauthorized", () => {
  assert.deepEqual(decideCredentialWrite(null, body), { kind: "unauthorized" });
});

test("a demo session is forbidden, not unauthorized", () => {
  // Being signed in is not the same as having paid. Telling an authenticated
  // user to sign in again would send them round a loop they cannot exit.
  const decision = decideCredentialWrite(toSession(null), body);

  assert.equal(decision.kind, "forbidden");
});

test("a signed-in non-subscriber is still forbidden", () => {
  // The write goes to the owner's database, which is subscriber-only. This is
  // the rule that keeps a free account from storing rows there.
  const decision = decideCredentialWrite(
    toSession({ id: "user-2", type: "demo" }),
    body
  );

  assert.equal(decision.kind, "forbidden");
});

test("a subscriber writing a known harness is allowed", () => {
  const decision = decideCredentialWrite(subscriber(), body);

  assert.equal(decision.kind, "allowed");
  if (decision.kind === "allowed") {
    assert.equal(decision.harnessId, "copilot");
    assert.equal(decision.session.kind, "subscriber");
  }
});

test("an unknown harness id is refused", () => {
  // An arbitrary id would store a credential nothing ever reads: it looks like
  // a working setup and behaves like a missing one.
  for (const harnessId of ["", "not-a-harness", "COPILOT", "../copilot"]) {
    const decision = decideCredentialWrite(subscriber(), {
      ...body,
      harnessId,
    });

    assert.equal(
      decision.kind,
      "invalid",
      `${JSON.stringify(harnessId)} must be refused`
    );
  }
});

test("a blank credential is refused", () => {
  for (const credential of ["", "   ", "\n", 42, null, undefined]) {
    const decision = decideCredentialWrite(subscriber(), {
      ...body,
      credential,
    });

    assert.equal(
      decision.kind,
      "invalid",
      `${JSON.stringify(credential)} must be refused`
    );
  }
});

test("authorization is decided before the body is judged", () => {
  // A demo caller sending nonsense should learn they lack a subscription, not
  // be handed a validation error that implies retrying with better input would
  // work.
  const decision = decideCredentialWrite(toSession(null), {
    credential: "",
    harnessId: "nonsense",
  });

  assert.equal(decision.kind, "forbidden");
});
