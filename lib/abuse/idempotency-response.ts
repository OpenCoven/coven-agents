import {
  decryptCredential,
  encryptCredential,
  type SealedCredential,
  validateKekVersion,
} from "../credentials/envelope";

const MAX_ENVELOPE_FIELD_LENGTH = 2_000_000;
const LEGACY_ENCRYPTED_PAYLOAD_KEYS = [
  "ciphertext",
  "iv",
  "wrappedKey",
] as const;
const VERSIONED_ENCRYPTED_PAYLOAD_KEYS = [
  ...LEGACY_ENCRYPTED_PAYLOAD_KEYS,
  "kekVersion",
] as const;

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

/**
 * Normalizes data read from the JSONB boundary. Before KEK versions were
 * stored, encrypted idempotency payloads had exactly three fields; that
 * shape is a one-time, explicit v1 migration and is never treated as a
 * request to try an arbitrary configured key.
 */
export function parseStoredIdempotencyResponseEnvelope(
  value: unknown
): StoredIdempotencyResponseEnvelope {
  if (!isRecord(value) || typeof value.kind !== "string") {
    throw new Error("Invalid idempotency response envelope.");
  }

  if (value.kind === "plain_json") {
    if (!hasOnlyKeys(value, ["body", "kind"]) || !isJsonValue(value.body)) {
      throw new Error("Invalid plaintext response envelope.");
    }
    return { body: value.body, kind: "plain_json" };
  }

  if (value.kind === "encrypted_json") {
    if (!hasOnlyKeys(value, ["kind", "payload"])) {
      throw new Error("Invalid encrypted response envelope.");
    }
    return {
      kind: "encrypted_json",
      payload: parseEncryptedPayload(value.payload),
    };
  }

  throw new Error("Invalid idempotency response envelope.");
}

export const plaintextIdempotencyResponseStorage: IdempotencyResponseStorage = {
  replay(envelope) {
    const parsed = parseStoredIdempotencyResponseEnvelope(envelope);
    if (parsed.kind !== "plain_json") {
      return Promise.reject(new Error("Invalid plaintext response envelope."));
    }
    return Promise.resolve(parsed.body);
  },
  store(body) {
    return Promise.resolve({ body, kind: "plain_json" });
  },
};

export function encryptedIdempotencyResponseStorage(
  kek: (version: string) => Promise<CryptoKey>,
  kekVersion: () => Promise<string>
): IdempotencyResponseStorage {
  return {
    async replay(envelope, context) {
      const parsedEnvelope = parseStoredIdempotencyResponseEnvelope(envelope);
      if (parsedEnvelope.kind !== "encrypted_json") {
        throw new Error("Invalid encrypted response envelope.");
      }

      const plaintext = await decryptCredential(
        parsedEnvelope.payload,
        await kek(parsedEnvelope.payload.kekVersion)
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
      const key = await kek(version);
      return {
        kind: "encrypted_json",
        payload: await encryptCredential(plaintext, key, version),
      };
    },
  };
}

function parseEncryptedPayload(value: unknown): SealedCredential {
  if (!isRecord(value)) {
    throw new Error("Invalid encrypted response payload.");
  }

  if (!Object.hasOwn(value, "kekVersion")) {
    if (!hasOnlyKeys(value, LEGACY_ENCRYPTED_PAYLOAD_KEYS)) {
      throw new Error("Invalid legacy encrypted response payload.");
    }
    return {
      ciphertext: boundedString(value.ciphertext, "ciphertext"),
      iv: boundedString(value.iv, "iv"),
      kekVersion: "v1",
      wrappedKey: boundedString(value.wrappedKey, "wrappedKey"),
    };
  }

  if (!hasOnlyKeys(value, VERSIONED_ENCRYPTED_PAYLOAD_KEYS)) {
    throw new Error("Invalid encrypted response payload.");
  }
  return {
    ciphertext: boundedString(value.ciphertext, "ciphertext"),
    iv: boundedString(value.iv, "iv"),
    kekVersion: validateKekVersion(value.kekVersion),
    wrappedKey: boundedString(value.wrappedKey, "wrappedKey"),
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

function boundedString(value: unknown, name: string): string {
  if (
    typeof value !== "string" ||
    value.length === 0 ||
    value.length > MAX_ENVELOPE_FIELD_LENGTH
  ) {
    throw new Error(`${name} is invalid.`);
  }
  return value;
}

function hasOnlyKeys(
  value: Record<string, unknown>,
  keys: readonly string[]
): boolean {
  const actual = Object.keys(value).sort();
  const expected = [...keys].sort();
  return (
    actual.length === expected.length &&
    actual.every((key, index) => key === expected[index])
  );
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return value !== null && typeof value === "object" && !Array.isArray(value);
}
