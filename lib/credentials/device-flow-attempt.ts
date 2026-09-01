import { browserApplicationPath } from "@/lib/application-path";

export type DeviceFlowAttempt = {
  key: () => string;
  reset: () => void;
  resetIfOwned: (key: string) => boolean;
};

export type StartedDeviceFlow = {
  binding: string;
  deviceCode: string;
  interval: number;
  userCode: string;
  verificationUri: string;
};

export class DeviceFlowRequestError extends Error {
  readonly status: number;

  constructor(status: number) {
    super(String(status));
    this.name = "DeviceFlowRequestError";
    this.status = status;
  }
}

export function createDeviceFlowAttempt(
  generateKey: () => string
): DeviceFlowAttempt {
  let idempotencyKey: string | null = null;

  return {
    key() {
      idempotencyKey ??= generateKey();
      return idempotencyKey;
    },
    reset() {
      idempotencyKey = null;
    },
    resetIfOwned(key) {
      if (idempotencyKey !== key) {
        return false;
      }
      idempotencyKey = null;
      return true;
    },
  };
}

export async function requestDeviceFlowStart(input: {
  attempt: DeviceFlowAttempt;
  fetcher: typeof fetch;
}): Promise<StartedDeviceFlow> {
  const idempotencyKey = input.attempt.key();
  const response = await input.fetcher(
    browserApplicationPath("/api/credentials/device"),
    {
      headers: { "idempotency-key": idempotencyKey },
      method: "POST",
    }
  );

  if (!response.ok) {
    throw new DeviceFlowRequestError(response.status);
  }

  const started = (await response.json()) as StartedDeviceFlow;
  input.attempt.resetIfOwned(idempotencyKey);
  return started;
}
