import "server-only";

import { Buffer } from "node:buffer";
import { createHash, randomUUID } from "node:crypto";

const DAY_MS = 86_400_000;
const DEFAULT_SUBSCRIPTION_OVERRIDE_DAYS = 365;
const MAX_AUTH_VERSION = 2_147_483_647;
const NON_PRINTABLE_REFERENCE_CHARACTERS = /[\p{Cc}\p{Cf}\p{Cs}\p{Zl}\p{Zp}]/u;

export const MAX_SUBSCRIPTION_OVERRIDE_DAYS = 3650;
export const MAX_SUBSCRIPTION_OVERRIDE_REFERENCE_LENGTH = 128;

export type SubscriptionOverrideAction = "grant" | "revoke";

export type SubscriptionOverrideAuditRecord = {
  action: SubscriptionOverrideAction;
  createdAt: Date;
  id: string;
  newAuthVersion: number;
  newSubscribedUntil: Date | null;
  previousAuthVersion: number;
  previousSubscribedUntil: Date | null;
  referenceDigest: string;
  userId: string;
};

export type SubscriptionOverrideUser = {
  authVersion: number;
  billingPeriodStart: Date | null;
  id: string;
  subscribedUntil: Date | null;
  subscriptionOverrideAction: SubscriptionOverrideAction | null;
  subscriptionOverrideAt: Date | null;
};

export type SubscriptionOverrideUserUpdate = {
  billingPeriodStart: Date | null;
  expectedAuthVersion: number;
  expectedBillingPeriodStart: Date | null;
  expectedSubscriptionOverrideAction: SubscriptionOverrideAction | null;
  expectedSubscriptionOverrideAt: Date | null;
  expectedSubscribedUntil: Date | null;
  newAuthVersion: number;
  subscribedUntil: Date | null;
  subscriptionOverrideAction: SubscriptionOverrideAction;
  subscriptionOverrideAt: Date;
  userId: string;
};

export type SubscriptionOverrideTransaction = {
  findUserForUpdate: (
    userId: string
  ) => Promise<SubscriptionOverrideUser | null>;
  insertAudit: (record: SubscriptionOverrideAuditRecord) => Promise<void>;
  now: () => Date;
  updateUser: (input: SubscriptionOverrideUserUpdate) => Promise<boolean>;
};

export type SubscriptionOverrideStore = {
  transaction: <T>(
    callback: (transaction: SubscriptionOverrideTransaction) => Promise<T>
  ) => Promise<T>;
};

export type SubscriptionOverrideInput =
  | {
      durationDays: number;
      expectedAuthVersion: number;
      expectedBillingPeriodStart: Date | null;
      expectedSubscriptionOverrideAction: SubscriptionOverrideAction | null;
      expectedSubscriptionOverrideAt: Date | null;
      expectedSubscribedUntil: Date | null;
      operation: "grant";
      referenceDigest: string;
      userId: string;
    }
  | {
      expectedAuthVersion: number;
      expectedBillingPeriodStart: Date | null;
      expectedSubscriptionOverrideAction: SubscriptionOverrideAction | null;
      expectedSubscriptionOverrideAt: Date | null;
      expectedSubscribedUntil: Date | null;
      operation: "revoke";
      referenceDigest: string;
      userId: string;
    };

export type SubscriptionOverrideResult =
  | {
      kind: "applied";
      operation: SubscriptionOverrideAction;
      subscribedUntil: Date | null;
    }
  | { kind: "authority_changed" }
  | { kind: "user_not_found" };

export type SubscriptionCliCommand =
  | { email: string; kind: "status" }
  | {
      durationDays: number;
      email: string;
      kind: "override";
      operation: "grant";
    }
  | {
      email: string;
      kind: "override";
      operation: "revoke";
    };

export class SubscriptionOverrideInputError extends Error {}

