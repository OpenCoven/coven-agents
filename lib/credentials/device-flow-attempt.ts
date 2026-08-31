import { browserApplicationPath } from "@/lib/application-path";

export type DeviceFlowAttempt = {
  key: () => string;
  reset: () => void;
};

export type StartedDeviceFlow = {
  binding: string;
  deviceCode: string;
  interval: number;
  userCode: string;
  verificationUri: string;
};

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
  };
}

export async function requestDeviceFlowStart(input: {
  attempt: DeviceFlowAttempt;
  fetcher: typeof fetch;
}): Promise<StartedDeviceFlow> {
  const response = await input.fetcher(
    browserApplicationPath("/api/credentials/device"),
    {
      headers: { "idempotency-key": input.attempt.key() },
      method: "POST",
    }
  );

  if (!response.ok) {
    throw new Error(String(response.status));
  }

  const started = (await response.json()) as StartedDeviceFlow;
  input.attempt.reset();
  return started;
}
