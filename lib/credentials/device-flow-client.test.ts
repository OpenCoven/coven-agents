import assert from "node:assert/strict";
import test from "node:test";
import {
  createDeviceFlowController,
  type DeviceFlowAuthorityContext,
  type DeviceFlowNotice,
  type DeviceFlowViewState,
} from "./device-flow-client";

const STARTED = {
  deviceCode: "device-secret",
  interval: 1,
  userCode: "ABCD-EFGH",
  verificationUri: "https://github.com/login/device",
};

type ScheduledTask = {
  callback: () => Promise<void> | void;
  delay: number;
  handle: number;
};

function jsonResponse(body: unknown, status = 200, headers?: HeadersInit) {
  return new Response(JSON.stringify(body), {
    headers: { "content-type": "application/json", ...headers },
    status,
  });
}

function createHarness() {
  let authority: DeviceFlowAuthorityContext = {
    key: "subscriber:revision-one",
    revision: "revision-one",
    valid: true,
  };
  let clock = 1_000_000;
  let nextHandle = 1;
  const scheduled: ScheduledTask[] = [];
  const responses: Array<
    Response | ((signal: AbortSignal, method: string) => Promise<Response>)
  > = [];
  const requests: Array<{
    idempotencyKey: string | null;
    method: string;
    signal: AbortSignal;
  }> = [];
  const states: DeviceFlowViewState[] = [];
  const notices: DeviceFlowNotice[] = [];
  const invalidations: string[] = [];
  const opened: string[] = [];
  let connected = 0;

  const controller = createDeviceFlowController({
    cancel: (handle) => {
      const index = scheduled.findIndex((task) => task.handle === handle);
      if (index >= 0) {
        scheduled.splice(index, 1);
      }
    },
    fetcher: (_input, init) => {
      const method = init?.method ?? "GET";
      const signal = init?.signal;
      assert.ok(signal);
      requests.push({
        idempotencyKey:
          new Headers(init?.headers).get("idempotency-key") ?? null,
        method,
        signal,
      });
      const response = responses.shift();
      assert.ok(response, `Unexpected ${method} request`);
      return typeof response === "function"
        ? response(signal, method)
        : Promise.resolve(response);
    },
    generateKey: () => `attempt-${requests.length + 1}`,
    getAuthority: () => authority,
    now: () => clock,
    onAuthorityInvalidated: (revision) => invalidations.push(revision),
    onConnected: () => {
      connected += 1;
    },
    onNotice: (notice) => notices.push(notice),
    onOpenVerification: (uri) => opened.push(uri),
    onState: (state) => states.push(state),
    schedule: (callback, delay) => {
      const handle = nextHandle;
      nextHandle += 1;
      scheduled.push({ callback, delay, handle });
      return handle;
    },
  });

  return {
    advanceAuthority(next: DeviceFlowAuthorityContext) {
      authority = next;
      controller.authorityChanged(next);
    },
    get connected() {
      return connected;
    },
    controller,
    invalidations,
    notices,
    opened,
    requests,
    responses,
    async runNext() {
      const task = scheduled.shift();
      assert.ok(task, "Expected a scheduled task");
      clock += task.delay;
      await task.callback();
    },
    scheduled,
    states,
  };
}

test("start 403 stops and invalidates the authority revision only once", async () => {
  const harness = createHarness();
  harness.responses.push(
    jsonResponse({ error: "subscription_required" }, 403),
    jsonResponse({ error: "subscription_required" }, 403)
  );

  await harness.controller.start();
  await harness.controller.start();

  assert.deepEqual(harness.invalidations, ["revision-one"]);
  assert.equal(harness.scheduled.length, 0);
  assert.deepEqual(harness.states.at(-1), { busy: false, started: null });
  assert.equal(
    harness.notices.at(-1)?.message,
    "Subscription required to connect GitHub Copilot."
  );
});

test("poll 403 clears the code, stops polling, and invalidates authority", async () => {
  const harness = createHarness();
  harness.responses.push(
    jsonResponse(STARTED),
    jsonResponse({ error: "subscription_required" }, 403)
  );

  await harness.controller.start();
  assert.equal(harness.states.at(-1)?.started?.userCode, "ABCD-EFGH");
  await harness.runNext();

  assert.deepEqual(harness.invalidations, ["revision-one"]);
  assert.equal(harness.scheduled.length, 0);
  assert.deepEqual(harness.states.at(-1), { busy: false, started: null });
  assert.equal(
    harness.notices.at(-1)?.message,
    "Subscription required to connect GitHub Copilot."
  );
});

test("dispose clears a poll timer, aborts the request, and fences its result", async () => {
  const harness = createHarness();
  const pendingPoll: { finish?: (response: Response) => void } = {};
  harness.responses.push(jsonResponse(STARTED), (signal, method) => {
    assert.equal(method, "PUT");
    assert.equal(signal.aborted, false);
    return new Promise<Response>((resolve) => {
      pendingPoll.finish = resolve;
    });
  });

  await harness.controller.start();
  const polling = harness.runNext();
  await Promise.resolve();
  const pollSignal = harness.requests.at(-1)?.signal;
  assert.ok(pollSignal);

  harness.controller.dispose();
  const stateCount = harness.states.length;
  assert.equal(pollSignal.aborted, true);
  assert.equal(harness.scheduled.length, 0);

  assert.ok(pendingPoll.finish);
  pendingPoll.finish(jsonResponse({ status: "authorized" }));
  await polling;
  assert.equal(harness.states.length, stateCount);
  assert.equal(harness.connected, 0);
});