export type SubscriptionOverrideCliDependencies = {
  applyOverride: (
    input: SubscriptionOverrideInput
  ) => Promise<SubscriptionOverrideResult>;
  findUserByEmail: (email: string) => Promise<{
    authVersion: number;
    billingPeriodStart: Date | null;
    id: string;
    subscribedUntil: Date | null;
    subscriptionOverrideAction: SubscriptionOverrideAction | null;
    subscriptionOverrideAt: Date | null;
  } | null>;
  now: () => Date;
  readReference: () => Promise<string>;
};

export type SubscriptionCliResponse = {
  code: 0 | 1 | 2;
  output: string;
};

export function parseSubscriptionCliArguments(
  args: string[]
): SubscriptionCliCommand {
  const [command, email, ...argumentsAfterEmail] = args;
  if (!(command && email)) {
    throw new SubscriptionOverrideInputError(
      "Usage: pnpm subscription <grant|revoke|status> <email> [days] --reference-stdin"
    );
  }

  if (command === "status") {
    if (argumentsAfterEmail.length !== 0) {
      throw new SubscriptionOverrideInputError(
        "Usage: pnpm subscription status <email>"
      );
    }
    return { email, kind: "status" };
  }

  if (command !== "grant" && command !== "revoke") {
    throw new SubscriptionOverrideInputError("Unknown subscription command.");
  }

  extractReferenceStdinFlag(argumentsAfterEmail);
  if (command === "revoke") {
    if (argumentsAfterEmail.length !== 0) {
      throw new SubscriptionOverrideInputError(
        "Usage: pnpm subscription revoke <email> --reference-stdin"
      );
    }
    return { email, kind: "override", operation: "revoke" };
  }

  if (argumentsAfterEmail.length > 1) {
    throw new SubscriptionOverrideInputError(
      "Usage: pnpm subscription grant <email> [days] --reference-stdin"
    );
  }
  const durationDays = parseDurationDays(
    argumentsAfterEmail[0] ?? String(DEFAULT_SUBSCRIPTION_OVERRIDE_DAYS)
  );
  return {
    durationDays,
    email,
    kind: "override",
    operation: "grant",
  };
}

export async function runSubscriptionCli(
  args: string[],
  dependencies: SubscriptionOverrideCliDependencies
): Promise<SubscriptionCliResponse> {
  let command: SubscriptionCliCommand;
  try {
    command = parseSubscriptionCliArguments(args);
  } catch (error) {
    return {
      code: 2,
      output:
        error instanceof SubscriptionOverrideInputError
          ? `${error.message}\n`
          : "Invalid subscription command.\n",
    };
  }

  if (command.kind === "status") {
    const user = await dependencies.findUserByEmail(command.email);
    if (!user) {
      return { code: 1, output: "No matching user.\n" };
    }
    const subscribed = Boolean(
      user.subscribedUntil &&
        user.subscribedUntil.getTime() > dependencies.now().getTime()
    );
    return {
      code: 0,
      output: `Subscription status: ${subscribed ? "subscriber" : "demo"} (subscribedUntil=${user.subscribedUntil?.toISOString() ?? "null"})\n`,
    };
  }

  let referenceDigest: string;
  try {
    referenceDigest = digestReference(await dependencies.readReference());
  } catch (error) {
    return {
      code: 2,
      output:
        error instanceof SubscriptionOverrideInputError
          ? `${error.message}\n`
          : "Invalid subscription reference.\n",
    };
  }

  const user = await dependencies.findUserByEmail(command.email);
  if (!user) {
    return { code: 1, output: "No matching user.\n" };
  }
  const result = await dependencies.applyOverride(
    command.operation === "grant"
      ? {
          durationDays: command.durationDays,
          expectedAuthVersion: user.authVersion,
          expectedBillingPeriodStart: user.billingPeriodStart,
          expectedSubscribedUntil: user.subscribedUntil,
          expectedSubscriptionOverrideAction: user.subscriptionOverrideAction,
          expectedSubscriptionOverrideAt: user.subscriptionOverrideAt,
          operation: "grant",
          referenceDigest,
          userId: user.id,
        }
      : {
          expectedAuthVersion: user.authVersion,
          expectedBillingPeriodStart: user.billingPeriodStart,
          expectedSubscribedUntil: user.subscribedUntil,
          expectedSubscriptionOverrideAction: user.subscriptionOverrideAction,
          expectedSubscriptionOverrideAt: user.subscriptionOverrideAt,
          operation: "revoke",
          referenceDigest,
          userId: user.id,
        }
  );
  if (result.kind === "authority_changed") {
    return {
      code: 1,
      output:
        "Subscription authority changed before override could be applied; no changes were made.\n",
    };
  }
  if (result.kind === "user_not_found") {
    return { code: 1, output: "No matching user.\n" };
  }
  return {
    code: 0,
    output:
      result.operation === "grant"
        ? `Subscription granted until ${result.subscribedUntil?.toISOString()}.\nExisting authority was invalidated.\n`
        : "Subscription revoked.\nExisting authority was invalidated.\n",
  };
}

