import "server-only";

import { createHash, randomUUID } from "node:crypto";

const DAY_MS = 86_400_000;
const DEFAULT_SUBSCRIPTION_OVERRIDE_DAYS = 365;
const MAX_AUTH_VERSION = 2_147_483_647;

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
};

export type SubscriptionOverrideUserUpdate = {
  billingPeriodStart: Date | null;
  expectedAuthVersion: number;
  newAuthVersion: number;
  subscribedUntil: Date | null;
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
      operation: "grant";
      reference: string;
      userId: string;
    }
  | {
      expectedAuthVersion: number;
      operation: "revoke";
      reference: string;
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
      reference: string;
    }
  | {
      email: string;
      kind: "override";
      operation: "revoke";
      reference: string;
    };

export class SubscriptionOverrideInputError extends Error {}

export type SubscriptionOverrideCliDependencies = {
  applyOverride: (
    input: SubscriptionOverrideInput
  ) => Promise<SubscriptionOverrideResult>;
  findUserByEmail: (email: string) => Promise<{
    authVersion: number;
    id: string;
    subscribedUntil: Date | null;
  } | null>;
  now: () => Date;
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
      "Usage: pnpm subscription <grant|revoke|status> <email> [days] --reference <value>"
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

  const reference = extractReference(argumentsAfterEmail);
  if (command === "revoke") {
    if (argumentsAfterEmail.length !== 0) {
      throw new SubscriptionOverrideInputError(
        "Usage: pnpm subscription revoke <email> --reference <value>"
      );
    }
    return { email, kind: "override", operation: "revoke", reference };
  }

  if (argumentsAfterEmail.length > 1) {
    throw new SubscriptionOverrideInputError(
      "Usage: pnpm subscription grant <email> [days] --reference <value>"
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
    reference,
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

  const user = await dependencies.findUserByEmail(command.email);
  if (!user) {
    return { code: 1, output: "No matching user.\n" };
  }
  if (command.kind === "status") {
    const subscribed = Boolean(
      user.subscribedUntil &&
        user.subscribedUntil.getTime() > dependencies.now().getTime()
    );
    return {
      code: 0,
      output: `Subscription status: ${subscribed ? "subscriber" : "demo"} (subscribedUntil=${user.subscribedUntil?.toISOString() ?? "null"})\n`,
    };
  }

  const result = await dependencies.applyOverride(
    command.operation === "grant"
      ? {
          durationDays: command.durationDays,
          expectedAuthVersion: user.authVersion,
          operation: "grant",
          reference: command.reference,
          userId: user.id,
        }
      : {
          expectedAuthVersion: user.authVersion,
          operation: "revoke",
          reference: command.reference,
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
  const referenceDigest = digestReference(input.reference);

  return await store.transaction(async (transaction) => {
    const owner = await transaction.findUserForUpdate(input.userId);
    if (!owner) {
      return { kind: "user_not_found" };
    }
    if (owner.authVersion !== input.expectedAuthVersion) {
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
      newAuthVersion,
      subscribedUntil,
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
      referenceDigest,
      userId: owner.id,
    });
    return { kind: "applied", operation: input.operation, subscribedUntil };
  });
}

function extractReference(argumentsAfterEmail: string[]): string {
  const referenceIndex = argumentsAfterEmail.indexOf("--reference");
  if (
    referenceIndex < 0 ||
    referenceIndex !== argumentsAfterEmail.lastIndexOf("--reference") ||
    referenceIndex === argumentsAfterEmail.length - 1
  ) {
    throw new SubscriptionOverrideInputError(
      "Mutations require a valid --reference value."
    );
  }
  const [, reference] = argumentsAfterEmail.splice(referenceIndex, 2);
  assertReference(reference);
  return reference;
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
  assertReference(input.reference);
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

function assertReference(reference: string): void {
  if (
    reference.length === 0 ||
    reference.length > MAX_SUBSCRIPTION_OVERRIDE_REFERENCE_LENGTH ||
    reference.trim() !== reference ||
    !/^[\x20-\x7e]+$/u.test(reference)
  ) {
    throw new SubscriptionOverrideInputError(
      "External reference must be a bounded printable value."
    );
  }
}

function assertValidDate(value: Date, label: string): void {
  if (!Number.isFinite(value.getTime())) {
    throw new Error(`Subscription ${label} is invalid.`);
  }
}

function digestReference(reference: string): string {
  return createHash("sha256").update(reference, "utf8").digest("hex");
}
