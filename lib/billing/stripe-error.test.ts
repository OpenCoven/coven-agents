import assert from "node:assert/strict";
import test from "node:test";
import Stripe from "stripe";
import {
  classifyStripeExpirationOutcome,
  classifyStripeRequestOutcome,
} from "./stripe-error";

test("Stripe connection failures are uncertain", () => {
  const error = new Stripe.errors.StripeConnectionError({
    message: "Connection timed out.",
    type: "api_error",
  });

  assert.equal(classifyStripeRequestOutcome(error), "uncertain");
});

test("Stripe 5xx responses are uncertain", () => {
  const error = new Stripe.errors.StripeAPIError({
    message: "Stripe unavailable.",
    statusCode: 503,
    type: "api_error",
  });

  assert.equal(classifyStripeRequestOutcome(error), "uncertain");
});

test("Stripe idempotency errors are uncertain for parameter mismatches and concurrent conflicts", async (t) => {
  const cases = [
    {
      message:
        "Keys for idempotent requests can only be used with the same parameters.",
      statusCode: 400,
    },
    {
      message: "Another request with the same idempotency key is executing.",
      statusCode: 409,
    },
  ];

  await Promise.all(
    cases.map(({ message, statusCode }) =>
      t.test(String(statusCode), () => {
        const error = new Stripe.errors.StripeIdempotencyError({
          message,
          statusCode,
          type: "idempotency_error",
        });

        assert.equal(classifyStripeRequestOutcome(error), "uncertain");
      })
    )
  );
});

test("ordinary Stripe InvalidRequest 400 errors are definite rejections", () => {
  const error = new Stripe.errors.StripeInvalidRequestError({
    message: "Invalid price.",
    statusCode: 400,
    type: "invalid_request_error",
  });

  assert.equal(classifyStripeRequestOutcome(error), "pre_request");
});

test("deterministic Stripe 4xx responses are definite rejections", async (t) => {
  const cases = [
    new Stripe.errors.StripeAuthenticationError({
      message: "Invalid API key.",
      statusCode: 401,
      type: "authentication_error",
    }),
    new Stripe.errors.StripePermissionError({
      message: "Permission denied.",
      statusCode: 403,
      type: "invalid_request_error",
    }),
    new Stripe.errors.StripeRateLimitError({
      message: "Too many requests.",
      statusCode: 429,
      type: "rate_limit_error",
    }),
  ];

  await Promise.all(
    cases.map((error) =>
      t.test(error.type, () => {
        assert.equal(classifyStripeRequestOutcome(error), "pre_request");
      })
    )
  );
});

test("representative SDK-shaped Stripe responses use their HTTP status", () => {
  assert.equal(
    classifyStripeRequestOutcome({
      statusCode: 500,
      type: "StripeAPIError",
    }),
    "uncertain"
  );
  assert.equal(
    classifyStripeRequestOutcome({
      statusCode: 404,
      type: "StripeInvalidRequestError",
    }),
    "pre_request"
  );
  assert.equal(
    classifyStripeRequestOutcome({
      statusCode: 400,
      type: "StripeIdempotencyError",
    }),
    "uncertain"
  );
  assert.equal(
    classifyStripeRequestOutcome({
      statusCode: 409,
      type: "StripeIdempotencyError",
    }),
    "uncertain"
  );
});

test("unknown exceptions fail closed as uncertain", () => {
  assert.equal(
    classifyStripeRequestOutcome(new Error("Unknown provider failure.")),
    "uncertain"
  );
});

test("expiration classifies cacheable Stripe 5xx separately from uncertain completion", () => {
  assert.equal(
    classifyStripeExpirationOutcome(
      new Stripe.errors.StripeAPIError({
        message: "Stripe unavailable.",
        statusCode: 503,
        type: "api_error",
      })
    ),
    "cacheable_server_error"
  );
  assert.equal(
    classifyStripeExpirationOutcome(
      new Stripe.errors.StripeConnectionError({
        message: "Connection timed out.",
        type: "api_error",
      })
    ),
    "uncertain"
  );
  assert.equal(
    classifyStripeExpirationOutcome(
      new Stripe.errors.StripeIdempotencyError({
        message: "Another request with the same key is executing.",
        statusCode: 409,
        type: "idempotency_error",
      })
    ),
    "uncertain"
  );
  assert.equal(
    classifyStripeExpirationOutcome(
      new Stripe.errors.StripeIdempotencyError({
        message: "The key was reused with different parameters.",
        statusCode: 400,
        type: "idempotency_error",
      })
    ),
    "uncertain"
  );
});

test("expiration retires deterministic 4xx rejections but retains retryable rate limits", () => {
  assert.equal(
    classifyStripeExpirationOutcome(
      new Stripe.errors.StripeInvalidRequestError({
        message: "The Checkout Session cannot be expired.",
        statusCode: 400,
        type: "invalid_request_error",
      })
    ),
    "definite_rejection"
  );
  assert.equal(
    classifyStripeExpirationOutcome(
      new Stripe.errors.StripeRateLimitError({
        message: "Too many requests.",
        statusCode: 429,
        type: "rate_limit_error",
      })
    ),
    "uncertain"
  );
  assert.equal(
    classifyStripeExpirationOutcome(
      new Stripe.errors.StripeAuthenticationError({
        message: "Invalid API key.",
        statusCode: 401,
        type: "authentication_error",
      })
    ),
    "uncertain"
  );
});