export async function applySubscriptionOverride(
  store: SubscriptionOverrideStore,
  input: SubscriptionOverrideInput
): Promise<SubscriptionOverrideResult> {
  assertOverrideInput(input);

  return await store.transaction(async (transaction) => {
    const owner = await transaction.findUserForUpdate(input.userId);
    if (!owner) {
      return { kind: "user_not_found" };
    }
    if (
      owner.authVersion !== input.expectedAuthVersion ||
      !sameTimestamp(
        owner.billingPeriodStart,
        input.expectedBillingPeriodStart
      ) ||
      owner.subscriptionOverrideAction !==
        input.expectedSubscriptionOverrideAction ||
      !sameTimestamp(
        owner.subscriptionOverrideAt,
        input.expectedSubscriptionOverrideAt
      ) ||
      !sameTimestamp(owner.subscribedUntil, input.expectedSubscribedUntil)
    ) {
      return { kind: "authority_changed" };
    }
    if (owner.authVersion >= MAX_AUTH_VERSION) {
      throw new Error("Subscription authority version cannot be incremented.");
    }

    const now = transaction.now();
    assertValidDate(now, "override time");
    const subscribedUntil =
      input.operation === "grant"
        ? new Date(now.getTime() + input.durationDays * DAY_MS)
        : null;
    const newAuthVersion = owner.authVersion + 1;
    const updated = await transaction.updateUser({
      billingPeriodStart: input.operation === "grant" ? now : null,
      expectedAuthVersion: owner.authVersion,
      expectedBillingPeriodStart: input.expectedBillingPeriodStart,
      expectedSubscribedUntil: input.expectedSubscribedUntil,
      expectedSubscriptionOverrideAction:
        input.expectedSubscriptionOverrideAction,
      expectedSubscriptionOverrideAt: input.expectedSubscriptionOverrideAt,
      newAuthVersion,
      subscribedUntil,
      subscriptionOverrideAction: input.operation,
      subscriptionOverrideAt: now,
      userId: owner.id,
    });
    if (!updated) {
      return { kind: "authority_changed" };
    }

    await transaction.insertAudit({
      action: input.operation,
      createdAt: now,
      id: randomUUID(),
      newAuthVersion,
      newSubscribedUntil: subscribedUntil,
      previousAuthVersion: owner.authVersion,
      previousSubscribedUntil: owner.subscribedUntil,
      referenceDigest: input.referenceDigest,
      userId: owner.id,
    });
    return { kind: "applied", operation: input.operation, subscribedUntil };
  });
}

function extractReferenceStdinFlag(argumentsAfterEmail: string[]): void {
  const referenceIndex = argumentsAfterEmail.indexOf("--reference-stdin");
  if (
    referenceIndex < 0 ||
    referenceIndex !== argumentsAfterEmail.lastIndexOf("--reference-stdin")
  ) {
    throw new SubscriptionOverrideInputError(
      "Mutations require --reference-stdin."
    );
  }
  argumentsAfterEmail.splice(referenceIndex, 1);
}

