import Stripe from "stripe";

export type StripeRequestOutcome = "pre_request" | "uncertain";

export function classifyStripeRequestOutcome(
  error: unknown
): StripeRequestOutcome {
  if (
    error instanceof Stripe.errors.StripeConnectionError ||
    stripeErrorType(error) === "StripeConnectionError"
  ) {
    return "uncertain";
  }
  if (
    error instanceof Stripe.errors.StripeIdempotencyError ||
    stripeErrorType(error) === "StripeIdempotencyError"
  ) {
    return "uncertain";
  }

  if (!isStripeError(error)) {
    return "uncertain";
  }

  const statusCode = stripeStatusCode(error);
  if (statusCode === 409 || (statusCode !== null && statusCode >= 500)) {
    return "uncertain";
  }
  if (statusCode !== null && statusCode >= 400 && statusCode < 500) {
    return "pre_request";
  }
  return "uncertain";
}

function isStripeError(error: unknown): boolean {
  return (
    error instanceof Stripe.errors.StripeError ||
    stripeErrorType(error)?.startsWith("Stripe") === true
  );
}

function stripeErrorType(error: unknown): string | null {
  if (
    typeof error === "object" &&
    error !== null &&
    "type" in error &&
    typeof error.type === "string"
  ) {
    return error.type;
  }
  return null;
}

function stripeStatusCode(error: unknown): number | null {
  if (
    typeof error === "object" &&
    error !== null &&
    "statusCode" in error &&
    typeof error.statusCode === "number" &&
    Number.isInteger(error.statusCode)
  ) {
    return error.statusCode;
  }
  return null;
}
