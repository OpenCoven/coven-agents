export const STRIPE_RECONCILIATION_EVENT_TYPES = [
  "invoice.paid",
  "invoice.payment_failed",
] as const;

export const STRIPE_RECONCILIATION_REASONS = [
  "invoice_ambiguous_entitlement",
  "invoice_conflicting_paid_interval",
  "invoice_contradictory_subscription",
  "invoice_invalid_period",
  "invoice_invalid_reference",
] as const;

export const STRIPE_RECONCILIATION_STATUSES = [
  "pending",
  "acknowledged",
  "resolved",
] as const;

export type StripeReconciliationEventType =
  (typeof STRIPE_RECONCILIATION_EVENT_TYPES)[number];
export type StripeReconciliationReason =
  (typeof STRIPE_RECONCILIATION_REASONS)[number];
export type StripeReconciliationStatus =
  (typeof STRIPE_RECONCILIATION_STATUSES)[number];

export type StripeReconciliationRecord = {
  eventId: string;
  eventType: StripeReconciliationEventType;
  reason: StripeReconciliationReason;
  status: StripeReconciliationStatus;
};

import {
  type PaidInvoiceMutation,
  type PaidInvoiceUser,
  paidInvoiceMutation,
} from "./paid-invoice";

type ReconciliationBounds = {
  invoiceLinePageLimit: number;
  invoiceLineResultLimit: number;
  leaseTtlMs: number;
  maxBatches: number;
  maxUsers: number;
  providerConcurrency: number;
  subscriptionPageLimit: number;
  subscriptionResultLimit: number;
  userBatchSize: number;
};

const DEFAULT_BOUNDS: ReconciliationBounds = {
  invoiceLinePageLimit: 3,
  invoiceLineResultLimit: 100,
  leaseTtlMs: 120_000,
  maxBatches: 5,
  maxUsers: 100,
  providerConcurrency: 4,
  subscriptionPageLimit: 3,
  subscriptionResultLimit: 100,
  userBatchSize: 20,
} as const;

export type StripeReconciliationUser = PaidInvoiceUser & {
  authVersion: number;
  id: string;
};

export type StripeReconciliationLease = {
  cursor: string | null;
  fence: number;
  owner: string;
};

export type StripeSubscriptionObservation = {
  customerId: string | null;
  id: string;
  latestInvoiceId: string | null;
  priceIds: readonly string[];
  status: string;
};

export type StripeInvoiceLineObservation = {
  id: string;
  invalidSubscriptionReference: boolean;
  periodEnd: Date | null;
  periodStart: Date | null;
  priceId: string | null;
  proration: boolean;
  subscriptionItem: boolean;
  subscriptionItemSubscriptionId?: string | null;
  stripeSubscriptionId: string | null;
};

export type StripeInvoiceObservation = {
  billingReason: string | null;
  customerId: string | null;
  id: string;
  lines: StripeReconciliationPage<StripeInvoiceLineObservation>;
  paid: boolean;
  stripeSubscriptionId: string | null;
};

export type StripeReconciliationPage<T> = {
  data: readonly T[];
  hasMore: boolean;
};

export type StripeReconciliationProvider = {
  listInvoiceLines: (
    invoiceId: string,
    input: { limit: number; startingAfter: string }
  ) => Promise<StripeReconciliationPage<StripeInvoiceLineObservation>>;
  listSubscriptions: (
    customerId: string,
    input: { limit: number; startingAfter?: string }
  ) => Promise<StripeReconciliationPage<StripeSubscriptionObservation>>;
  retrieveInvoice: (
    invoiceId: string
  ) => Promise<StripeInvoiceObservation | null>;
  retrieveSubscription: (
    subscriptionId: string
  ) => Promise<StripeSubscriptionObservation | null>;
};

export type StripeReconciliationStore = {
  acquire: (input: {
    leaseTtlMs: number;
    owner: string;
  }) => Promise<
    { kind: "acquired"; lease: StripeReconciliationLease } | { kind: "held" }
  >;
  commit: (input: {
    lease: StripeReconciliationLease;
    mutation: PaidInvoiceMutation | null;
    nextCursor: string;
    snapshot: StripeReconciliationUser;
  }) => Promise<"committed" | "conflict" | "lost">;
  release: (lease: StripeReconciliationLease) => Promise<"lost" | "released">;
  renew: (input: {
    lease: StripeReconciliationLease;
    leaseTtlMs: number;
  }) => Promise<
    { kind: "lost" } | { kind: "renewed"; lease: StripeReconciliationLease }
  >;
  scanUsers: (input: {
    after: string | null;
    limit: number;
  }) => Promise<StripeReconciliationUser[]>;
  wrapCursor: (
    lease: StripeReconciliationLease
  ) => Promise<
    { kind: "lost" } | { kind: "wrapped"; lease: StripeReconciliationLease }
  >;
};

