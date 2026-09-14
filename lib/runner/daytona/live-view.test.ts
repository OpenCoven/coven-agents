import assert from "node:assert/strict";
import test from "node:test";
import { DaytonaNotFoundError, DaytonaTimeoutError } from "@daytona/sdk";
import type { RunSnapshot } from "@opencoven/agent-contracts";
import {
  DAYTONA_LIVE_VIEW_TTL_SECONDS,
  DAYTONA_NOVNC_PORT,
  type DaytonaLiveViewSandbox,
  daytonaLiveViewProvider,
  liveViewEnabledFromEnvironment,
} from "./live-view";
import { daytonaSandboxName } from "./names";

const TENANT = "u_0123456789abcdef0123456789abcdef";
const RUN: RunSnapshot = {
  agentId: "11111111-1111-4111-8111-111111111111",
  apiVersion: "1.0",
  commandEvidence: [],
  completedAt: null,
  createdAt: "2026-09-13T00:00:00.000Z",
  fileEvidence: [],
  id: "22222222-2222-4222-8222-222222222222",
  operationId: "33333333-3333-4333-8333-333333333333",
  output: "",
  startedAt: "2026-09-13T00:00:05.000Z",
  status: "running",
  task: "Watch me.",
};

function sandbox(
  overrides: Partial<{
    getStatus: DaytonaLiveViewSandbox["computerUse"]["getStatus"];
    start: DaytonaLiveViewSandbox["computerUse"]["start"];
    signed: DaytonaLiveViewSandbox["getSignedPreviewUrl"];
  }> = {},
  calls: string[] = []
): DaytonaLiveViewSandbox {
  return {
    computerUse: {
      getStatus:
        overrides.getStatus ??
        (() => {
          calls.push("status");
          return Promise.resolve({ status: "inactive" });
        }),
      start:
        overrides.start ??
        (() => {
          calls.push("start");
          return Promise.resolve({});
        }),
    },
    getSignedPreviewUrl:
      overrides.signed ??
      ((port, ttl) => {
        calls.push(`sign:${port}:${ttl}`);
        return Promise.resolve({
          url: "https://6080-sandbox.proxy.daytona.works/?tkn=abc",
        });
      }),
  };
}

test("the live view is off unless the environment turns it on", () => {
  const env = (value?: string) =>
    ({ RUNNER_LIVE_VIEW: value }) as unknown as NodeJS.ProcessEnv;
  assert.equal(liveViewEnabledFromEnvironment(env()), false);
  assert.equal(liveViewEnabledFromEnvironment(env("0")), false);
  assert.equal(liveViewEnabledFromEnvironment(env("1")), true);
  assert.equal(liveViewEnabledFromEnvironment(env(" TRUE ")), true);
});

test("a disabled provider never touches the sandbox", async () => {
  let resolved = 0;
  const view = daytonaLiveViewProvider({
    enabled: false,
    get: () => {
      resolved += 1;
      return Promise.resolve(sandbox());
    },
  });
  assert.deepEqual(await view({ run: RUN, tenant: TENANT }), {
    kind: "unavailable",
    reason: "not_configured",
  });
  assert.equal(resolved, 0);
});

test("a ready view starts the desktop when it is down and signs the noVNC port", async () => {
  const calls: string[] = [];
  const names: string[] = [];
  const view = daytonaLiveViewProvider({
    clock: () => new Date("2026-09-13T00:01:00.000Z"),
    enabled: true,
    get: (name) => {
      names.push(name);
      return Promise.resolve(sandbox({}, calls));
    },
  });

  const result = await view({ run: RUN, tenant: TENANT });

  assert.deepEqual(names, [daytonaSandboxName(TENANT, RUN.agentId)]);
  assert.deepEqual(calls, [
    "status",
    "start",
    `sign:${DAYTONA_NOVNC_PORT}:${DAYTONA_LIVE_VIEW_TTL_SECONDS}`,
  ]);
  assert.deepEqual(result, {
    expiresAt: "2026-09-13T00:06:00.000Z",
    kind: "ready",
    url: "https://6080-sandbox.proxy.daytona.works/?tkn=abc",
  });
});

test("an already-active desktop is not restarted", async () => {
  const calls: string[] = [];
  const view = daytonaLiveViewProvider({
    enabled: true,
    get: async () =>
      sandbox(
        {
          getStatus: () => {
            calls.push("status");
            return Promise.resolve({ status: "active" });
          },
        },
        calls
      ),
  });
  const result = await view({ run: RUN, tenant: TENANT });
  assert.equal(result.kind, "ready");
  assert.deepEqual(calls, [
    "status",
    `sign:${DAYTONA_NOVNC_PORT}:${DAYTONA_LIVE_VIEW_TTL_SECONDS}`,
  ]);
});

test("missing sandboxes, headless images, and provider outages are told apart without leaking detail", async () => {
  const missing = daytonaLiveViewProvider({
    enabled: true,
    get: () =>
      Promise.reject(new DaytonaNotFoundError("private sandbox detail")),
  });
  assert.deepEqual(await missing({ run: RUN, tenant: TENANT }), {
    kind: "unavailable",
    reason: "sandbox_missing",
  });

  const outage = daytonaLiveViewProvider({
    enabled: true,
    get: () =>
      Promise.reject(new DaytonaTimeoutError("private timeout detail")),
  });
  assert.deepEqual(await outage({ run: RUN, tenant: TENANT }), {
    kind: "unavailable",
    reason: "provider_unavailable",
  });

  const headless = daytonaLiveViewProvider({
    enabled: true,
    get: async () =>
      sandbox({
        start: () => Promise.reject(new Error("xvfb: command not found")),
      }),
  });
  assert.deepEqual(await headless({ run: RUN, tenant: TENANT }), {
    kind: "unavailable",
    reason: "desktop_unavailable",
  });

  const unsigned = daytonaLiveViewProvider({
    enabled: true,
    get: async () =>
      sandbox({
        signed: () => Promise.reject(new Error("private signing detail")),
      }),
  });
  assert.deepEqual(await unsigned({ run: RUN, tenant: TENANT }), {
    kind: "unavailable",
    reason: "provider_unavailable",
  });
});
