import assert from "node:assert/strict";
import test from "node:test";
import {
  confirmSessionExpired,
  isSessionReauthenticationResponse,
  SESSION_REAUTHENTICATION_EVENT,
  sessionExpiredLoginPath,
  sessionExpiredLoginRoute,
  sessionFetch,
  synchronizeSessionProvider,
} from "./session-recovery";

test("only a same-origin application API 401 signals session revalidation", () => {
  const origin = "https://app.test";
  for (const path of [
    "/api/credentials",
    "/api/chat",
    "/api/runs/run/events",
  ]) {
    assert.equal(
      isSessionReauthenticationResponse(path, 401, origin, ""),
      true
    );
  }
  for (const path of [
    "/api/auth/session",
    "/api/internal/task",
    "/demo",
    "https://other.test/api/chat",
  ]) {
    assert.equal(
      isSessionReauthenticationResponse(path, 401, origin, ""),
      false
    );
  }
  for (const status of [200, 403, 429, 500, 503]) {
    assert.equal(
      isSessionReauthenticationResponse("/api/credentials", status, origin, ""),
      false
    );
  }
  assert.equal(
    isSessionReauthenticationResponse("/demo/api/chat", 401, origin, "/demo"),
    true
  );
  assert.equal(
    isSessionReauthenticationResponse("/api/chat", 401, origin, "/demo"),
    false
  );
});

test("expired-session redirects are canonical, scoped, and cannot return to login", () => {
  assert.equal(
    sessionExpiredLoginRoute("/demo/account", "/demo"),
    "/login?callbackUrl=%2Fdemo%2Faccount&reason=session-expired"
  );
  assert.equal(
    sessionExpiredLoginPath("/account?checkout=success", ""),
    "/login?callbackUrl=%2Faccount%3Fcheckout%3Dsuccess&reason=session-expired"
  );
  assert.equal(
    sessionExpiredLoginPath("/demo/agents", "/demo"),
    "/demo/login?callbackUrl=%2Fdemo%2Fagents&reason=session-expired"
  );
  for (const path of [
    "https://other.test",
    "//other.test",
    "/login?reason=session-expired",
    "/api/auth/session",
    "/a/../login",
    "/%2f%2fother.test",
  ]) {
    assert.equal(
      sessionExpiredLoginPath(path, ""),
      "/login?callbackUrl=%2F&reason=session-expired"
    );
  }
});

test("recovery requires an affirmative Auth.js null response, not an outage", async () => {
  assert.equal(
    await confirmSessionExpired(() => Promise.resolve(Response.json(null)), ""),
    true
  );
  assert.equal(
    await confirmSessionExpired(
      () => Promise.resolve(Response.json({ user: { id: "owner" } })),
      ""
    ),
    false
  );
  await assert.rejects(
    confirmSessionExpired(
      () => Promise.resolve(new Response(null, { status: 503 })),
      ""
    )
  );
  await assert.rejects(
    confirmSessionExpired(() => Promise.reject(new TypeError("offline")), "")
  );
  await assert.rejects(
    confirmSessionExpired(
      () => Promise.resolve(Response.json({ error: "unavailable" })),
      ""
    )
  );
});

test("the shared transport signals once without consuming or rewriting a 401 body", async (context) => {
  const originalWindow = Object.getOwnPropertyDescriptor(globalThis, "window");
  const target = new EventTarget();
  let refusals = 0;
  target.addEventListener(SESSION_REAUTHENTICATION_EVENT, () => {
    refusals += 1;
  });
  Object.defineProperty(globalThis, "window", {
    configurable: true,
    value: {
      dispatchEvent: target.dispatchEvent.bind(target),
      location: { origin: "https://app.test" },
    },
  });
  context.after(() => {
    if (originalWindow) {
      Object.defineProperty(globalThis, "window", originalWindow);
    } else {
      Reflect.deleteProperty(globalThis, "window");
    }
  });
  context.mock.method(globalThis, "fetch", () =>
    Promise.resolve(Response.json({ error: "unauthorized" }, { status: 401 }))
  );
  const response = await sessionFetch("/api/credentials");
  assert.equal(refusals, 1);
  assert.equal(response.status, 401);
  assert.deepEqual(await response.json(), { error: "unauthorized" });
});

test("provider resynchronization requires both a valid read and a ready provider", async () => {
  const controller = new AbortController();
  let ready: () => void = () => undefined;
  const providerReady = new Promise<void>((resolve) => {
    ready = resolve;
  });
  let completed = false;
  const synchronization = synchronizeSessionProvider(
    () => Promise.resolve({ user: { id: "owner" } }),
    providerReady,
    controller.signal
  ).then(() => {
    completed = true;
  });
  await new Promise((resolve) => setImmediate(resolve));
  assert.equal(completed, false);
  ready();
  await synchronization;
  assert.equal(completed, true);
});

test("a null Auth.js resynchronization result is failure, not restored state", async () => {
  await assert.rejects(
    synchronizeSessionProvider(
      () => Promise.resolve(null),
      Promise.resolve(),
      new AbortController().signal
    ),
    /temporarily unavailable/
  );
});

test("the recovery deadline bounds both a hung read and a provider that never becomes ready", async () => {
  const readController = new AbortController();
  const hungRead = synchronizeSessionProvider(
    () => new Promise(() => undefined),
    Promise.resolve(),
    readController.signal
  );
  readController.abort(new Error("Recovery deadline elapsed."));
  await assert.rejects(hungRead, /Recovery deadline elapsed/);

  const providerController = new AbortController();
  const hungProvider = synchronizeSessionProvider(
    () => Promise.resolve({ user: { id: "owner" } }),
    new Promise(() => undefined),
    providerController.signal
  );
  providerController.abort(new Error("Recovery deadline elapsed."));
  await assert.rejects(hungProvider, /Recovery deadline elapsed/);
});