export type StripeReconciliationBounds = Partial<ReconciliationBounds>;

export type StripeReconciliationResult = {
  applied: number;
  conflicts: number;
  deferred: number;
  execution: "executed" | "skipped";
  failures: number;
  scanned: number;
  unchanged: number;
};

export type StripeReconciliationDependencies = {
  bounds?: StripeReconciliationBounds;
  owner: string;
  priceId: string;
  provider: StripeReconciliationProvider;
  store: StripeReconciliationStore;
};

type UserDisposition =
  | { kind: "applied"; mutation: PaidInvoiceMutation }
  | { kind: "deferred"; reason: DeferredReason }
  | { kind: "unchanged" };

type DeferredReason =
  | "customer_reference_invalid"
  | "invoice_ambiguous_entitlement"
  | "invoice_contradictory_subscription"
  | "invoice_conflicting_paid_interval"
  | "invoice_customer_mismatch"
  | "invoice_invalid_period"
  | "invoice_invalid_reference"
  | "invoice_missing_latest"
  | "invoice_not_paid"
  | "invoice_no_entitlement"
  | "invoice_subscription_mismatch"
  | "invoice_unsupported_billing_reason"
  | "provider_page_limit"
  | "provider_pagination_invalid"
  | "provider_result_limit"
  | "provider_unavailable"
  | "subscription_ambiguous"
  | "subscription_canceled"
  | "subscription_customer_mismatch"
  | "subscription_incomplete"
  | "subscription_incomplete_expired"
  | "subscription_invalid_reference"
  | "subscription_paused"
  | "subscription_past_due"
  | "subscription_price_mismatch"
  | "subscription_trialing"
  | "subscription_unknown_status"
  | "subscription_unpaid";

type SubscriptionSelection =
  | { kind: "candidate"; subscription: StripeSubscriptionObservation }
  | { kind: "deferred"; reason: DeferredReason };

type InvoiceEntitlement =
  | {
      kind: "accepted";
      periodEnd: Date;
      periodStart: Date;
    }
  | { kind: "deferred"; reason: DeferredReason };

function emptyResult(execution: StripeReconciliationResult["execution"]) {
  return {
    applied: 0,
    conflicts: 0,
    deferred: 0,
    execution,
    failures: 0,
    scanned: 0,
    unchanged: 0,
  } satisfies StripeReconciliationResult;
}

function reconcileBounds(input: StripeReconciliationBounds | undefined) {
  const bounds = { ...DEFAULT_BOUNDS, ...input };
  validateBound(bounds.invoiceLinePageLimit, "invoiceLinePageLimit", 20);
  validateBound(bounds.invoiceLineResultLimit, "invoiceLineResultLimit", 100);
  validateBound(bounds.leaseTtlMs, "leaseTtlMs", 300_000, 1000);
  validateBound(bounds.maxBatches, "maxBatches", 100);
  validateBound(bounds.maxUsers, "maxUsers", 1000);
  validateBound(bounds.providerConcurrency, "providerConcurrency", 16);
  validateBound(bounds.subscriptionPageLimit, "subscriptionPageLimit", 20);
  validateBound(bounds.subscriptionResultLimit, "subscriptionResultLimit", 100);
  validateBound(bounds.userBatchSize, "userBatchSize", 100);
  return bounds;
}

function validateBound(
  value: number,
  name: string,
  maximum: number,
  minimum = 1
): void {
  if (!Number.isSafeInteger(value) || value < minimum || value > maximum) {
    throw new Error(
      `${name} must be an integer between ${minimum} and ${maximum}.`
    );
  }
}

/**
 * Performs only positive, invoice-evidenced repairs. Provider failures and
 * ambiguity are intentionally summarized as deferred, never thrown or stored.
 */
