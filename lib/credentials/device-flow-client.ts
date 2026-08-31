import { parseRetryAfter } from "../http/retry-after";
import {
  createDeviceFlowAttempt,
  type StartedDeviceFlow,
} from "./device-flow-attempt";

const DEVICE_FLOW_DEADLINE_MS = 15 * 60_000;
const MAX_POLL_INTERVAL_MS = 60_000;
const MAX_TRANSIENT_RETRY_MS = MAX_POLL_INTERVAL_MS;
const MIN_RETRY_MS = 1000;

export type DeviceFlowAuthorityContext = Readonly<{
  key: string;
  revision: string | null;
  valid: boolean;
}>;

export type DeviceFlowViewState = Readonly<{
  busy: boolean;
  started: StartedDeviceFlow | null;
}>;

export type DeviceFlowNotice = Readonly<{
  message: string;
  type: "error" | "success";
}>;

type DeviceFlowControllerDependencies = Readonly<{
  cancel: (handle: unknown) => void;
  deviceEndpoint: string;
  fetcher: typeof fetch;
  generateKey: () => string;
  getAuthority: () => DeviceFlowAuthorityContext;
  now?: () => number;
  onAuthorityInvalidated: (revision: string) => void;
  onConnected: () => void;
  onNotice: (notice: DeviceFlowNotice) => void;
  onOpenVerification: (uri: string) => void;
  onState: (state: DeviceFlowViewState) => void;
  schedule: (callback: () => Promise<void> | void, delay: number) => unknown;
}>;

export type DeviceFlowController = Readonly<{
  authorityChanged: (authority: DeviceFlowAuthorityContext) => void;
  dispose: () => void;
  start: () => Promise<void>;
  stop: () => void;
}>;

type ActiveFlow = {
  authority: DeviceFlowAuthorityContext;
  deadline: number;
  generation: number;
  pollIntervalMs: number;
  transientRetryMs: number;
};

type PollStatus = "authorized" | "denied" | "expired" | "pending" | "slow_down";

function isRecord(value: unknown): value is Record<string, unknown> {
  return Boolean(value && typeof value === "object");
}

function startedDeviceFlow(value: unknown): StartedDeviceFlow | null {
  if (!isRecord(value)) {
    return null;
  }
  const { deviceCode, interval, userCode, verificationUri } = value;
  if (
    typeof deviceCode !== "string" ||
    !deviceCode ||
    typeof interval !== "number" ||
    !Number.isFinite(interval) ||
    interval <= 0 ||
    typeof userCode !== "string" ||
    !userCode ||
    typeof verificationUri !== "string" ||
    !verificationUri
  ) {
    return null;
  }
  return { deviceCode, interval, userCode, verificationUri };
}

function pollStatus(value: unknown): PollStatus | null {
  if (!isRecord(value) || typeof value.status !== "string") {
    return null;
  }
  if (
    value.status === "authorized" ||
    value.status === "denied" ||
    value.status === "expired" ||
    value.status === "pending" ||
    value.status === "slow_down"
  ) {
    return value.status;
  }
  return null;
}

async function responseJson(response: Response): Promise<unknown> {
  try {
    return await response.json();
  } catch {
    return null;
  }
}

function boundedPollInterval(intervalSeconds: number): number {
  return Math.max(
    MIN_RETRY_MS,
    Math.min(MAX_POLL_INTERVAL_MS, Math.round(intervalSeconds * 1000))
  );
}