function parseDurationDays(value: string): number {
  if (!/^[1-9]\d*$/u.test(value)) {
    throw new SubscriptionOverrideInputError(
      "Grant duration must be a positive whole number of days."
    );
  }
  const days = Number(value);
  if (!Number.isSafeInteger(days) || days > MAX_SUBSCRIPTION_OVERRIDE_DAYS) {
    throw new SubscriptionOverrideInputError(
      `Grant duration must not exceed ${MAX_SUBSCRIPTION_OVERRIDE_DAYS} days.`
    );
  }
  return days;
}

function assertOverrideInput(input: SubscriptionOverrideInput): void {
  assertReferenceDigest(input.referenceDigest);
  if (
    !Number.isInteger(input.expectedAuthVersion) ||
    input.expectedAuthVersion < 0 ||
    input.expectedAuthVersion >= MAX_AUTH_VERSION
  ) {
    throw new SubscriptionOverrideInputError(
      "Subscription authority version is invalid."
    );
  }
  if (input.operation === "grant") {
    parseDurationDays(String(input.durationDays));
  }
}

export async function readSubscriptionOverrideReference(
  input: AsyncIterable<Uint8Array>
): Promise<string> {
  const referenceBytes: number[] = [];
  let pendingCarriageReturn = false;
  const iterator = input[Symbol.asyncIterator]();
  let iteratorFinished = false;

  try {
    while (true) {
      // Async iterator chunks must be read in order.
      // biome-ignore lint/performance/noAwaitInLoops: sequential consumption is required.
      const { done, value: chunk } = await iterator.next();
      if (done) {
        iteratorFinished = true;
        if (pendingCarriageReturn) {
          throwInvalidReference();
        }
        return decodeReference(referenceBytes);
      }

      for (let index = 0; index < chunk.length; index += 1) {
        const byte = chunk[index];
        if (pendingCarriageReturn) {
          if (byte !== 0x0a) {
            throwInvalidReference();
          }
          if (index !== chunk.length - 1) {
            throwInvalidReference();
          }
          return decodeReference(referenceBytes);
        }
        if (byte === 0x0a) {
          if (index !== chunk.length - 1) {
            throwInvalidReference();
          }
          return decodeReference(referenceBytes);
        }
        if (byte === 0x0d) {
          pendingCarriageReturn = true;
          continue;
        }
        if (
          byte < 0x20 ||
          referenceBytes.length >= MAX_SUBSCRIPTION_OVERRIDE_REFERENCE_LENGTH
        ) {
          throwInvalidReference();
        }
        referenceBytes.push(byte);
      }
    }
  } finally {
    if (!iteratorFinished) {
      await iterator.return?.();
    }
  }
}

function decodeReference(referenceBytes: number[]): string {
  let reference: string;
  try {
    reference = new TextDecoder("utf-8", { fatal: true }).decode(
      Uint8Array.from(referenceBytes)
    );
  } catch {
    throwInvalidReference();
  }
  assertReference(reference);
  return reference;
}

function assertReference(reference: string): void {
  if (
    reference.length === 0 ||
    Buffer.byteLength(reference, "utf8") >
      MAX_SUBSCRIPTION_OVERRIDE_REFERENCE_LENGTH ||
    reference.trim() !== reference ||
    NON_PRINTABLE_REFERENCE_CHARACTERS.test(reference)
  ) {
    throw new SubscriptionOverrideInputError(
      "External reference must be a bounded printable value."
    );
  }
}

function assertReferenceDigest(referenceDigest: string): void {
  if (!/^[0-9a-f]{64}$/u.test(referenceDigest)) {
    throw new SubscriptionOverrideInputError(
      "External reference digest is invalid."
    );
  }
}

function throwInvalidReference(): never {
  throw new SubscriptionOverrideInputError(
    "External reference must be a bounded printable value."
  );
}

function assertValidDate(value: Date, label: string): void {
  if (!Number.isFinite(value.getTime())) {
    throw new Error(`Subscription ${label} is invalid.`);
  }
}

function sameTimestamp(left: Date | null, right: Date | null): boolean {
  return (
    left === right ||
    (left !== null && right !== null && left.getTime() === right.getTime())
  );
}

function digestReference(reference: string): string {
  assertReference(reference);
  return createHash("sha256").update(reference, "utf8").digest("hex");
}