export async function reconcileStripeSubscriptions(
  dependencies: StripeReconciliationDependencies
): Promise<StripeReconciliationResult> {
  const bounds = reconcileBounds(dependencies.bounds);
  if (!validStripeId(dependencies.priceId, "price_")) {
    throw new Error("Configured Stripe price is invalid.");
  }
  if (
    !dependencies.owner ||
    dependencies.owner.length > 64 ||
    !Number.isSafeInteger(dependencies.owner.length)
  ) {
    throw new Error("Reconciliation lease owner is invalid.");
  }

  const acquired = await dependencies.store.acquire({
    leaseTtlMs: bounds.leaseTtlMs,
    owner: dependencies.owner,
  });
  if (acquired.kind === "held") {
    return emptyResult("skipped");
  }

  const result = emptyResult("executed");
  let { lease } = acquired;
  let wrapped = false;
  let leaseLost = false;

  try {
    for (
      let batch = 0;
      batch < bounds.maxBatches &&
      result.scanned < bounds.maxUsers &&
      !leaseLost;
      batch += 1
    ) {
      // biome-ignore lint/performance/noAwaitInLoops: each bounded batch must renew its exact lease before scanning.
      const renewed = await dependencies.store.renew({
        lease,
        leaseTtlMs: bounds.leaseTtlMs,
      });
      if (renewed.kind === "lost") {
        leaseLost = true;
        break;
      }
      ({ lease } = renewed);

      let users: StripeReconciliationUser[];
      try {
        users = await dependencies.store.scanUsers({
          after: lease.cursor,
          limit: Math.min(
            bounds.userBatchSize,
            bounds.maxUsers - result.scanned
          ),
        });
      } catch {
        result.failures += 1;
        break;
      }

      if (users.length === 0) {
        if (lease.cursor === null || wrapped) {
          break;
        }
        const wrappedCursor = await dependencies.store.wrapCursor(lease);
        if (wrappedCursor.kind === "lost") {
          leaseLost = true;
          break;
        }
        ({ lease } = wrappedCursor);
        wrapped = true;
        continue;
      }

      const dispositions = await mapBounded(
        users,
        bounds.providerConcurrency,
        async (user) =>
          await safelyReconcileUser(
            user,
            dependencies.provider,
            dependencies.priceId,
            bounds
          )
      );

      for (const [index, disposition] of dispositions.entries()) {
        const snapshot = users[index];
        if (!snapshot) {
          result.failures += 1;
          leaseLost = true;
          break;
        }
        result.scanned += 1;

        // biome-ignore lint/performance/noAwaitInLoops: commits must retain cursor order and their fresh lease fence.
        const renewedBeforeCommit = await dependencies.store.renew({
          lease,
          leaseTtlMs: bounds.leaseTtlMs,
        });
        if (renewedBeforeCommit.kind === "lost") {
          leaseLost = true;
          break;
        }
        ({ lease } = renewedBeforeCommit);

        let committed: "committed" | "conflict" | "lost";
        try {
          committed = await dependencies.store.commit({
            lease,
            mutation:
              disposition.kind === "applied" ? disposition.mutation : null,
            nextCursor: snapshot.id,
            snapshot,
          });
        } catch {
          result.failures += 1;
          leaseLost = true;
          break;
        }
        if (committed === "lost") {
          leaseLost = true;
          break;
        }
        if (committed === "conflict") {
          result.conflicts += 1;
          break;
        }
        switch (disposition.kind) {
          case "applied":
            result.applied += 1;
            break;
          case "deferred":
            result.deferred += 1;
            break;
          case "unchanged":
            result.unchanged += 1;
            break;
          default:
            throw new Error("Unsupported reconciliation disposition.");
        }
      }
    }
  } finally {
    try {
      await dependencies.store.release(lease);
    } catch {
      // A bounded lease expiry is the recovery path if release is unavailable.
    }
  }
  return result;
}

async function reconcileUser(
  user: StripeReconciliationUser,
  provider: StripeReconciliationProvider,
  priceId: string,
  bounds: ReconciliationBounds
): Promise<UserDisposition> {
  const selected = await selectSubscription(user, provider, priceId, bounds);
  if (selected.kind === "deferred") {
    return selected;
  }
  const { subscription } = selected;
  const invoice = await invoiceForSubscription(subscription, provider);
  if (invoice.kind === "deferred") {
    return invoice;
  }
  const entitlement = await paidInvoiceEntitlement(
    invoice.invoice,
    subscription.id,
    priceId,
    provider,
    bounds
  );
  if (entitlement.kind === "deferred") {
    return entitlement;
  }
  const decision = paidInvoiceMutation(user, {
    customerId: user.stripeCustomerId as string,
    periodEnd: entitlement.periodEnd,
    periodStart: entitlement.periodStart,
    stripeSubscriptionId: subscription.id,
  });
  if (!decision) {
    return { kind: "unchanged" };
  }
  if ("kind" in decision) {
    return { kind: "deferred", reason: decision.reason };
  }
  return { kind: "applied", mutation: decision };
}

