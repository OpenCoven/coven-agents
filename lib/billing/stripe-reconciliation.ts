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