export function createDeviceFlowController(
  dependencies: DeviceFlowControllerDependencies
): DeviceFlowController {
  const now = dependencies.now ?? Date.now;
  const startAttempt = createDeviceFlowAttempt(dependencies.generateKey);
  const invalidatedAuthorities = new Set<string>();
  let active: ActiveFlow | null = null;
  let generation = 0;
  let requestController: AbortController | null = null;
  let stopped = true;
  let timer: unknown = null;

  const clearTimer = () => {
    if (timer !== null) {
      dependencies.cancel(timer);
      timer = null;
    }
  };

  const clearRequest = () => {
    requestController?.abort();
    requestController = null;
  };

  const publishIdle = () => {
    dependencies.onState({ busy: false, started: null });
  };

  const stopActive = ({
    invalidate = false,
    notice,
    resetAttempt = false,
  }: {
    invalidate?: boolean;
    notice?: DeviceFlowNotice;
    resetAttempt?: boolean;
  } = {}) => {
    const authority = active?.authority ?? dependencies.getAuthority();
    stopped = true;
    generation += 1;
    active = null;
    clearTimer();
    clearRequest();
    if (resetAttempt) {
      startAttempt.reset();
    }
    publishIdle();
    if (notice) {
      dependencies.onNotice(notice);
    }
    if (
      invalidate &&
      authority.revision &&
      !invalidatedAuthorities.has(authority.key)
    ) {
      invalidatedAuthorities.add(authority.key);
      dependencies.onAuthorityInvalidated(authority.revision);
    }
  };

  const isCurrent = (flow: ActiveFlow): boolean => {
    const authority = dependencies.getAuthority();
    return (
      !stopped &&
      active === flow &&
      generation === flow.generation &&
      authority.valid &&
      authority.key === flow.authority.key
    );
  };

  const timeout = () => {
    stopActive({
      notice: {
        message: "GitHub connection timed out. Start again.",
        type: "error",
      },
    });
  };

  const scheduleWithinDeadline = (
    flow: ActiveFlow,
    callback: () => Promise<void>,
    requestedDelay: number
  ) => {
    if (!isCurrent(flow)) {
      return;
    }
    const remaining = flow.deadline - now();
    if (remaining <= 0) {
      timeout();
      return;
    }
    clearTimer();
    const delay = Math.max(0, requestedDelay);
    if (delay >= remaining) {
      timer = dependencies.schedule(() => {
        timer = null;
        if (isCurrent(flow)) {
          timeout();
        }
      }, remaining);
      return;
    }
    timer = dependencies.schedule(async () => {
      timer = null;
      if (isCurrent(flow)) {
        await callback();
      }
    }, delay);
  };

  const armRequestDeadline = (
    flow: ActiveFlow,
    controller: AbortController
  ): boolean => {
    const remaining = flow.deadline - now();
    if (remaining <= 0) {
      timeout();
      return false;
    }
    clearTimer();
    timer = dependencies.schedule(() => {
      timer = null;
      if (isCurrent(flow) && requestController === controller) {
        controller.abort();
        timeout();
      }
    }, remaining);
    return true;
  };

  const transientDelay = (flow: ActiveFlow, minimum: number): number => {
    const delay = Math.max(minimum, flow.transientRetryMs);
    flow.transientRetryMs = Math.min(
      MAX_TRANSIENT_RETRY_MS,
      Math.max(MIN_RETRY_MS, flow.transientRetryMs * 2)
    );
    return Math.min(MAX_TRANSIENT_RETRY_MS, delay);
  };

  const retryAfterDelay = (response: Response, flow: ActiveFlow): number => {
    const parsed = parseRetryAfter(response.headers.get("retry-after"), now());
    if (parsed.kind === "valid" || parsed.kind === "excessive") {
      return Math.max(MIN_RETRY_MS, (parsed.retryAt ?? flow.deadline) - now());
    }
    return transientDelay(flow, MIN_RETRY_MS);
  };

  const subscriptionRequired = () => {
    stopActive({
      invalidate: true,
      notice: {
        message: "Subscription required to connect GitHub Copilot.",
        type: "error",
      },
      resetAttempt: true,
    });
  };

  const signInRequired = () => {
    stopActive({
      notice: {
        message:
          "Your sign-in expired. Sign in again to connect GitHub Copilot.",
        type: "error",
      },
      resetAttempt: true,
    });
  };

  const invalidResponse = () => {
    stopActive({
      notice: {
        message: "GitHub returned an invalid connection response. Try again.",
        type: "error",
      },
      resetAttempt: true,
    });
  };

  const terminalHttpError = (
    operation: "continue" | "start",
    status: number
  ) => {
    stopActive({
      notice: {
        message:
          operation === "start"
            ? `GitHub could not start the connection (HTTP ${status}). Try again.`
            : `GitHub could not continue the connection (HTTP ${status}). Try again.`,
        type: "error",
      },
      resetAttempt: operation === "start",
    });
  };

  const poll = async (flow: ActiveFlow, session: StartedDeviceFlow) => {
    if (!isCurrent(flow)) {
      return;
    }
    const controller = new AbortController();
    requestController = controller;
    if (!armRequestDeadline(flow, controller)) {
      return;
    }
    let response: Response;
    try {
      response = await dependencies.fetcher(dependencies.deviceEndpoint, {
        body: JSON.stringify({ deviceCode: session.deviceCode }),
        headers: { "content-type": "application/json" },
        method: "PUT",
        signal: controller.signal,
      });
    } catch {
      if (!isCurrent(flow)) {
        return;
      }
      clearTimer();
      if (requestController === controller) {
        requestController = null;
      }
      scheduleWithinDeadline(
        flow,
        () => poll(flow, session),
        transientDelay(flow, flow.pollIntervalMs)
      );
      return;
    }
    if (!isCurrent(flow)) {
      return;
    }

    if (response.status === 403) {
      subscriptionRequired();
      return;
    }
    if (response.status === 401) {
      signInRequired();
      return;
    }
    if (response.status === 429) {
      requestController = null;
      scheduleWithinDeadline(
        flow,
        () => poll(flow, session),
        retryAfterDelay(response, flow)
      );
      return;
    }
    if (response.status >= 500 && response.status <= 599) {
      requestController = null;
      scheduleWithinDeadline(
        flow,
        () => poll(flow, session),
        transientDelay(flow, flow.pollIntervalMs)
      );
      return;
    }
    if (!response.ok) {
      terminalHttpError("continue", response.status);
      return;
    }

    const status = pollStatus(await responseJson(response));
    if (!isCurrent(flow)) {
      return;
    }
    clearTimer();
    requestController = null;
    if (!status) {
      invalidResponse();
      return;
    }
    flow.transientRetryMs = MIN_RETRY_MS;

    if (status === "authorized") {
      stopActive({
        notice: { message: "Copilot connected.", type: "success" },
      });
      dependencies.onConnected();
      return;
    }
    if (status === "denied") {
      stopActive({
        notice: { message: "Authorization was declined.", type: "error" },
      });
      return;
    }
    if (status === "expired") {
      stopActive({
        notice: { message: "That code expired. Try again.", type: "error" },
      });
      return;
    }
    if (status === "slow_down") {
      flow.pollIntervalMs = Math.min(
        MAX_POLL_INTERVAL_MS,
        flow.pollIntervalMs + 5000
      );
    }
    scheduleWithinDeadline(
      flow,
      () => poll(flow, session),
      flow.pollIntervalMs
    );
  };

  const startRequest = async (flow: ActiveFlow) => {
    if (!isCurrent(flow)) {
      return;
    }
    const controller = new AbortController();
    requestController = controller;
    if (!armRequestDeadline(flow, controller)) {
      return;
    }
    let response: Response;
    try {
      response = await dependencies.fetcher(dependencies.deviceEndpoint, {
        headers: { "idempotency-key": startAttempt.key() },
        method: "POST",
        signal: controller.signal,
      });
    } catch {
      if (!isCurrent(flow)) {
        return;
      }
      clearTimer();
      if (requestController === controller) {
        requestController = null;
      }
      scheduleWithinDeadline(
        flow,
        () => startRequest(flow),
        transientDelay(flow, MIN_RETRY_MS)
      );
      return;
    }
    if (!isCurrent(flow)) {
      return;
    }

    if (response.status === 403) {
      subscriptionRequired();
      return;
    }
    if (response.status === 401) {
      signInRequired();
      return;
    }
    if (response.status === 429) {
      requestController = null;
      scheduleWithinDeadline(
        flow,
        () => startRequest(flow),
        retryAfterDelay(response, flow)
      );
      return;
    }
    if (response.status >= 500 && response.status <= 599) {
      requestController = null;
      scheduleWithinDeadline(
        flow,
        () => startRequest(flow),
        transientDelay(flow, MIN_RETRY_MS)
      );
      return;
    }
    if (!response.ok) {
      terminalHttpError("start", response.status);
      return;
    }

    const session = startedDeviceFlow(await responseJson(response));
    if (!isCurrent(flow)) {
      return;
    }
    clearTimer();
    requestController = null;
    if (!session) {
      invalidResponse();
      return;
    }

    startAttempt.reset();
    flow.pollIntervalMs = boundedPollInterval(session.interval);
    flow.transientRetryMs = MIN_RETRY_MS;
    dependencies.onState({ busy: false, started: session });
    dependencies.onOpenVerification(session.verificationUri);
    scheduleWithinDeadline(
      flow,
      () => poll(flow, session),
      flow.pollIntervalMs
    );
  };

  return {
    authorityChanged(authority) {
      if (!active || stopped) {
        return;
      }
      if (!authority.valid || authority.key !== active.authority.key) {
        stopActive();
      }
    },
    dispose() {
      stopActive();
    },
    async start() {
      stopActive();
      const authority = dependencies.getAuthority();
      if (!authority.valid) {
        dependencies.onNotice({
          message: "Subscription required to connect GitHub Copilot.",
          type: "error",
        });
        return;
      }
      stopped = false;
      generation += 1;
      const flow: ActiveFlow = {
        authority,
        deadline: now() + DEVICE_FLOW_DEADLINE_MS,
        generation,
        pollIntervalMs: MIN_RETRY_MS,
        transientRetryMs: MIN_RETRY_MS,
      };
      active = flow;
      dependencies.onState({ busy: true, started: null });
      await startRequest(flow);
    },
    stop() {
      stopActive();
    },
  };
}