async function safelyReconcileUser(
  user: StripeReconciliationUser,
  provider: StripeReconciliationProvider,
  priceId: string,
  bounds: ReconciliationBounds
): Promise<UserDisposition> {
  try {
    return await reconcileUser(user, provider, priceId, bounds);
  } catch {
    return { kind: "deferred", reason: "provider_unavailable" };
  }
}

async function selectSubscription(
  user: StripeReconciliationUser,
  provider: StripeReconciliationProvider,
  priceId: string,
  bounds: ReconciliationBounds
): Promise<SubscriptionSelection> {
  const customerId = user.stripeCustomerId;
  if (!customerId || !validStripeId(customerId, "cus_")) {
    return {
      kind: "deferred",
      reason: user.stripeCustomerId
        ? "customer_reference_invalid"
        : "subscription_customer_mismatch",
    };
  }
  const storedSubscriptionId = user.stripeSubscriptionId;
  if (storedSubscriptionId && !validStripeId(storedSubscriptionId, "sub_")) {
    return { kind: "deferred", reason: "subscription_invalid_reference" };
  }
  if (storedSubscriptionId) {
    let retrieved: StripeSubscriptionObservation | null;
    try {
      retrieved = await provider.retrieveSubscription(storedSubscriptionId);
    } catch {
      return { kind: "deferred", reason: "provider_unavailable" };
    }
    if (retrieved) {
      const validation = subscriptionMatches(
        retrieved,
        customerId,
        storedSubscriptionId
      );
      if (validation) {
        return { kind: "deferred", reason: validation };
      }
      const status = subscriptionStatus(retrieved.status);
      if (status === "active") {
        return retrieved.priceIds.includes(priceId)
          ? { kind: "candidate", subscription: retrieved }
          : { kind: "deferred", reason: "subscription_price_mismatch" };
      }
      if (!isTerminalSubscriptionStatus(status)) {
        return { kind: "deferred", reason: status };
      }
    }
  }
  return await listedSubscription(customerId, provider, priceId, bounds);
}

function subscriptionMatches(
  subscription: StripeSubscriptionObservation,
  customerId: string,
  expectedId: string | null
): DeferredReason | null {
  if (!validStripeId(subscription.id, "sub_")) {
    return "subscription_invalid_reference";
  }
  if (expectedId && subscription.id !== expectedId) {
    return "subscription_invalid_reference";
  }
  if (subscription.customerId !== customerId) {
    return "subscription_customer_mismatch";
  }
  return null;
}

async function listedSubscription(
  customerId: string,
  provider: StripeReconciliationProvider,
  priceId: string,
  bounds: ReconciliationBounds
): Promise<SubscriptionSelection> {
  const subscriptions: StripeSubscriptionObservation[] = [];
  let startingAfter: string | undefined;

  for (
    let pageNumber = 0;
    pageNumber < bounds.subscriptionPageLimit;
    pageNumber += 1
  ) {
    let page: StripeReconciliationPage<StripeSubscriptionObservation>;
    try {
      // biome-ignore lint/performance/noAwaitInLoops: provider pages are cursor-dependent.
      page = await provider.listSubscriptions(customerId, {
        limit: Math.min(
          100,
          bounds.subscriptionResultLimit - subscriptions.length
        ),
        ...(startingAfter ? { startingAfter } : {}),
      });
    } catch {
      return { kind: "deferred", reason: "provider_unavailable" };
    }
    if (
      !Array.isArray(page.data) ||
      typeof page.hasMore !== "boolean" ||
      page.data.length > bounds.subscriptionResultLimit - subscriptions.length
    ) {
      return { kind: "deferred", reason: "provider_result_limit" };
    }
    subscriptions.push(...page.data);
    if (!page.hasMore) {
      break;
    }
    if (subscriptions.length >= bounds.subscriptionResultLimit) {
      return { kind: "deferred", reason: "provider_result_limit" };
    }
    if (pageNumber + 1 >= bounds.subscriptionPageLimit) {
      return { kind: "deferred", reason: "provider_page_limit" };
    }
    const next = page.data.at(-1)?.id;
    if (!next || next === startingAfter || !validStripeId(next, "sub_")) {
      return { kind: "deferred", reason: "provider_pagination_invalid" };
    }
    startingAfter = next;
  }

  const matching: StripeSubscriptionObservation[] = [];
  for (const subscription of subscriptions) {
    const validation = subscriptionMatches(subscription, customerId, null);
    if (validation) {
      return { kind: "deferred", reason: validation };
    }
    if (!subscription.priceIds.includes(priceId)) {
      continue;
    }
    matching.push(subscription);
  }
  if (matching.length !== 1) {
    return {
      kind: "deferred",
      reason:
        matching.length > 1
          ? "subscription_ambiguous"
          : "subscription_unknown_status",
    };
  }
  const subscription = matching[0] as StripeSubscriptionObservation;
  const status = subscriptionStatus(subscription.status);
  return status === "active"
    ? { kind: "candidate", subscription }
    : { kind: "deferred", reason: status };
}

