import assert from "node:assert/strict";
import test from "node:test";
import {
  generateTitleWithAuthorization,
  type TitleGenerationDependencies,
} from "./title-generation";

const session = {
  user: {
    authVersion: 4,
    id: "6ba7b810-9dad-11d1-80b4-00c04fd430c8",
    type: "subscriber" as const,
  },
};
const message = { id: "message-1", parts: [], role: "user" } as never;

function dependencies(
  calls: string[],
  overrides: Partial<TitleGenerationDependencies> = {}
): TitleGenerationDependencies {
  return {
    authorize: () => {
      calls.push("authorize");
      return Promise.resolve({
        authVersion: 4,
        kind: "allowed",
        session: {
          kind: "subscriber",
          tenant: "u_6ba7b8109dad11d180b400c04fd430c8",
          userId: session.user.id,
        },
        userId: session.user.id,
      });
    },
    enforceAbuse: () => {
      calls.push("abuse");
      return Promise.resolve({ kind: "allowed" });
    },
    generate: () => {
      calls.push("model");
      return Promise.resolve("A title");
    },
    ...overrides,
  };
}

test("unauthenticated title generation never reaches the model", async () => {
  const calls: string[] = [];
  await assert.rejects(
    () =>
      generateTitleWithAuthorization(
        message,
        null,
        dependencies(calls, {
          authorize: () => {
            calls.push("authorize");
            return Promise.resolve({ kind: "unauthorized" });
          },
        })
      ),
    /unauthorized/i
  );
  assert.deepEqual(calls, ["authorize"]);
});

test("lapsed and revoked title access never reaches the model", async () => {
  await Promise.all(
    (["subscription_required", "unauthorized"] as const).map(async (denied) => {
      const calls: string[] = [];
      await assert.rejects(
        () =>
          generateTitleWithAuthorization(
            message,
            session,
            dependencies(calls, {
              authorize: () => {
                calls.push("authorize");
                return Promise.resolve({ kind: denied });
              },
            })
          ),
        denied === "unauthorized" ? /unauthorized/i : /subscription required/i
      );
      assert.deepEqual(calls, ["authorize"]);
    })
  );
});

test("title generation spends abuse admission before the model", async () => {
  const calls: string[] = [];
  const title = await generateTitleWithAuthorization(
    message,
    session,
    dependencies(calls)
  );
  assert.equal(title, "A title");
  assert.deepEqual(calls, ["authorize", "abuse", "model"]);
});

test("denied title admission never reaches the model", async () => {
  const calls: string[] = [];
  await assert.rejects(
    () =>
      generateTitleWithAuthorization(
        message,
        session,
        dependencies(calls, {
          enforceAbuse: () => {
            calls.push("abuse");
            return Promise.resolve({
              kind: "denied",
              responseStatus: 429,
              retryAfterSeconds: 60,
            });
          },
        })
      ),
    /rate limit/i
  );
  assert.deepEqual(calls, ["authorize", "abuse"]);
});
