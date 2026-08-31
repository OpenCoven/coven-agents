import {
  type IdempotencyResponse,
  type IdempotencyResult,
  type IdempotencyStore,
  runIdempotentOperation,
} from "../abuse/idempotency";
import type { DeviceExchange } from "./github-device";
import type { StoredCredential } from "./shape";

export const CREDENTIAL_DEVICE_POLL_RETENTION_MS = 20 * 60_000;

type DevicePollExchange = DeviceExchange | { kind: "unavailable" };

export function runCredentialDevicePoll(input: {
  deviceCode: string;
  exchange: () => Promise<DevicePollExchange>;
  idempotencyKey: string | null;
  ownerId: string;
  store: IdempotencyStore;
  storeCredential: (credential: StoredCredential) => Promise<void>;
}): Promise<IdempotencyResult> {
  return runIdempotentOperation({
    idempotencyKey: input.idempotencyKey,
    operation: "credential_device_poll",
    ownerId: input.ownerId,
    perform: async (): Promise<IdempotencyResponse> => {
      const exchange = await input.exchange();
      if (exchange.kind === "unavailable") {
        return {
          body: { error: "github_unconfigured" },
          status: 503,
        };
      }
      if (exchange.kind !== "authorized") {
        return {
          body: { status: exchange.kind },
          status: 200,
        };
      }

      await input.storeCredential(exchange.credential);
      return {
        body: { status: "authorized" },
        status: 200,
      };
    },
    request: { deviceCode: input.deviceCode },
    retentionMs: CREDENTIAL_DEVICE_POLL_RETENTION_MS,
    shouldCacheResponse: ({ body }) =>
      typeof body === "object" &&
      body !== null &&
      !Array.isArray(body) &&
      body.status === "authorized",
    store: input.store,
  });
}