function subscriptionStatus(status: string): DeferredReason | "active" {
  switch (status) {
    case "active":
      return "active";
    case "trialing":
      return "subscription_trialing";
    case "past_due":
      return "subscription_past_due";
    case "unpaid":
      return "subscription_unpaid";
    case "canceled":
      return "subscription_canceled";
    case "incomplete":
      return "subscription_incomplete";
    case "incomplete_expired":
      return "subscription_incomplete_expired";
    case "paused":
      return "subscription_paused";
    default:
      return "subscription_unknown_status";
  }
}

function isTerminalSubscriptionStatus(
  status: DeferredReason | "active"
): boolean {
  return (
    status === "subscription_canceled" ||
    status === "subscription_incomplete_expired" ||
    status === "subscription_unpaid"
  );
}

async function invoiceForSubscription(
  subscription: StripeSubscriptionObservation,
  provider: StripeReconciliationProvider
): Promise<
  | { invoice: StripeInvoiceObservation; kind: "accepted" }
  | { kind: "deferred"; reason: DeferredReason }
> {
  const invoiceId = subscription.latestInvoiceId;
  if (!invoiceId || !validStripeId(invoiceId, "in_")) {
    return { kind: "deferred", reason: "invoice_missing_latest" };
  }
  let invoice: StripeInvoiceObservation | null;
  try {
    invoice = await provider.retrieveInvoice(invoiceId);
  } catch {
    return { kind: "deferred", reason: "provider_unavailable" };
  }
  if (
    !invoice ||
    invoice.id !== invoiceId ||
    !validStripeId(invoice.id, "in_")
  ) {
    return { kind: "deferred", reason: "invoice_invalid_reference" };
  }
  if (!invoice.paid) {
    return { kind: "deferred", reason: "invoice_not_paid" };
  }
  if (invoice.customerId !== subscription.customerId) {
    return { kind: "deferred", reason: "invoice_customer_mismatch" };
  }
  if (invoice.stripeSubscriptionId !== subscription.id) {
    return { kind: "deferred", reason: "invoice_subscription_mismatch" };
  }
  if (!supportedBillingReason(invoice.billingReason)) {
    return { kind: "deferred", reason: "invoice_unsupported_billing_reason" };
  }
  return { invoice, kind: "accepted" };
}