test("authority revision changes abort and clear the active flow", async () => {
  const harness = createHarness();
  harness.responses.push(jsonResponse(STARTED));
  await harness.controller.start();

  harness.advanceAuthority({
    key: "subscriber:revision-two",
    revision: "revision-two",
    valid: true,
  });

  assert.equal(harness.scheduled.length, 0);
  assert.deepEqual(harness.states.at(-1), { busy: false, started: null });
});

test("malformed success and terminal non-2xx responses never schedule polling", async () => {
  const malformedStart = createHarness();
  malformedStart.responses.push(jsonResponse({ interval: 1 }));
  await malformedStart.controller.start();
  assert.equal(malformedStart.scheduled.length, 0);
  assert.match(
    malformedStart.notices.at(-1)?.message ?? "",
    /invalid connection response/i
  );

  const malformedPoll = createHarness();
  malformedPoll.responses.push(
    jsonResponse(STARTED),
    jsonResponse({ status: "mystery" })
  );
  await malformedPoll.controller.start();
  await malformedPoll.runNext();
  assert.equal(malformedPoll.scheduled.length, 0);
  assert.match(
    malformedPoll.notices.at(-1)?.message ?? "",
    /invalid connection response/i
  );

  const terminalPoll = createHarness();
  terminalPoll.responses.push(
    jsonResponse(STARTED),
    jsonResponse({ error: "invalid_request" }, 422)
  );
  await terminalPoll.controller.start();
  await terminalPoll.runNext();
  assert.equal(terminalPoll.scheduled.length, 0);
  assert.match(
    terminalPoll.notices.at(-1)?.message ?? "",
    /could not continue/i
  );
});

test("401 stops with explicit sign-in guidance", async () => {
  const harness = createHarness();
  harness.responses.push(jsonResponse({ error: "unauthorized" }, 401));

  await harness.controller.start();

  assert.equal(harness.scheduled.length, 0);
  assert.match(harness.notices.at(-1)?.message ?? "", /sign in again/i);
});

test("429 honors Retry-After and transient failures use bounded retries", async () => {
  const throttled = createHarness();
  throttled.responses.push(
    jsonResponse({ error: "rate_limited" }, 429, { "retry-after": "7" })
  );
  await throttled.controller.start();
  assert.equal(throttled.scheduled.at(-1)?.delay, 7000);

  const longThrottle = createHarness();
  longThrottle.responses.push(
    jsonResponse({ error: "rate_limited" }, 429, {
      "retry-after": String(25 * 60 * 60),
    })
  );
  await longThrottle.controller.start();
  assert.equal(longThrottle.scheduled.at(-1)?.delay, 15 * 60_000);

  const transient = createHarness();
  transient.responses.push(
    jsonResponse(STARTED),
    jsonResponse({ error: "unavailable" }, 503)
  );
  await transient.controller.start();
  await transient.runNext();
  const retryDelay = transient.scheduled.at(-1)?.delay ?? 0;
  assert.ok(retryDelay >= 1000);
  assert.ok(retryDelay <= 30_000);
});

test("transient poll retries never outrun a bounded slow-down interval", async () => {
  const harness = createHarness();
  harness.responses.push(
    jsonResponse(STARTED),
    ...Array.from({ length: 12 }, () => jsonResponse({ status: "slow_down" })),
    jsonResponse({ error: "unavailable" }, 503)
  );

  await harness.controller.start();
  for (let index = 0; index < 12; index += 1) {
    // biome-ignore lint/performance/noAwaitInLoops: each response schedules the next poll.
    await harness.runNext();
  }
  assert.equal(harness.scheduled.at(-1)?.delay, 60_000);

  await harness.runNext();
  assert.equal(harness.scheduled.at(-1)?.delay, 60_000);
});

test("the 15-minute deadline aborts an outstanding request", async () => {
  const harness = createHarness();
  harness.responses.push(
    (signal) =>
      new Promise<Response>((_resolve, reject) => {
        signal.addEventListener(
          "abort",
          () => reject(new DOMException("Aborted", "AbortError")),
          { once: true }
        );
      })
  );

  const starting = harness.controller.start();
  await Promise.resolve();
  assert.equal(harness.scheduled.at(-1)?.delay, 15 * 60_000);

  await harness.runNext();
  await starting;

  assert.equal(harness.requests.at(-1)?.signal.aborted, true);
  assert.equal(harness.scheduled.length, 0);
  assert.match(harness.notices.at(-1)?.message ?? "", /timed out/i);
});

test("successful device flow still opens GitHub, clears the code, and connects", async () => {
  const harness = createHarness();
  harness.responses.push(
    jsonResponse(STARTED),
    jsonResponse({ status: "authorized" })
  );

  await harness.controller.start();
  assert.deepEqual(harness.opened, [STARTED.verificationUri]);
  assert.equal(harness.states.at(-1)?.started?.userCode, STARTED.userCode);

  await harness.runNext();

  assert.equal(harness.connected, 1);
  assert.equal(harness.scheduled.length, 0);
  assert.deepEqual(harness.states.at(-1), { busy: false, started: null });
  assert.equal(harness.notices.at(-1)?.message, "Copilot connected.");
});
