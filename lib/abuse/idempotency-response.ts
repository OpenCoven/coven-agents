import {
  decryptCredential,
  encryptCredential,
  type SealedCredential,
  validateKekVersion,
} from "../credentials/envelope";

export type JsonValue =
  | JsonValue[]
  | boolean
  | null
  | number
  | string
  | { [key: string]: JsonValue };

export type StoredIdempotencyResponseEnvelope =
  | {
      body: JsonValue;
      kind: "plain_json";
    }
  | {
      kind: "encrypted_json";
      payload: SealedCredential;
    };

export type IdempotencyResponseContext = {
  operation: string;
  ownerId: string;
};

export type IdempotencyResponseStorage = {
  replay: (
    envelope: StoredIdempotencyResponseEnvelope,
    context: IdempotencyResponseContext
  ) => Promise<JsonValue>;
  store: (
    body: JsonValue,
    context: IdempotencyResponseContext
  ) => Promise<StoredIdempotencyResponseEnvelope>;
};

export const plaintextIdempotencyResponseStorage: IdempotencyResponseStorage = {
  replay(envelope) {
    if (envelope.kind !== "plain_json" || !isJsonValue(envelope.body)) {
      return Promise.reject(new Error("Invalid plaintext response envelope."));
    }
    return Promise.resolve(envelope.body);
  },
  store(body) {
    return Promise.resolve({ body, kind: "plain_json" });
  },
};

export function encryptedIdempotencyResponseStorage(
  kek: (version?: string) => Promise<CryptoKey>,
  kekVersion: () => Promise<string> = () => Promise.resolve("v1")
): IdempotencyResponseStorage {
  return {
    async replay(envelope, context) {
      if (envelope.kind !== "encrypted_json") {
        throw new Error("Invalid encrypted response envelope.");
      }

      const plaintext = await decryptCredential(
        envelope.payload,
        await kek(envelope.payload.kekVersion)
      );
      const stored = parseEncryptedResponse(plaintext);
      if (
        stored.ownerId !== context.ownerId ||
        stored.operation !== context.operation
      ) {
        throw new Error(
          "Encrypted response does not belong to this idempotency claim."
        );
      }
      return stored.body;
    },
    async store(body, context) {
      const plaintext = JSON.stringify({
        body,
        operation: context.operation,
        ownerId: context.ownerId,
        version: 1,
      });
      const version = validateKekVersion(await kekVersion());
      return {
        kind: "encrypted_json",
        payload: await encryptCredential(plaintext, await kek(), version),
      };
    },
  };
}

function parseEncryptedResponse(value: string): {
  body: JsonValue;
  operation: string;
  ownerId: string;
} {
  const parsed: unknown = JSON.parse(value);
  if (
    !isRecord(parsed) ||
    parsed.version !== 1 ||
    typeof parsed.operation !== "string" ||
    typeof parsed.ownerId !== "string" ||
    !isJsonValue(parsed.body)
  ) {
    throw new Error("Invalid encrypted response payload.");
  }
  return {
    body: parsed.body,
    operation: parsed.operation,
    ownerId: parsed.ownerId,
  };
}

function isJsonValue(value: unknown): value is JsonValue {
  if (
    value === null ||
    typeof value === "boolean" ||
    typeof value === "string"
  ) {
    return true;
  }
  if (typeof value === "number") {
    return Number.isFinite(value);
  }
  if (Array.isArray(value)) {
    return value.every(isJsonValue);
  }
  return (
    isRecord(value) && Object.values(value).every((entry) => isJsonValue(entry))
  );
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return value !== null && typeof value === "object" && !Array.isArray(value);
}