async function paidInvoiceEntitlement(
  invoice: StripeInvoiceObservation,
  subscriptionId: string,
  priceId: string,
  provider: StripeReconciliationProvider,
  bounds: ReconciliationBounds
): Promise<InvoiceEntitlement> {
  const matching: StripeInvoiceLineObservation[] = [];
  let page = invoice.lines;
  let pageNumber = 0;
  let inspected = 0;
  let startingAfter: string | undefined;

  while (true) {
    pageNumber += 1;
    if (
      !Array.isArray(page.data) ||
      typeof page.hasMore !== "boolean" ||
      pageNumber > bounds.invoiceLinePageLimit ||
      page.data.length > bounds.invoiceLineResultLimit - inspected
    ) {
      return {
        kind: "deferred",
        reason:
          pageNumber > bounds.invoiceLinePageLimit
            ? "provider_page_limit"
            : "provider_result_limit",
      };
    }
    inspected += page.data.length;
    for (const line of page.data) {
      if (
        line.priceId !== priceId ||
        line.proration ||
        !line.subscriptionItem
      ) {
        continue;
      }
      if (line.invalidSubscriptionReference || !validStripeId(line.id, "il_")) {
        return { kind: "deferred", reason: "invoice_invalid_reference" };
      }
      if (
        line.subscriptionItemSubscriptionId &&
        line.stripeSubscriptionId &&
        line.subscriptionItemSubscriptionId !== line.stripeSubscriptionId
      ) {
        return {
          kind: "deferred",
          reason: "invoice_contradictory_subscription",
        };
      }
      if (!resolvedLineSubscriptionId(line)) {
        return { kind: "deferred", reason: "invoice_invalid_reference" };
      }
      const lineSubscriptionId = resolvedLineSubscriptionId(line);
      if (lineSubscriptionId !== subscriptionId) {
        return {
          kind: "deferred",
          reason: "invoice_contradictory_subscription",
        };
      }
      if (!validPeriod(line.periodStart, line.periodEnd)) {
        return { kind: "deferred", reason: "invoice_invalid_period" };
      }
      matching.push(line);
      if (matching.length > 1) {
        return { kind: "deferred", reason: "invoice_ambiguous_entitlement" };
      }
    }
    if (!page.hasMore) {
      break;
    }
    if (inspected >= bounds.invoiceLineResultLimit) {
      return { kind: "deferred", reason: "provider_result_limit" };
    }
    if (pageNumber >= bounds.invoiceLinePageLimit) {
      return { kind: "deferred", reason: "provider_page_limit" };
    }
    const next = page.data.at(-1)?.id;
    if (!next || next === startingAfter || !validStripeId(next, "il_")) {
      return { kind: "deferred", reason: "provider_pagination_invalid" };
    }
    startingAfter = next;
    try {
      // biome-ignore lint/performance/noAwaitInLoops: provider pages are cursor-dependent.
      page = await provider.listInvoiceLines(invoice.id, {
        limit: Math.min(100, bounds.invoiceLineResultLimit - inspected),
        startingAfter: next,
      });
    } catch {
      return { kind: "deferred", reason: "provider_unavailable" };
    }
  }
  const [line] = matching;
  return line
    ? {
        kind: "accepted",
        periodEnd: line.periodEnd as Date,
        periodStart: line.periodStart as Date,
      }
    : { kind: "deferred", reason: "invoice_no_entitlement" };
}

function resolvedLineSubscriptionId(
  line: StripeInvoiceLineObservation
): string | null {
  const parentSubscriptionId = line.subscriptionItemSubscriptionId ?? null;
  if (
    parentSubscriptionId &&
    line.stripeSubscriptionId &&
    parentSubscriptionId !== line.stripeSubscriptionId
  ) {
    return null;
  }
  const subscriptionId = line.stripeSubscriptionId ?? parentSubscriptionId;
  return subscriptionId && validStripeId(subscriptionId, "sub_")
    ? subscriptionId
    : null;
}

function validPeriod(start: Date | null, end: Date | null): boolean {
  return Boolean(
    start &&
      end &&
      !Number.isNaN(start.getTime()) &&
      !Number.isNaN(end.getTime()) &&
      end.getTime() > start.getTime()
  );
}

function supportedBillingReason(reason: string | null): boolean {
  return (
    reason === "subscription_create" ||
    reason === "subscription_cycle" ||
    reason === "subscription_update"
  );
}

function validStripeId(
  value: string,
  prefix: "cus_" | "il_" | "in_" | "price_" | "sub_"
): boolean {
  return (
    value.startsWith(prefix) &&
    value.length > prefix.length &&
    value.length <= 64
  );
}

async function mapBounded<T, Result>(
  values: readonly T[],
  concurrency: number,
  operation: (value: T) => Promise<Result>
): Promise<Result[]> {
  const results: Result[] = [];
  let next = 0;
  const worker = async () => {
    while (next < values.length) {
      const index = next;
      next += 1;
      // biome-ignore lint/performance/noAwaitInLoops: worker assignments stay serial.
      results[index] = await operation(values[index] as T);
    }
  };
  await Promise.all(
    Array.from({ length: Math.min(concurrency, values.length) }, () => worker())
  );
  return results;
}
