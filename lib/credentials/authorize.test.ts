import assert from "node:assert/strict";
import test from "node:test";
import { toSession } from "@/lib/session";
import { decideCredentialWrite } from "./authorize";

const body = { credential: "ghp_token", harnessId: "copilot" };

function subscriber() {
  return toSession({
    id: "3f2504e0-4f89-11d3-9a0c-0305e82c3301",
    type: "subscriber",
  });
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
    toSession({ id: "9c858901-8a57-4791-81fe-4c455b099bc9", type: "demo" }),
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

test("Codex credential writes refuse invalid or unredactable sign-in before storage", () => {
  for (const credential of [
    "not-json",
    JSON.stringify({ auth_mode: "apikey", OPENAI_API_KEY: "synthetic" }),
    JSON.stringify({
      auth_mode: "chatgpt",
      tokens: {
        access_token: "x".repeat(4097),
        account_id: "synthetic-account",
        id_token: "synthetic-id",
        refresh_token: "synthetic-refresh",
      },
    }),
  ]) {
    const decision = decideCredentialWrite(subscriber(), {
      credential,
      harnessId: "codex",
    });
    assert.equal(decision.kind, "invalid");
    if (decision.kind === "invalid") {
      assert.equal(decision.reason, "invalid_codex_auth");
    }
  }
});

test("removing Codex auth does not require the old sign-in but still requires subscriber authority", () => {
  const removal = { credential: "placeholder-not-stored", harnessId: "codex" };
  assert.equal(
    decideCredentialWrite(subscriber(), removal, "remove").kind,
    "allowed"
  );
  assert.equal(
    decideCredentialWrite(null, removal, "remove").kind,
    "unauthorized"
  );
  assert.equal(
    decideCredentialWrite(toSession(null), removal, "remove").kind,
    "forbidden"
  );
});
