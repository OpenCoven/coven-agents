export type PaidInvoiceUser = {
  billingPeriodStart: Date | null;
  stripeCustomerId: string | null;
  stripeSubscriptionId: string | null;
  subscribedUntil: Date | null;
};

export type PaidInvoiceEvidence = {
  customerId: string;
  periodEnd: Date;
  periodStart: Date;
  stripeSubscriptionId: string;
};

export type PaidInvoiceMutation = Partial<
  Pick<
    PaidInvoiceUser,
    | "billingPeriodStart"
    | "stripeCustomerId"
    | "stripeSubscriptionId"
    | "subscribedUntil"
  >
>;

export type PaidInvoiceDecision =
  | PaidInvoiceMutation
  | null
  | {
      kind: "manual_reconciliation";
      reason: "invoice_conflicting_paid_interval";
    };

/**
 * Applies the `invoice.paid` ordering rule without interpreting provider
 * status. Both webhook and bounded reconciliation call this function so an
 * independently retrieved paid interval cannot bypass webhook precedence.
 */
export function paidInvoiceMutation(
  current: PaidInvoiceUser,
  input: PaidInvoiceEvidence
): PaidInvoiceDecision {
  const currentStart = current.billingPeriodStart?.getTime() ?? null;
  const incomingStart = input.periodStart.getTime();
  const incomingEnd = input.periodEnd.getTime();
  const currentEnd = current.subscribedUntil?.getTime() ?? null;
  const hasBackedPaidInterval =
    currentStart !== null &&
    currentEnd !== null &&
    current.stripeSubscriptionId !== null;
  const sameSubscription =
    current.stripeSubscriptionId === input.stripeSubscriptionId;

  if (hasBackedPaidInterval && sameSubscription) {
    if (incomingEnd <= incomingStart || incomingEnd <= currentEnd) {
      return null;
    }
    if (incomingStart < currentStart) {
      return {
        kind: "manual_reconciliation",
        reason: "invoice_conflicting_paid_interval",
      };
    }
  } else if (
    hasBackedPaidInterval &&
    !sameSubscription &&
    (incomingStart < currentEnd ||
      incomingEnd <= currentEnd ||
      incomingEnd <= incomingStart)
  ) {
    return {
      kind: "manual_reconciliation",
      reason: "invoice_conflicting_paid_interval",
    };
  }

  return {
    ...customerMutation(current, input.customerId),
    billingPeriodStart: input.periodStart,
    stripeSubscriptionId: input.stripeSubscriptionId,
    subscribedUntil: input.periodEnd,
  };
}

function customerMutation(
  current: PaidInvoiceUser,
  customerId: string
): PaidInvoiceMutation {
  return current.stripeCustomerId ? {} : { stripeCustomerId: customerId };
}
