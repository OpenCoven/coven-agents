import assert from "node:assert/strict";
import test from "node:test";
import type Stripe from "stripe";
import type { CheckoutAttemptState } from "./checkout-lease";
import { GRACE_PERIOD_DAYS } from "./limits";
import {
  stripeWebhookResponse as productionWebhookResponse,
  type StripeEventUpdateInput,
  type StripeEventWriteResult,
  type StripeUserMutation,
  type StripeWebhookManualReconciliationRecord,
  stripeEventMutation,
  subscriptionUpdate,
  type WebhookUser,
} from "./webhook";

const PAID_UNTIL = new Date("2026-09-20T12:00:00.000Z");
const PAID_FROM = new Date("2026-08-20T12:00:00.000Z");
const NEXT_PERIOD_END = new Date("2026-10-20T12:00:00.000Z");
const PRICE_ID = "price_webhook";
const USER_ID = "3f2504e0-4f89-41d3-9a0c-0305e82c3301";
const CHECKOUT_ATTEMPT_ID = "11111111-1111-4111-8111-111111111111";
const CHECKOUT_INTEGRATION_IDENTIFIER = "opencoven_coven_agents_qohuikyr";

test("a paid invoice sets the period end", () => {
  const update = subscriptionUpdate({
    billingReason: "subscription_cycle",
    current: null,
    periodEnd: PAID_UNTIL,
    periodStart: PAID_FROM,
    type: "invoice.paid",
  });

  assert.equal(update?.subscribedUntil.toISOString(), PAID_UNTIL.toISOString());
  assert.equal(
    update?.billingPeriodStart.toISOString(),
    PAID_FROM.toISOString()
  );
});

test("a paid invoice with no period end changes nothing", () => {
  // Without a date there is nothing to grant, and defaulting to "now plus a
  // month" would invent a subscription the invoice never described.
  assert.equal(
    subscriptionUpdate({
      billingReason: "subscription_cycle",
      current: null,
      periodEnd: null,
      type: "invoice.paid",
    }),
    null
  );
});

test("a paid invoice with no exact period start changes nothing", () => {
  assert.equal(
    subscriptionUpdate({
      billingReason: "subscription_cycle",
      current: PAID_UNTIL,
      periodEnd: NEXT_PERIOD_END,
      periodStart: null,
      type: "invoice.paid",
    }),
    null
  );
});

test("a failed renewal extends by the grace window", () => {
  const update = subscriptionUpdate({
    billingReason: "subscription_cycle",
    current: PAID_UNTIL,
    currentPeriodStart: PAID_FROM,
    periodEnd: null,
    type: "invoice.payment_failed",
  });

  assert.equal(
    update?.subscribedUntil.getTime(),
    PAID_UNTIL.getTime() + GRACE_PERIOD_DAYS * 86_400_000
  );
});

test("a failed renewal preserves the paid billing-period start", () => {
  const input = {
    billingReason: "subscription_cycle",
    current: PAID_UNTIL,
    currentPeriodStart: new Date("2026-08-20T12:00:00.000Z"),
    periodEnd: null,
    type: "invoice.payment_failed",
  };
  const update = subscriptionUpdate(input);

  assert.deepEqual(update, {
    billingPeriodStart: input.currentPeriodStart,
    subscribedUntil: new Date(
      PAID_UNTIL.getTime() + GRACE_PERIOD_DAYS * 86_400_000
    ),
  });
});

test("a failed FIRST payment changes nothing", () => {
  // Would otherwise grant a subscriber session -- database writes and
  // credential storage -- to someone who has never paid.
  assert.equal(
    subscriptionUpdate({
      billingReason: "subscription_create",
      current: null,
      periodEnd: null,
      type: "invoice.payment_failed",
    }),
    null
  );
});

test("a cancellation revokes nothing", () => {
  // The period is already paid for. Access ends when the date passes.
  assert.equal(
    subscriptionUpdate({
      billingReason: "subscription_cycle",
      current: PAID_UNTIL,
      periodEnd: null,
      type: "customer.subscription.deleted",
    }),
    null
  );
});

test("an unrecognised event changes nothing", () => {
  // Allow-listed on type, so an event Stripe adds later defaults to changing
  // nothing rather than falling into a branch never considered for it.
  for (const type of ["invoice.upcoming", "customer.updated", "ping", ""]) {
    assert.equal(
      subscriptionUpdate({
        billingReason: "subscription_cycle",
        current: PAID_UNTIL,
        periodEnd: PAID_UNTIL,
        type,
      }),
      null,
      `${JSON.stringify(type)} must change nothing`
    );
  }
});

test("a failed FIRST payment is refused even when a prior period exists", () => {
  // Closes a hole mutation testing found: every other subscription_create
  // case in this file also had a null `current`, so graceExtension refused on
  // the missing date rather than the reason -- and hardcoding the reason to
  // "subscription_cycle" passed the whole suite. A returning customer whose
  // first invoice on a NEW subscription fails would then have been handed
  // three free days.
  assert.equal(
    subscriptionUpdate({
      billingReason: "subscription_create",
      current: PAID_UNTIL,
      periodEnd: null,
      type: "invoice.payment_failed",
    }),
    null
  );
});

test("grace does not compound across two failures", () => {
  // `current` already beyond `periodEnd` means grace was granted once. A
  // second failure inside that window must not extend again -- otherwise two
  // failed retries become a fortnight of unpaid access.
  const alreadyExtended = new Date(PAID_UNTIL.getTime() + 3 * 86_400_000);

  assert.equal(
    subscriptionUpdate({
      billingReason: "subscription_cycle",
      current: alreadyExtended,
      periodEnd: NEXT_PERIOD_END,
      periodStart: PAID_UNTIL,
      type: "invoice.payment_failed",
    }),
    null
  );
});

test("newer paid authority makes an older paid event a claimed no-op", async () => {
  const writer = new MemoryStripeEventWriter([paidUser()]);
  const newer = paidIntent({
    eventId: "evt_paid_newer",
    periodEnd: new Date("2026-11-20T12:00:00.000Z"),
    periodStart: NEXT_PERIOD_END,
  });
  const older = paidIntent({
    eventId: "evt_paid_older",
    periodEnd: NEXT_PERIOD_END,
    periodStart: PAID_UNTIL,
  });

  assert.equal(await writer.apply(newer), "applied");
  assert.equal(await writer.apply(older), "applied");

  assert.deepEqual(writer.events, new Set([newer.eventId, older.eventId]));
  assert.deepEqual(writer.users.get(USER_ID), {
    ...paidUser(),
    billingPeriodStart: NEXT_PERIOD_END,
    subscribedUntil: new Date("2026-11-20T12:00:00.000Z"),
  });
  assert.equal(writer.updateCount, 1);
});

test("concurrent distinct paid events preserve the newest period in either arrival order", async () => {
  await Promise.all(
    (["older-first", "newer-first"] as const).map(async (order) => {
      const writer = new MemoryStripeEventWriter([paidUser()]);
      const older = paidIntent({
        eventId: `evt_concurrent_older_${order}`,
        periodEnd: NEXT_PERIOD_END,
        periodStart: PAID_UNTIL,
      });
      const newer = paidIntent({
        eventId: `evt_concurrent_newer_${order}`,
        periodEnd: new Date("2026-11-20T12:00:00.000Z"),
        periodStart: NEXT_PERIOD_END,
      });

      await Promise.all(
        order === "older-first"
          ? [writer.apply(older), writer.apply(newer)]
          : [writer.apply(newer), writer.apply(older)]
      );

      assert.equal(
        writer.users.get(USER_ID)?.billingPeriodStart?.toISOString(),
        NEXT_PERIOD_END.toISOString()
      );
      assert.equal(
        writer.users.get(USER_ID)?.subscribedUntil?.toISOString(),
        "2026-11-20T12:00:00.000Z"
      );
      assert.equal(writer.events.has(older.eventId), true);
      assert.equal(writer.events.has(newer.eventId), true);
    })
  );
});

test("paid and failure events preserve paid authority in either arrival order", async () => {
  await Promise.all(
    (["failure-first", "paid-first"] as const).map(async (order) => {
      const writer = new MemoryStripeEventWriter([paidUser()]);
      const failure = failedIntent(`evt_failure_${order}`);
      const paid = paidIntent({
        eventId: `evt_paid_${order}`,
        periodEnd: NEXT_PERIOD_END,
        periodStart: PAID_UNTIL,
      });

      await Promise.all(
        order === "failure-first"
          ? [writer.apply(failure), writer.apply(paid)]
          : [writer.apply(paid), writer.apply(failure)]
      );

      assert.equal(
        writer.users.get(USER_ID)?.billingPeriodStart?.toISOString(),
        PAID_UNTIL.toISOString()
      );
      assert.equal(
        writer.users.get(USER_ID)?.subscribedUntil?.toISOString(),
        NEXT_PERIOD_END.toISOString()
      );
      assert.equal(writer.events.has(failure.eventId), true);
      assert.equal(writer.events.has(paid.eventId), true);
    })
  );
});

test("two distinct renewal failures grant grace only once", async () => {
  const writer = new MemoryStripeEventWriter([paidUser()]);
  const first = failedIntent("evt_failure_first");
  const second = failedIntent("evt_failure_second");

  await Promise.all([writer.apply(first), writer.apply(second)]);

  assert.equal(
    writer.users.get(USER_ID)?.subscribedUntil?.getTime(),
    PAID_UNTIL.getTime() + GRACE_PERIOD_DAYS * 86_400_000
  );
  assert.equal(writer.updateCount, 1);
  assert.equal(writer.events.has(first.eventId), true);
  assert.equal(writer.events.has(second.eventId), true);
});

test("a late Checkout reference cannot replace later paid authority", async () => {
  const laterSubscription = "sub_later";
  const writer = new MemoryStripeEventWriter([
    {
      ...paidUser(),
      billingPeriodStart: NEXT_PERIOD_END,
      stripeSubscriptionId: laterSubscription,
      subscribedUntil: new Date("2026-11-20T12:00:00.000Z"),
    },
  ]);

  assert.equal(
    await writer.apply({
      customerId: "cus_webhook",
      eventId: "evt_checkout_stale",
      eventType: "checkout_reference",
      stripeSubscriptionId: "sub_webhook",
      userId: USER_ID,
    }),
    "applied"
  );

  assert.equal(
    writer.users.get(USER_ID)?.stripeSubscriptionId,
    laterSubscription
  );
  assert.equal(writer.updateCount, 0);
  assert.equal(writer.events.has("evt_checkout_stale"), true);
});

test("paid authority replaces an unbacked Checkout subscription reference", async () => {
  const writer = new MemoryStripeEventWriter([
    {
      billingPeriodStart: null,
      id: USER_ID,
      stripeCustomerId: null,
      stripeSubscriptionId: null,
      subscribedUntil: null,
    },
  ]);
  const checkoutReference: StripeEventUpdateInput = {
    customerId: "cus_webhook",
    eventId: "evt_checkout_sub_a",
    eventType: "checkout_reference",
    stripeSubscriptionId: "sub_A",
    userId: USER_ID,
  };
  const paid = paidIntent({
    eventId: "evt_paid_replacement",
    periodEnd: PAID_UNTIL,
    periodStart: PAID_FROM,
    stripeSubscriptionId: "sub_B",
  });

  assert.equal(await writer.apply(checkoutReference), "applied");
  assert.equal(writer.users.get(USER_ID)?.stripeSubscriptionId, "sub_A");
  assert.equal(await writer.apply(paid), "applied");
  assert.deepEqual(writer.users.get(USER_ID), {
    billingPeriodStart: PAID_FROM,
    id: USER_ID,
    stripeCustomerId: "cus_webhook",
    stripeSubscriptionId: "sub_B",
    subscribedUntil: PAID_UNTIL,
  });
  assert.equal(writer.events.has(paid.eventId), true);
});

test("initial failure cannot block a later paid replacement subscription", async () => {
  const writer = new MemoryStripeEventWriter([
    {
      billingPeriodStart: null,
      id: USER_ID,
      stripeCustomerId: "cus_webhook",
      stripeSubscriptionId: null,
      subscribedUntil: null,
    },
  ]);
  const failed = failedIntent("evt_initial_sub_a", {
    billingReason: "subscription_create",
    stripeSubscriptionId: "sub_A",
  });
  const paid = paidIntent({
    eventId: "evt_paid_sub_b",
    periodEnd: PAID_UNTIL,
    periodStart: PAID_FROM,
    stripeSubscriptionId: "sub_B",
  });

  assert.equal(await writer.apply(failed), "applied");
  assert.deepEqual(writer.users.get(USER_ID), {
    billingPeriodStart: null,
    id: USER_ID,
    stripeCustomerId: "cus_webhook",
    stripeSubscriptionId: null,
    subscribedUntil: null,
  });

  assert.equal(await writer.apply(paid), "applied");
  assert.deepEqual(writer.users.get(USER_ID), {
    billingPeriodStart: PAID_FROM,
    id: USER_ID,
    stripeCustomerId: "cus_webhook",
    stripeSubscriptionId: "sub_B",
    subscribedUntil: PAID_UNTIL,
  });
});

test("stale paid and failed events cannot replace newer paid subscription authority", async () => {
  const newerEnd = new Date("2026-11-20T12:00:00.000Z");
  const writer = new MemoryStripeEventWriter([
    {
      ...paidUser(),
      billingPeriodStart: NEXT_PERIOD_END,
      stripeSubscriptionId: "sub_B",
      subscribedUntil: newerEnd,
    },
  ]);
  const stalePaid = paidIntent({
    eventId: "evt_stale_paid_sub_a",
    periodEnd: NEXT_PERIOD_END,
    periodStart: PAID_UNTIL,
    stripeSubscriptionId: "sub_A",
  });
  const staleFailure = failedIntent("evt_stale_failed_sub_a", {
    stripeSubscriptionId: "sub_A",
  });

  assert.deepEqual(await writer.apply(stalePaid), {
    kind: "manual_reconciliation",
    record: {
      eventId: stalePaid.eventId,
      eventType: "invoice.paid",
      reason: "invoice_conflicting_paid_interval",
      status: "pending",
    },
  });
  assert.equal(await writer.apply(staleFailure), "applied");
  assert.deepEqual(writer.users.get(USER_ID), {
    ...paidUser(),
    billingPeriodStart: NEXT_PERIOD_END,
    stripeSubscriptionId: "sub_B",
    subscribedUntil: newerEnd,
  });
  assert.equal(writer.updateCount, 0);
  assert.equal(writer.reconciliations.has(stalePaid.eventId), true);
});

test("a newer paid period can replace an older paid subscription ID", async () => {
  const writer = new MemoryStripeEventWriter([
    {
      ...paidUser(),
      stripeSubscriptionId: "sub_A",
    },
  ]);
  const replacement = paidIntent({
    eventId: "evt_newer_paid_sub_b",
    periodEnd: NEXT_PERIOD_END,
    periodStart: PAID_UNTIL,
    stripeSubscriptionId: "sub_B",
  });

  assert.equal(await writer.apply(replacement), "applied");
  assert.deepEqual(writer.users.get(USER_ID), {
    ...paidUser(),
    billingPeriodStart: PAID_UNTIL,
    stripeSubscriptionId: "sub_B",
    subscribedUntil: NEXT_PERIOD_END,
  });
});

test("a different subscription replaces only with an exact non-overlapping paid interval", () => {
  const current = {
    ...paidUser(),
    stripeSubscriptionId: "sub_A",
  };
  const replacement = paidIntent({
    eventId: "evt_exact_replacement",
    periodEnd: NEXT_PERIOD_END,
    periodStart: PAID_UNTIL,
    stripeSubscriptionId: "sub_B",
  });

  assert.deepEqual(stripeEventMutation(current, replacement), {
    billingPeriodStart: PAID_UNTIL,
    stripeSubscriptionId: "sub_B",
    subscribedUntil: NEXT_PERIOD_END,
  });
});

test("a provisional subscription reference can be replaced by one exact paid interval", () => {
  const current: WebhookUser = {
    billingPeriodStart: null,
    id: USER_ID,
    stripeCustomerId: "cus_webhook",
    stripeSubscriptionId: "sub_provisional",
    subscribedUntil: null,
  };
  const paid = paidIntent({
    eventId: "evt_provisional_replacement",
    periodEnd: PAID_UNTIL,
    periodStart: PAID_FROM,
    stripeSubscriptionId: "sub_paid",
  });

  assert.deepEqual(stripeEventMutation(current, paid), {
    billingPeriodStart: PAID_FROM,
    stripeSubscriptionId: "sub_paid",
    subscribedUntil: PAID_UNTIL,
  });
});

test("a same-subscription renewal advances the exact paid interval", () => {
  const renewed = paidIntent({
    eventId: "evt_same_subscription_renewal",
    periodEnd: NEXT_PERIOD_END,
    periodStart: PAID_UNTIL,
    stripeSubscriptionId: "sub_webhook",
  });

  assert.deepEqual(stripeEventMutation(paidUser(), renewed), {
    billingPeriodStart: PAID_UNTIL,
    stripeSubscriptionId: "sub_webhook",
    subscribedUntil: NEXT_PERIOD_END,
  });
});

test("overlapping replacement intervals require manual reconciliation regardless of end", () => {
  const current = {
    ...paidUser(),
    stripeSubscriptionId: "sub_A",
  };
  const overlappingStart = new Date("2026-09-01T12:00:00.000Z");

  for (const [label, periodEnd] of [
    ["shorter", new Date("2026-09-10T12:00:00.000Z")],
    ["equal", PAID_UNTIL],
    ["later", NEXT_PERIOD_END],
  ] as const) {
    assert.deepEqual(
      stripeEventMutation(
        current,
        paidIntent({
          eventId: `evt_overlap_${label}`,
          periodEnd,
          periodStart: overlappingStart,
          stripeSubscriptionId: "sub_B",
        })
      ),
      {
        kind: "manual_reconciliation",
        reason: "invoice_conflicting_paid_interval",
      },
      label
    );
  }
});

test("an old failure for another subscription cannot mutate or grant grace", () => {
  assert.equal(
    stripeEventMutation(
      paidUser(),
      failedIntent("evt_old_other_failure", {
        stripeSubscriptionId: "sub_old",
      })
    ),
    null
  );
});

test("a conflicting Stripe Customer owner rejects the mutation", () => {
  assert.throws(
    () =>
      stripeEventMutation(
        { ...paidUser(), stripeCustomerId: "cus_other" },
        paidIntent({
          eventId: "evt_customer_conflict",
          periodEnd: NEXT_PERIOD_END,
          periodStart: PAID_UNTIL,
        })
      ),
    /Customer owner does not match/
  );
});

test("webhook admission precedes body parsing and Stripe work", async () => {
  const calls: string[] = [];
  const response = await webhookResponse(
    request({
      onBodyRead: () => calls.push("body"),
      signature: "valid",
    }),
    dependenciesFor(
      checkoutEvent({
        id: "evt_order",
        paymentStatus: "paid",
      }),
      {
        createProvider: () => {
          calls.push("provider");
          return {
            constructEvent: () => {
              calls.push("signature");
              return Promise.resolve(
                checkoutEvent({
                  id: "evt_order",
                  paymentStatus: "paid",
                })
              );
            },
            listInvoiceLines: () => {
              throw new Error("unexpected invoice line lookup");
            },
            retrieveCustomer: () => {
              throw new Error("unexpected Customer lookup");
            },
          };
        },
        enforceAbuse: () => {
          calls.push("abuse");
          return Promise.resolve({ kind: "allowed" });
        },
        getConfig: () => {
          calls.push("configuration");
          return {
            apiKey: "sk_test_webhook",
            priceId: PRICE_ID,
            webhookSecret: "whsec_test",
          };
        },
      }
    ),
    "192.0.2.1"
  );

  assert.equal(response.status, 200);
  assert.equal(calls[0], "abuse");
  assert.ok(calls.indexOf("body") > calls.indexOf("abuse"));
  assert.ok(calls.indexOf("provider") > calls.indexOf("abuse"));
  assert.ok(calls.indexOf("signature") > calls.indexOf("abuse"));
});

test("abuse denial stops before body parsing and Stripe work", async () => {
  const calls: string[] = [];
  const response = await webhookResponse(
    request({
      onBodyRead: () => calls.push("body"),
      signature: "valid",
    }),
    dependenciesFor(
      checkoutEvent({
        id: "evt_denied",
        paymentStatus: "paid",
      }),
      {
        createProvider: () => {
          calls.push("provider");
          throw new Error("Stripe must not be created");
        },
        enforceAbuse: () => {
          calls.push("abuse");
          return Promise.resolve({
            kind: "denied" as const,
            responseStatus: 429 as const,
            retryAfterSeconds: 42,
          });
        },
        getConfig: () => {
          calls.push("configuration");
          throw new Error("configuration must not be read");
        },
      }
    ),
    "192.0.2.2"
  );

  assert.equal(response.status, 429);
  assert.equal(response.headers.get("retry-after"), "42");
  assert.deepEqual(calls, ["abuse"]);
});

test("declared oversized webhooks return 413 before provider construction", async () => {
  let providerCalls = 0;
  const response = await webhookResponse(
    request({
      body: new Uint8Array([1]),
      headers: { "content-length": "262145" },
      signature: "valid",
    }),
    dependenciesFor(
      checkoutEvent({
        id: "evt_declared_too_large",
        paymentStatus: "paid",
      }),
      {
        createProvider: () => {
          providerCalls += 1;
          throw new Error("provider must not be created");
        },
      }
    ),
    null
  );

  assert.equal(response.status, 413);
  assert.equal(providerCalls, 0);
});

test("chunked webhooks crossing the byte limit return 413 before provider construction", async () => {
  let providerCalls = 0;
  const body = new ReadableStream<Uint8Array>({
    start(controller) {
      controller.enqueue(new Uint8Array(262_144));
      controller.enqueue(new Uint8Array([1]));
    },
  });
  const response = await webhookResponse(
    request({ body, signature: "valid" }),
    dependenciesFor(
      checkoutEvent({
        id: "evt_stream_too_large",
        paymentStatus: "paid",
      }),
      {
        createProvider: () => {
          providerCalls += 1;
          throw new Error("provider must not be created");
        },
      }
    ),
    null
  );

  assert.equal(response.status, 413);
  assert.equal(providerCalls, 0);
});

test("an exact-limit webhook reaches signature verification with exact bytes", async () => {
  const expected = new Uint8Array(262_144);
  expected.set(new TextEncoder().encode("exact"));
  let verified: Uint8Array | null = null;
  const event = checkoutEvent({
    id: "evt_exact_limit",
    paymentStatus: "paid",
  });
  const response = await webhookResponse(
    request({
      body: expected,
      headers: { "content-length": String(expected.byteLength) },
      signature: "valid",
    }),
    dependenciesFor(event, {
      createProvider: () => ({
        constructEvent: (raw) => {
          verified = raw;
          return Promise.resolve(event);
        },
        listInvoiceLines: () => {
          throw new Error("unexpected invoice line lookup");
        },
        retrieveCustomer: () => {
          throw new Error("unexpected Customer lookup");
        },
      }),
    }),
    null
  );

  assert.equal(response.status, 200);
  assert.deepEqual(verified, expected);
});

test("multibyte webhook payloads are verified without Unicode re-encoding", async () => {
  const expected = new TextEncoder().encode('{"magic":"🧙🏽‍♀️"}');
  const body = new ReadableStream<Uint8Array>({
    start(controller) {
      controller.enqueue(expected.subarray(0, 13));
      controller.enqueue(expected.subarray(13));
      controller.close();
    },
  });
  let verified: Uint8Array | null = null;
  const event = checkoutEvent({
    id: "evt_multibyte",
    paymentStatus: "paid",
  });
  const response = await webhookResponse(
    request({ body, signature: "valid" }),
    dependenciesFor(event, {
      createProvider: () => ({
        constructEvent: (raw) => {
          verified = raw;
          return Promise.resolve(event);
        },
        listInvoiceLines: () => {
          throw new Error("unexpected invoice line lookup");
        },
        retrieveCustomer: () => {
          throw new Error("unexpected Customer lookup");
        },
      }),
    }),
    null
  );

  assert.equal(response.status, 200);
  assert.deepEqual(verified, expected);
});

test("webhook stream failures are retryable and do not construct Stripe", async () => {
  let providerCalls = 0;
  const body = new ReadableStream<Uint8Array>({
    pull(controller) {
      controller.error(new Error("stream failed"));
    },
  });
  const response = await webhookResponse(
    request({ body, signature: "valid" }),
    dependenciesFor(
      checkoutEvent({
        id: "evt_stream_error",
        paymentStatus: "paid",
      }),
      {
        createProvider: () => {
          providerCalls += 1;
          throw new Error("provider must not be created");
        },
      }
    ),
    null
  );

  assert.equal(response.status, 503);
  assert.equal(providerCalls, 0);
});

test("missing and bad signatures mutate nothing", async (t) => {
  await t.test("missing signature", async () => {
    let bodyReads = 0;
    let providerCalls = 0;
    let writes = 0;
    const response = await webhookResponse(
      request({
        onBodyRead: () => {
          bodyReads += 1;
        },
      }),
      dependenciesFor(
        checkoutEvent({
          id: "evt_unsigned",
          paymentStatus: "paid",
        }),
        {
          applyEventUpdate: () => {
            writes += 1;
            return Promise.resolve("applied");
          },
          createProvider: () => {
            providerCalls += 1;
            throw new Error("Stripe must not be created");
          },
        }
      ),
      null
    );

    assert.equal(response.status, 400);
    assert.equal(bodyReads, 0);
    assert.equal(providerCalls, 0);
    assert.equal(writes, 0);
  });

  await t.test("bad signature", async () => {
    let writes = 0;
    const response = await webhookResponse(
      request({ signature: "bad" }),
      dependenciesFor(
        checkoutEvent({
          id: "evt_bad_signature",
          paymentStatus: "paid",
        }),
        {
          applyEventUpdate: () => {
            writes += 1;
            return Promise.resolve("applied");
          },
          createProvider: () => ({
            constructEvent: () => Promise.reject(new Error("bad signature")),
            listInvoiceLines: () => {
              throw new Error("unexpected invoice line lookup");
            },
            retrieveCustomer: () => {
              throw new Error("unexpected Customer lookup");
            },
          }),
        }
      ),
      null
    );

    assert.equal(response.status, 400);
    assert.equal(writes, 0);
  });
});

test("duplicate events do not update a User twice", async () => {
  const writer = new MemoryStripeEventWriter([
    {
      billingPeriodStart: null,
      id: USER_ID,
      stripeCustomerId: null,
      stripeSubscriptionId: null,
      subscribedUntil: null,
    },
  ]);
  const event = checkoutEvent({
    id: "evt_duplicate",
    paymentStatus: "paid",
  });
  const dependencies = dependenciesFor(event, {
    applyEventUpdate: writer.apply,
  });

  const first = await webhookResponse(
    request({ signature: "valid" }),
    dependencies,
    null
  );
  const duplicate = await webhookResponse(
    request({ signature: "valid" }),
    dependencies,
    null
  );

  assert.equal(first.status, 200);
  assert.equal(duplicate.status, 200);
  assert.deepEqual(await duplicate.json(), { deduped: true });
  assert.equal(writer.updateCount, 1);
});

test("a failed database application rolls back its event claim for retry", async () => {
  const writer = new MemoryStripeEventWriter([
    {
      billingPeriodStart: PAID_FROM,
      id: USER_ID,
      stripeCustomerId: "cus_webhook",
      stripeSubscriptionId: "sub_webhook",
      subscribedUntil: PAID_UNTIL,
    },
  ]);
  writer.failNextUpdate = true;
  const event = invoiceEvent({
    id: "evt_retry",
    periodEnd: NEXT_PERIOD_END,
    periodStart: PAID_UNTIL,
    type: "invoice.paid",
  });
  const dependencies = dependenciesFor(event, {
    applyEventUpdate: writer.apply,
    findUserByStripeCustomerId: writer.findByCustomer,
  });

  const failed = await webhookResponse(
    request({ signature: "valid" }),
    dependencies,
    null
  );

  assert.equal(failed.status, 503);
  assert.equal(writer.events.has(event.id), false);

  const retried = await webhookResponse(
    request({ signature: "valid" }),
    dependencies,
    null
  );

  assert.equal(retried.status, 200);
  assert.equal(writer.events.has(event.id), true);
  assert.equal(writer.updateCount, 1);
  assert.equal(
    writer.users.get(USER_ID)?.subscribedUntil?.toISOString(),
    NEXT_PERIOD_END.toISOString()
  );
});

test("an unresolved owner stays unclaimed and returns a retryable failure", async () => {
  const writer = new MemoryStripeEventWriter([]);
  const event = invoiceEvent({
    id: "evt_unresolved",
    type: "invoice.paid",
  });
  const response = await webhookResponse(
    request({ signature: "valid" }),
    dependenciesFor(event, {
      applyEventUpdate: writer.apply,
      createProvider: () => ({
        constructEvent: () => Promise.resolve(event),
        listInvoiceLines: () => {
          throw new Error("unexpected invoice line lookup");
        },
        retrieveCustomer: () =>
          Promise.resolve({
            deleted: false,
            id: "cus_webhook",
            metadata: {
              checkoutAttemptId: CHECKOUT_ATTEMPT_ID,
              checkoutFlowVersion: "1",
              userId: USER_ID,
            },
            object: "customer",
          }),
      }),
      findCheckoutAttemptState: () =>
        Promise.resolve({
          customerId: "cus_webhook",
          kind: "customer_created",
        }),
      findUserByStripeCustomerId: () => Promise.resolve(null),
    }),
    null
  );

  assert.equal(response.status, 503);
  assert.equal(writer.events.has(event.id), false);
});

test("paid Checkout completion links references without granting a period", async () => {
  const writes: StripeEventUpdateInput[] = [];
  const response = await webhookResponse(
    request({ signature: "valid" }),
    dependenciesFor(
      checkoutEvent({
        id: "evt_checkout_paid",
        paymentStatus: "paid",
      }),
      {
        applyEventUpdate: (input) => {
          writes.push(input);
          return Promise.resolve("applied");
        },
      }
    ),
    null
  );

  assert.equal(response.status, 200);
  assert.deepEqual(writes, [
    {
      customerId: "cus_webhook",
      eventId: "evt_checkout_paid",
      eventType: "checkout_reference",
      stripeSubscriptionId: "sub_webhook",
      userId: USER_ID,
    },
  ]);
});

test("unpaid Checkout completion is unrelated to the app-owned paid flow", async () => {
  let writes = 0;
  const response = await webhookResponse(
    request({ signature: "valid" }),
    dependenciesFor(
      checkoutEvent({
        id: "evt_checkout_unpaid",
        paymentStatus: "unpaid",
      }),
      {
        applyEventUpdate: () => {
          writes += 1;
          return Promise.resolve("applied");
        },
      }
    ),
    null
  );

  assert.equal(response.status, 200);
  assert.deepEqual(await response.json(), {
    ignored: true,
    reason: "checkout_unrelated",
  });
  assert.equal(writes, 0);
});

test("Checkout reference events require every app-owned flow marker", async (t) => {
  const cases: Array<{
    name: string;
    session: Partial<Stripe.Checkout.Session>;
  }> = [
    {
      name: "Payment Link or foreign integration",
      session: {
        client_reference_id: null,
        integration_identifier: null,
        metadata: {},
      },
    },
    { name: "missing mode", session: { mode: undefined } },
    {
      name: "non-subscription mode",
      session: { mode: "payment" },
    },
    {
      name: "missing client reference",
      session: { client_reference_id: null },
    },
    {
      name: "missing metadata user",
      session: {
        metadata: {
          checkoutAttemptId: CHECKOUT_ATTEMPT_ID,
          checkoutFlowVersion: "1",
          priceId: PRICE_ID,
        },
      },
    },
    {
      name: "mismatched user markers",
      session: {
        metadata: {
          checkoutAttemptId: CHECKOUT_ATTEMPT_ID,
          checkoutFlowVersion: "1",
          priceId: PRICE_ID,
          userId: "4f2504e0-4f89-41d3-9a0c-0305e82c3301",
        },
      },
    },
    {
      name: "missing flow version",
      session: {
        metadata: {
          checkoutAttemptId: CHECKOUT_ATTEMPT_ID,
          priceId: PRICE_ID,
          userId: USER_ID,
        },
      },
    },
    {
      name: "wrong flow version",
      session: {
        metadata: {
          checkoutAttemptId: CHECKOUT_ATTEMPT_ID,
          checkoutFlowVersion: "0",
          priceId: PRICE_ID,
          userId: USER_ID,
        },
      },
    },
    {
      name: "missing price",
      session: {
        metadata: {
          checkoutAttemptId: CHECKOUT_ATTEMPT_ID,
          checkoutFlowVersion: "1",
          userId: USER_ID,
        },
      },
    },
    {
      name: "wrong price",
      session: {
        metadata: {
          checkoutAttemptId: CHECKOUT_ATTEMPT_ID,
          checkoutFlowVersion: "1",
          priceId: "price_other",
          userId: USER_ID,
        },
      },
    },
    {
      name: "missing attempt id",
      session: {
        metadata: {
          checkoutFlowVersion: "1",
          priceId: PRICE_ID,
          userId: USER_ID,
        },
      },
    },
    {
      name: "invalid attempt id",
      session: {
        metadata: {
          checkoutAttemptId: "attempt-not-durable",
          checkoutFlowVersion: "1",
          priceId: PRICE_ID,
          userId: USER_ID,
        },
      },
    },
    {
      name: "missing integration identifier",
      session: { integration_identifier: null },
    },
    {
      name: "wrong integration identifier",
      session: { integration_identifier: "opencoven_coven_agents_aaaaaaaa" },
    },
    {
      name: "missing Customer",
      session: { customer: null },
    },
    {
      name: "invalid Customer",
      session: { customer: "customer_foreign" },
    },
    {
      name: "missing Subscription",
      session: { subscription: null },
    },
    {
      name: "invalid Subscription",
      session: { subscription: "subscription_foreign" },
    },
  ];

  await Promise.all(
    cases.map(({ name, session }) =>
      t.test(name, async () => {
        let reconciliations = 0;
        let writes = 0;
        const response = await webhookResponse(
          request({ signature: "valid" }),
          dependenciesFor(
            checkoutEvent({
              id: `evt_checkout_marker_${name.replaceAll(" ", "_")}`,
              paymentStatus: "paid",
              session,
            }),
            {
              applyEventUpdate: () => {
                writes += 1;
                return Promise.resolve("applied");
              },
              recordManualReconciliation: (record) => {
                reconciliations += 1;
                return Promise.resolve({
                  kind: "manual_reconciliation",
                  record,
                });
              },
            }
          ),
          null
        );

        assert.equal(response.status, 200);
        assert.deepEqual(await response.json(), {
          ignored: true,
          reason: "checkout_unrelated",
        });
        assert.equal(writes, 0);
        assert.equal(reconciliations, 0);
      })
    )
  );
});

test("Checkout reference events accept valid string and expanded IDs", async (t) => {
  await Promise.all(
    [false, true].map((expanded) =>
      t.test(expanded ? "expanded objects" : "string IDs", async () => {
        const writes: StripeEventUpdateInput[] = [];
        const event = checkoutEvent({
          expanded,
          id: `evt_checkout_${expanded ? "expanded" : "string"}`,
          paymentStatus: "paid",
        });
        const response = await webhookResponse(
          request({ signature: "valid" }),
          dependenciesFor(event, {
            applyEventUpdate: (input) => {
              writes.push(input);
              return Promise.resolve("applied");
            },
          }),
          null
        );

        assert.equal(response.status, 200);
        assert.equal(writes[0]?.customerId, "cus_webhook");
        assert.equal(writes[0]?.stripeSubscriptionId, "sub_webhook");
      })
    )
  );
});

test("Checkout reference rejects missing, foreign, malformed, retired, or unrelated local attempt state", async (t) => {
  const cases: Array<{
    name: string;
    state: CheckoutAttemptState | null;
  }> = [
    { name: "missing", state: null },
    {
      name: "other Customer",
      state: {
        customerId: "cus_other",
        kind: "session_created",
        sessionId: "cs_webhook",
      },
    },
    {
      name: "other Session",
      state: {
        customerId: "cus_webhook",
        kind: "session_created",
        sessionId: "cs_other",
      },
    },
    { name: "malformed", state: { kind: "invalid" } },
    { name: "retired", state: null },
    { name: "unrelated", state: { kind: "fresh" } },
  ];

  await Promise.all(
    cases.map(({ name, state }) =>
      t.test(name, async () => {
        let writes = 0;
        const event = checkoutEvent({
          id: `evt_checkout_provenance_${name.replaceAll(" ", "_")}`,
          paymentStatus: "paid",
        });
        const response = await webhookResponse(
          request({ signature: "valid" }),
          dependenciesFor(event, {
            applyEventUpdate: () => {
              writes += 1;
              return Promise.resolve("applied");
            },
            findCheckoutAttemptState: () => Promise.resolve(state),
          }),
          null
        );

        assert.equal(response.status, 200);
        assert.deepEqual(await response.json(), {
          ignored: true,
          reason: "checkout_unrelated",
        });
        assert.equal(writes, 0);
      })
    )
  );
});

test("Checkout reference local attempt lookup is scoped to its exact owner", async () => {
  let lookup: { attemptId: string; ownerId: string } | null = null;
  let writes = 0;
  const event = checkoutEvent({
    id: "evt_checkout_other_owner",
    paymentStatus: "paid",
  });
  const response = await webhookResponse(
    request({ signature: "valid" }),
    dependenciesFor(event, {
      applyEventUpdate: () => {
        writes += 1;
        return Promise.resolve("applied");
      },
      findCheckoutAttemptState: (input) => {
        lookup = input;
        return Promise.resolve(null);
      },
    }),
    null
  );

  assert.deepEqual(lookup, {
    attemptId: CHECKOUT_ATTEMPT_ID,
    ownerId: USER_ID,
  });
  assert.equal(response.status, 200);
  assert.equal(writes, 0);
});

test("async Checkout payment success follows paid reference linking", async () => {
  const writes: StripeEventUpdateInput[] = [];
  const response = await webhookResponse(
    request({ signature: "valid" }),
    dependenciesFor(
      checkoutEvent({
        id: "evt_checkout_async",
        paymentStatus: "paid",
        type: "checkout.session.async_payment_succeeded",
      }),
      {
        applyEventUpdate: (input) => {
          writes.push(input);
          return Promise.resolve("applied");
        },
      }
    ),
    null
  );

  assert.equal(response.status, 200);
  assert.deepEqual(writes, [
    {
      customerId: "cus_webhook",
      eventId: "evt_checkout_async",
      eventType: "checkout_reference",
      stripeSubscriptionId: "sub_webhook",
      userId: USER_ID,
    },
  ]);
});

test("persisted Customer ownership is used before Stripe metadata retrieval", async () => {
  const writes: StripeEventUpdateInput[] = [];
  let retrievals = 0;
  const event = invoiceEvent({
    id: "evt_persisted_customer_owner",
    type: "invoice.paid",
  });
  const response = await webhookResponse(
    request({ signature: "valid" }),
    dependenciesFor(event, {
      applyEventUpdate: (input) => {
        writes.push(input);
        return Promise.resolve("applied");
      },
      createProvider: () => ({
        constructEvent: () => Promise.resolve(event),
        listInvoiceLines: () => {
          throw new Error("unexpected invoice line lookup");
        },
        retrieveCustomer: () => {
          retrievals += 1;
          throw new Error("persisted owner must avoid Customer retrieval");
        },
      }),
      findUserByStripeCustomerId: () => Promise.resolve(paidUser()),
    }),
    null
  );

  assert.equal(response.status, 200);
  assert.equal(retrievals, 0);
  assert.deepEqual(writes, [
    {
      billingReason: "subscription_cycle",
      customerId: "cus_webhook",
      eventId: event.id,
      eventType: "invoice_paid",
      periodEnd: NEXT_PERIOD_END,
      periodStart: PAID_UNTIL,
      stripeSubscriptionId: "sub_webhook",
    },
  ]);
});

test("persisted Customer ownership ignores stale expanded Customer metadata", async () => {
  const writes: StripeEventUpdateInput[] = [];
  const event = invoiceEvent({
    customerMetadata: {
      checkoutAttemptId: "22222222-2222-4222-8222-222222222222",
      checkoutFlowVersion: "1",
      userId: "4f2504e0-4f89-41d3-9a0c-0305e82c3301",
    },
    expanded: true,
    id: "evt_stale_customer_metadata",
    type: "invoice.paid",
  });
  const response = await webhookResponse(
    request({ signature: "valid" }),
    dependenciesFor(event, {
      applyEventUpdate: (input) => {
        writes.push(input);
        return Promise.resolve("applied");
      },
      findUserByStripeCustomerId: () => Promise.resolve(paidUser()),
    }),
    null
  );

  assert.equal(response.status, 200);
  assert.equal(writes.length, 1);
  assert.equal(writes[0]?.userId, undefined);
});

test("synthetic same-account invoice fallback requires matching local attempt provenance", async () => {
  const writes: StripeEventUpdateInput[] = [];
  let retrievals = 0;
  const event = invoiceEvent({
    id: "evt_local_attempt_fallback",
    type: "invoice.paid",
  });
  const response = await webhookResponse(
    request({ signature: "valid" }),
    dependenciesFor(event, {
      applyEventUpdate: (input) => {
        writes.push(input);
        return Promise.resolve("applied");
      },
      createProvider: () => ({
        constructEvent: () => Promise.resolve(event),
        listInvoiceLines: () => {
          throw new Error("unexpected invoice line lookup");
        },
        retrieveCustomer: () => {
          retrievals += 1;
          return Promise.resolve({
            id: "cus_webhook",
            metadata: {
              checkoutAttemptId: CHECKOUT_ATTEMPT_ID,
              checkoutFlowVersion: "1",
              userId: USER_ID,
            },
            object: "customer",
          });
        },
      }),
      findCheckoutAttemptState: ({ attemptId, ownerId }) => {
        assert.equal(attemptId, CHECKOUT_ATTEMPT_ID);
        assert.equal(ownerId, USER_ID);
        return Promise.resolve({
          customerId: "cus_webhook",
          kind: "customer_created",
        });
      },
      findUserByStripeCustomerId: () => Promise.resolve(null),
    }),
    null
  );

  assert.equal(response.status, 200);
  assert.equal(retrievals, 1);
  assert.equal(writes[0]?.userId, USER_ID);
});

test("unmapped Customer without bounded application metadata is ignored", async () => {
  let attemptLookups = 0;
  let writes = 0;
  const event = invoiceEvent({
    customerMetadata: {},
    expanded: true,
    id: "evt_foreign_customer_metadata",
    type: "invoice.paid",
  });
  const response = await webhookResponse(
    request({ signature: "valid" }),
    dependenciesFor(event, {
      applyEventUpdate: () => {
        writes += 1;
        return Promise.resolve("applied");
      },
      findCheckoutAttemptState: () => {
        attemptLookups += 1;
        return Promise.resolve(null);
      },
      findUserByStripeCustomerId: () => Promise.resolve(null),
    }),
    null
  );

  assert.equal(response.status, 200);
  assert.deepEqual(await response.json(), {
    ignored: true,
    reason: "invoice_unrelated_customer",
  });
  assert.equal(attemptLookups, 0);
  assert.equal(writes, 0);
});

test("unmapped Customer metadata cannot borrow another owner's local attempt", async () => {
  let writes = 0;
  const otherUserId = "4f2504e0-4f89-41d3-9a0c-0305e82c3301";
  const event = invoiceEvent({
    customerMetadata: {
      checkoutAttemptId: CHECKOUT_ATTEMPT_ID,
      checkoutFlowVersion: "1",
      userId: otherUserId,
    },
    expanded: true,
    id: "evt_other_owner_attempt",
    type: "invoice.paid",
  });
  const response = await webhookResponse(
    request({ signature: "valid" }),
    dependenciesFor(event, {
      applyEventUpdate: () => {
        writes += 1;
        return Promise.resolve("applied");
      },
      findCheckoutAttemptState: ({ ownerId }) =>
        Promise.resolve(
          ownerId === USER_ID
            ? { customerId: "cus_webhook", kind: "customer_created" }
            : null
        ),
      findUserByStripeCustomerId: () => Promise.resolve(null),
    }),
    null
  );

  assert.equal(response.status, 200);
  assert.deepEqual(await response.json(), {
    ignored: true,
    reason: "invoice_unrelated_customer",
  });
  assert.equal(writes, 0);
});

test("unmapped Customer fallback rejects missing, foreign, malformed, and retired attempt state", async (t) => {
  const cases: Array<{
    name: string;
    state: CheckoutAttemptState | null;
    status: 200 | 503;
  }> = [
    { name: "missing", state: null, status: 200 },
    {
      name: "other Customer",
      state: { customerId: "cus_other", kind: "customer_created" },
      status: 200,
    },
    { name: "malformed", state: { kind: "invalid" }, status: 200 },
    { name: "retired", state: null, status: 200 },
    { name: "fresh", state: { kind: "fresh" }, status: 503 },
    {
      name: "create uncertain",
      state: { kind: "create_uncertain" },
      status: 503,
    },
    {
      name: "unrelated",
      state: { kind: "session_created", sessionId: "cs_legacy" },
      status: 200,
    },
  ];

  await Promise.all(
    cases.map(({ name, state, status }) =>
      t.test(name, async () => {
        let writes = 0;
        const event = invoiceEvent({
          id: `evt_unmapped_${name.replaceAll(" ", "_")}`,
          type: "invoice.paid",
        });
        const response = await webhookResponse(
          request({ signature: "valid" }),
          dependenciesFor(event, {
            applyEventUpdate: () => {
              writes += 1;
              return Promise.resolve("applied");
            },
            findCheckoutAttemptState: () => Promise.resolve(state),
            findUserByStripeCustomerId: () => Promise.resolve(null),
          }),
          null
        );

        assert.equal(response.status, status);
        if (status === 200) {
          assert.deepEqual(await response.json(), {
            ignored: true,
            reason: "invoice_unrelated_customer",
          });
        }
        assert.equal(writes, 0);
      })
    )
  );
});

test("invoice.paid grants the exact Stripe invoice period", async () => {
  const writes: StripeEventUpdateInput[] = [];
  const event = invoiceEvent({
    id: "evt_invoice_paid",
    periodEnd: NEXT_PERIOD_END,
    periodStart: PAID_UNTIL,
    type: "invoice.paid",
  });
  const response = await webhookResponse(
    request({ signature: "valid" }),
    dependenciesFor(event, {
      applyEventUpdate: (input) => {
        writes.push(input);
        return Promise.resolve("applied");
      },
      findUserByStripeCustomerId: () =>
        Promise.resolve({
          billingPeriodStart: PAID_FROM,
          id: USER_ID,
          stripeCustomerId: "cus_webhook",
          stripeSubscriptionId: "sub_webhook",
          subscribedUntil: PAID_UNTIL,
        }),
    }),
    null
  );

  assert.equal(response.status, 200);
  assert.deepEqual(writes, [
    {
      billingReason: "subscription_cycle",
      customerId: "cus_webhook",
      eventId: "evt_invoice_paid",
      eventType: "invoice_paid",
      periodEnd: NEXT_PERIOD_END,
      periodStart: PAID_UNTIL,
      stripeSubscriptionId: "sub_webhook",
    },
  ]);
});

test("only the configured genuine subscription line grants entitlement", async () => {
  const writes: StripeEventUpdateInput[] = [];
  const event = invoiceEvent({
    id: "evt_select_entitlement",
    lines: [
      invoiceLine({
        parentType: "invoice_item_details",
        periodEnd: new Date("2027-02-01T00:00:00.000Z"),
        periodStart: new Date("2027-01-01T00:00:00.000Z"),
      }),
      invoiceLine({ priceId: "price_other" }),
      {
        ...invoiceLine(),
        id: "il_supported",
      },
    ],
    type: "invoice.paid",
  });

  const response = await webhookResponse(
    request({ signature: "valid" }),
    dependenciesFor(event, {
      applyEventUpdate: (input) => {
        writes.push(input);
        return Promise.resolve("applied");
      },
      findUserByStripeCustomerId: () => Promise.resolve(paidUser()),
    }),
    null
  );

  assert.equal(response.status, 200);
  assert.equal(writes.length, 1);
  const write = onlyInvoiceWrite(writes);
  assert.equal(write.periodStart.toISOString(), PAID_UNTIL.toISOString());
  assert.equal(write.periodEnd.toISOString(), NEXT_PERIOD_END.toISOString());
});

test("a later paginated invoice line can supply the entitlement period", async () => {
  const writes: StripeEventUpdateInput[] = [];
  const pageCalls: Array<string | undefined> = [];
  const event = invoiceEvent({
    hasMore: true,
    id: "evt_paginated_line",
    lines: [invoiceLine({ parentType: "invoice_item_details" })],
    type: "invoice.paid",
  });
  const valid = { ...invoiceLine(), id: "il_later_supported" };
  const pages: Stripe.ApiList<Stripe.InvoiceLineItem>[] = [
    {
      data: [{ ...invoiceLine({ priceId: "price_other" }), id: "il_wrong" }],
      has_more: true,
      object: "list",
      url: "/v1/invoices/in_webhook/lines",
    },
    {
      data: [valid],
      has_more: false,
      object: "list",
      url: "/v1/invoices/in_webhook/lines",
    },
  ];

  const response = await webhookResponse(
    request({ signature: "valid" }),
    dependenciesFor(event, {
      applyEventUpdate: (input) => {
        writes.push(input);
        return Promise.resolve("applied");
      },
      createProvider: () => ({
        constructEvent: () => Promise.resolve(event),
        listInvoiceLines: (_invoiceId, startingAfter) => {
          pageCalls.push(startingAfter);
          const page = pages.shift();
          assert.ok(page);
          return Promise.resolve(page);
        },
        retrieveCustomer: () =>
          Promise.resolve({
            id: "cus_webhook",
            metadata: { userId: USER_ID },
            object: "customer",
          }),
      }),
      findUserByStripeCustomerId: () => Promise.resolve(paidUser()),
    }),
    null
  );

  assert.equal(response.status, 200);
  assert.deepEqual(pageCalls, [undefined, "il_wrong"]);
  assert.equal(writes.length, 1);
  assert.equal(writes[0]?.stripeSubscriptionId, "sub_webhook");
});

test("ambiguous entitlement invoices are claimed once for manual reconciliation", async () => {
  const writer = new MemoryStripeEventWriter([paidUser()]);
  const alerts: unknown[] = [];
  const event = invoiceEvent({
    id: "evt_duplicate_lines",
    lines: [
      { ...invoiceLine(), id: "il_duplicate_one" },
      { ...invoiceLine(), id: "il_duplicate_two" },
    ],
    type: "invoice.paid",
  });
  const response = await webhookResponse(
    request({ signature: "valid" }),
    dependenciesFor(event, {
      applyEventUpdate: writer.apply,
      recordManualReconciliation: writer.recordReconciliation,
      reportManualReconciliation: (alert) => {
        alerts.push(alert);
      },
    }),
    null
  );

  assert.equal(response.status, 200);
  assert.deepEqual(await response.json(), {
    reason: "invoice_ambiguous_entitlement",
    reconciliation: true,
  });
  assert.equal(writer.events.has(event.id), true);
  assert.equal(writer.updateCount, 0);
  assert.deepEqual(alerts, [
    {
      eventId: event.id,
      eventType: "invoice.paid",
      reason: "invoice_ambiguous_entitlement",
      status: "pending",
    },
  ]);
  assert.deepEqual(writer.reconciliations.get(event.id), alerts[0]);

  const duplicate = await webhookResponse(
    request({ signature: "valid" }),
    dependenciesFor(event, {
      applyEventUpdate: writer.apply,
      recordManualReconciliation: writer.recordReconciliation,
      reportManualReconciliation: (alert) => {
        alerts.push(alert);
      },
    }),
    null
  );

  assert.equal(duplicate.status, 200);
  assert.deepEqual(await duplicate.json(), { deduped: true });
  assert.equal(alerts.length, 1);
});

test("unrelated permanent invoices return 2xx without claims or User updates", async (t) => {
  const cases: Array<{
    event: Stripe.Event;
    name: string;
  }> = [
    {
      event: invoiceEvent({
        id: "evt_proration_only",
        lines: [invoiceLine({ proration: true })],
        type: "invoice.paid",
      }),
      name: "proration-only",
    },
    {
      event: invoiceEvent({
        id: "evt_wrong_price",
        lines: [invoiceLine({ priceId: "price_other" })],
        type: "invoice.paid",
      }),
      name: "wrong price",
    },
    {
      event: invoiceEvent({
        billingReason: "manual",
        id: "evt_manual",
        type: "invoice.paid",
      }),
      name: "manual",
    },
  ];

  await Promise.all(
    cases.map(({ event, name }) =>
      t.test(name, async () => {
        let reconciliations = 0;
        let writes = 0;
        const dependencies = dependenciesFor(event, {
          applyEventUpdate: () => {
            writes += 1;
            return Promise.resolve("applied");
          },
          recordManualReconciliation: (record) => {
            reconciliations += 1;
            return Promise.resolve({
              kind: "manual_reconciliation",
              record,
            });
          },
        });
        const first = await webhookResponse(
          request({ signature: "valid" }),
          dependencies,
          null
        );
        const repeated = await webhookResponse(
          request({ signature: "valid" }),
          dependencies,
          null
        );

        assert.equal(first.status, 200);
        assert.equal(repeated.status, 200);
        assert.equal(writes, 0);
        assert.equal(reconciliations, 0);
      })
    )
  );
});

test("malformed entitlement invoices are terminalized with sanitized reasons", async (t) => {
  const cases: Array<{
    event: Stripe.Event;
    reason: string;
  }> = [
    {
      event: invoiceEvent({
        id: "evt_malformed_period",
        lines: [
          invoiceLine({
            periodEnd: PAID_UNTIL,
            periodStart: NEXT_PERIOD_END,
          }),
        ],
        type: "invoice.paid",
      }),
      reason: "invoice_invalid_period",
    },
    {
      event: invoiceEvent({
        id: "evt_contradictory_subscription",
        lines: [
          {
            ...invoiceLine({ subscriptionId: "sub_line" }),
            parent: {
              ...invoiceLine({ subscriptionId: "sub_detail" }).parent,
            },
          } as Stripe.InvoiceLineItem,
        ],
        type: "invoice.paid",
      }),
      reason: "invoice_contradictory_subscription",
    },
  ];

  await Promise.all(
    cases.map(({ event, reason }) =>
      t.test(reason, async () => {
        const writer = new MemoryStripeEventWriter([paidUser()]);
        const alerts: Record<string, unknown>[] = [];
        const response = await webhookResponse(
          request({ signature: "valid" }),
          dependenciesFor(event, {
            applyEventUpdate: writer.apply,
            recordManualReconciliation: writer.recordReconciliation,
            reportManualReconciliation: (alert) => {
              alerts.push(alert);
            },
          }),
          null
        );

        assert.equal(response.status, 200);
        assert.equal(writer.events.has(event.id), true);
        assert.equal(writer.updateCount, 0);
        assert.deepEqual(alerts, [
          {
            eventId: event.id,
            eventType: "invoice.paid",
            reason,
            status: "pending",
          },
        ]);
        assert.deepEqual(Object.keys(alerts[0] ?? {}).sort(), [
          "eventId",
          "eventType",
          "reason",
          "status",
        ]);
      })
    )
  );
});

test("provider lookup failures remain retryable and unclaimed", async () => {
  const writer = new MemoryStripeEventWriter([paidUser()]);
  const event = invoiceEvent({
    hasMore: true,
    id: "evt_provider_failure",
    type: "invoice.paid",
  });
  const response = await webhookResponse(
    request({ signature: "valid" }),
    dependenciesFor(event, {
      applyEventUpdate: writer.apply,
      createProvider: () => ({
        constructEvent: () => Promise.resolve(event),
        listInvoiceLines: () => Promise.reject(new Error("Stripe unavailable")),
        retrieveCustomer: () => {
          throw new Error("unexpected Customer lookup");
        },
      }),
      recordManualReconciliation: writer.recordReconciliation,
    }),
    null
  );

  assert.equal(response.status, 503);
  assert.equal(writer.events.has(event.id), false);
  assert.equal(writer.updateCount, 0);
});

test("Customer retrieval failures remain retryable and unclaimed", async () => {
  const writer = new MemoryStripeEventWriter([paidUser()]);
  const event = invoiceEvent({
    id: "evt_customer_lookup_failure",
    type: "invoice.paid",
  });
  const response = await webhookResponse(
    request({ signature: "valid" }),
    dependenciesFor(event, {
      applyEventUpdate: writer.apply,
      createProvider: () => ({
        constructEvent: () => Promise.resolve(event),
        listInvoiceLines: () => {
          throw new Error("unexpected invoice line lookup");
        },
        retrieveCustomer: () => Promise.reject(new Error("Stripe unavailable")),
      }),
      findUserByStripeCustomerId: () => Promise.resolve(null),
      recordManualReconciliation: writer.recordReconciliation,
    }),
    null
  );

  assert.equal(response.status, 503);
  assert.equal(writer.events.has(event.id), false);
  assert.equal(writer.updateCount, 0);
});

test("manual reconciliation claim database failures remain retryable and unclaimed", async () => {
  const writer = new MemoryStripeEventWriter([paidUser()]);
  writer.failNextClaim = true;
  const event = invoiceEvent({
    id: "evt_claim_failure",
    lines: [
      { ...invoiceLine(), id: "il_duplicate_one" },
      { ...invoiceLine(), id: "il_duplicate_two" },
    ],
    type: "invoice.paid",
  });
  const alerts: unknown[] = [];
  const response = await webhookResponse(
    request({ signature: "valid" }),
    dependenciesFor(event, {
      applyEventUpdate: writer.apply,
      recordManualReconciliation: writer.recordReconciliation,
      reportManualReconciliation: (alert) => {
        alerts.push(alert);
      },
    }),
    null
  );

  assert.equal(response.status, 503);
  assert.equal(writer.events.has(event.id), false);
  assert.deepEqual(alerts, []);
});

test("manual reconciliation insert failure rolls back the Stripe event claim", async () => {
  const writer = new MemoryStripeEventWriter([paidUser()]);
  writer.failNextReconciliationInsert = true;
  const event = invoiceEvent({
    id: "evt_reconciliation_insert_failure",
    lines: [
      { ...invoiceLine(), id: "il_duplicate_one" },
      { ...invoiceLine(), id: "il_duplicate_two" },
    ],
    type: "invoice.paid",
  });

  const failed = await webhookResponse(
    request({ signature: "valid" }),
    dependenciesFor(event, {
      recordManualReconciliation: writer.recordReconciliation,
    }),
    null
  );

  assert.equal(failed.status, 503);
  assert.equal(writer.events.has(event.id), false);
  assert.equal(writer.reconciliations.has(event.id), false);

  const retried = await webhookResponse(
    request({ signature: "valid" }),
    dependenciesFor(event, {
      recordManualReconciliation: writer.recordReconciliation,
    }),
    null
  );
  assert.equal(retried.status, 200);
  assert.equal(writer.events.has(event.id), true);
  assert.equal(writer.reconciliations.has(event.id), true);
});

test("logging failure after reconciliation commit does not lose durable evidence", async () => {
  const writer = new MemoryStripeEventWriter([paidUser()]);
  const event = invoiceEvent({
    id: "evt_reconciliation_log_failure",
    lines: [
      { ...invoiceLine(), id: "il_duplicate_one" },
      { ...invoiceLine(), id: "il_duplicate_two" },
    ],
    type: "invoice.paid",
  });

  const response = await webhookResponse(
    request({ signature: "valid" }),
    dependenciesFor(event, {
      recordManualReconciliation: writer.recordReconciliation,
      reportManualReconciliation: () => {
        throw new Error("log unavailable");
      },
    }),
    null
  );

  assert.equal(response.status, 200);
  assert.equal(writer.events.has(event.id), true);
  assert.deepEqual(writer.reconciliations.get(event.id), {
    eventId: event.id,
    eventType: "invoice.paid",
    reason: "invoice_ambiguous_entitlement",
    status: "pending",
  });
});

test("overlapping paid replacement is durably reconciled without mutating entitlement", async () => {
  const writer = new MemoryStripeEventWriter([
    {
      ...paidUser(),
      stripeSubscriptionId: "sub_A",
    },
  ]);
  const event = invoiceEvent({
    id: "evt_overlap_reconciliation",
    lines: [
      invoiceLine({
        periodEnd: NEXT_PERIOD_END,
        periodStart: new Date("2026-09-01T12:00:00.000Z"),
        subscriptionId: "sub_B",
      }),
    ],
    subscriptionId: "sub_B",
    type: "invoice.paid",
  });

  const response = await webhookResponse(
    request({ signature: "valid" }),
    dependenciesFor(event, {
      applyEventUpdate: writer.apply,
      findUserByStripeCustomerId: writer.findByCustomer,
      reportManualReconciliation: () => undefined,
    }),
    null
  );

  assert.equal(response.status, 200);
  assert.deepEqual(await response.json(), {
    reason: "invoice_conflicting_paid_interval",
    reconciliation: true,
  });
  assert.deepEqual(writer.users.get(USER_ID), {
    ...paidUser(),
    stripeSubscriptionId: "sub_A",
  });
  assert.deepEqual(writer.reconciliations.get(event.id), {
    eventId: event.id,
    eventType: "invoice.paid",
    reason: "invoice_conflicting_paid_interval",
    status: "pending",
  });
});

test("supported paid billing reasons use an exact non-proration period", async (t) => {
  await Promise.all(
    (
      [
        "subscription_create",
        "subscription_cycle",
        "subscription_update",
      ] as const
    ).map((billingReason) =>
      t.test(billingReason, async () => {
        const writes: StripeEventUpdateInput[] = [];
        const event = invoiceEvent({
          billingReason,
          id: `evt_reason_${billingReason}`,
          type: "invoice.paid",
        });
        const response = await webhookResponse(
          request({ signature: "valid" }),
          dependenciesFor(event, {
            applyEventUpdate: (input) => {
              writes.push(input);
              return Promise.resolve("applied");
            },
            findUserByStripeCustomerId: () => Promise.resolve(paidUser()),
          }),
          null
        );

        assert.equal(response.status, 200);
        const write = onlyInvoiceWrite(writes);
        assert.equal(write.billingReason, billingReason);
        assert.equal(write.periodStart.toISOString(), PAID_UNTIL.toISOString());
        assert.equal(
          write.periodEnd.toISOString(),
          NEXT_PERIOD_END.toISOString()
        );
      })
    )
  );
});

test("an initial invoice.payment_failed grants nothing", async () => {
  const writer = new MemoryStripeEventWriter([
    {
      billingPeriodStart: null,
      id: USER_ID,
      stripeCustomerId: "cus_webhook",
      stripeSubscriptionId: null,
      subscribedUntil: null,
    },
  ]);
  const event = invoiceEvent({
    billingReason: "subscription_create",
    id: "evt_initial_failure",
    periodEnd: NEXT_PERIOD_END,
    periodStart: PAID_UNTIL,
    type: "invoice.payment_failed",
  });
  const response = await webhookResponse(
    request({ signature: "valid" }),
    dependenciesFor(event, {
      applyEventUpdate: writer.apply,
    }),
    null
  );

  assert.equal(response.status, 200);
  assert.deepEqual(writer.users.get(USER_ID), {
    billingPeriodStart: null,
    id: USER_ID,
    stripeCustomerId: "cus_webhook",
    stripeSubscriptionId: null,
    subscribedUntil: null,
  });
});

test("renewal failure grace remains one-time across distinct events", async () => {
  const writer = new MemoryStripeEventWriter([
    {
      billingPeriodStart: PAID_FROM,
      id: USER_ID,
      stripeCustomerId: "cus_webhook",
      stripeSubscriptionId: "sub_webhook",
      subscribedUntil: PAID_UNTIL,
    },
  ]);
  const firstEvent = invoiceEvent({
    id: "evt_failure_one",
    periodEnd: NEXT_PERIOD_END,
    periodStart: PAID_UNTIL,
    type: "invoice.payment_failed",
  });
  const secondEvent = invoiceEvent({
    id: "evt_failure_two",
    periodEnd: NEXT_PERIOD_END,
    periodStart: PAID_UNTIL,
    type: "invoice.payment_failed",
  });
  const dependencies = dependenciesFor(firstEvent, {
    applyEventUpdate: writer.apply,
    findUserByStripeCustomerId: writer.findByCustomer,
  });

  const first = await webhookResponse(
    request({ signature: "valid" }),
    dependencies,
    null
  );
  dependencies.createProvider = () =>
    providerForEvent(secondEvent, dependencies);
  const second = await webhookResponse(
    request({ signature: "valid" }),
    dependencies,
    null
  );

  assert.equal(first.status, 200);
  assert.equal(second.status, 200);
  assert.equal(
    writer.users.get(USER_ID)?.subscribedUntil?.getTime(),
    PAID_UNTIL.getTime() + GRACE_PERIOD_DAYS * 86_400_000
  );
});

test("Stripe Customer and Subscription expanded and string IDs are supported", async (t) => {
  await Promise.all(
    [false, true].map((expanded) =>
      t.test(expanded ? "expanded objects" : "string IDs", async () => {
        const writes: StripeEventUpdateInput[] = [];
        const event = invoiceEvent({
          expanded,
          id: `evt_ids_${expanded ? "expanded" : "string"}`,
          type: "invoice.paid",
        });
        const response = await webhookResponse(
          request({ signature: "valid" }),
          dependenciesFor(event, {
            applyEventUpdate: (input) => {
              writes.push(input);
              return Promise.resolve("applied");
            },
            findUserByStripeCustomerId: () =>
              Promise.resolve({
                billingPeriodStart: PAID_FROM,
                id: USER_ID,
                stripeCustomerId: "cus_webhook",
                stripeSubscriptionId: null,
                subscribedUntil: PAID_UNTIL,
              }),
          }),
          null
        );

        assert.equal(response.status, 200);
        assert.equal(writes[0]?.customerId, "cus_webhook");
        assert.equal(writes[0]?.stripeSubscriptionId, "sub_webhook");
      })
    )
  );
});

test("disabling new Checkout does not disable webhook processing", async () => {
  const original = process.env.SUBSCRIPTION_CHECKOUT_ENABLED;
  process.env.SUBSCRIPTION_CHECKOUT_ENABLED = "off";
  try {
    const writes: StripeEventUpdateInput[] = [];
    const response = await webhookResponse(
      request({ signature: "valid" }),
      dependenciesFor(
        checkoutEvent({
          id: "evt_flag_off",
          paymentStatus: "paid",
        }),
        {
          applyEventUpdate: (input) => {
            writes.push(input);
            return Promise.resolve("applied");
          },
        }
      ),
      null
    );

    assert.equal(response.status, 200);
    assert.equal(writes.length, 1);
  } finally {
    if (original === undefined) {
      delete process.env.SUBSCRIPTION_CHECKOUT_ENABLED;
    } else {
      process.env.SUBSCRIPTION_CHECKOUT_ENABLED = original;
    }
  }
});

function paidUser(): WebhookUser {
  return {
    billingPeriodStart: PAID_FROM,
    id: USER_ID,
    stripeCustomerId: "cus_webhook",
    stripeSubscriptionId: "sub_webhook",
    subscribedUntil: PAID_UNTIL,
  };
}

function paidIntent(input: {
  eventId: string;
  periodEnd: Date;
  periodStart: Date;
  stripeSubscriptionId?: string;
}): StripeEventUpdateInput {
  return {
    billingReason: "subscription_cycle",
    customerId: "cus_webhook",
    eventId: input.eventId,
    eventType: "invoice_paid",
    periodEnd: input.periodEnd,
    periodStart: input.periodStart,
    stripeSubscriptionId: input.stripeSubscriptionId ?? "sub_webhook",
  };
}

function failedIntent(
  eventId: string,
  input: {
    billingReason?:
      | "subscription_create"
      | "subscription_cycle"
      | "subscription_update";
    stripeSubscriptionId?: string;
  } = {}
): StripeEventUpdateInput {
  return {
    billingReason: input.billingReason ?? "subscription_cycle",
    customerId: "cus_webhook",
    eventId,
    eventType: "invoice_payment_failed",
    periodEnd: NEXT_PERIOD_END,
    periodStart: PAID_UNTIL,
    stripeSubscriptionId: input.stripeSubscriptionId ?? "sub_webhook",
  };
}

function onlyInvoiceWrite(
  writes: StripeEventUpdateInput[]
): Exclude<StripeEventUpdateInput, { eventType: "checkout_reference" }> {
  const [write] = writes;
  assert.ok(write && write.eventType !== "checkout_reference");
  return write;
}

type WebhookDependencies = {
  applyEventUpdate: (
    input: StripeEventUpdateInput
  ) => Promise<StripeEventWriteResult>;
  createProvider: (apiKey: string) => {
    constructEvent: (
      raw: Uint8Array,
      signature: string,
      secret: string
    ) => Promise<Stripe.Event>;
    listInvoiceLines: (
      invoiceId: string,
      startingAfter?: string
    ) => Promise<Stripe.ApiList<Stripe.InvoiceLineItem>>;
    retrieveCustomer: (customerId: string) => Promise<
      | Pick<Stripe.Customer, "id" | "metadata" | "object">
      | (Pick<Stripe.DeletedCustomer, "deleted" | "id" | "object"> & {
          metadata?: never;
        })
    >;
  };
  enforceAbuse: (input: {
    ip: string | null;
    route: "stripe_webhook";
  }) => Promise<
    | { kind: "allowed" }
    | { kind: "denied"; responseStatus: 429; retryAfterSeconds: number }
    | { kind: "unavailable"; responseStatus: 503 }
  >;
  findCheckoutAttemptState: (input: {
    attemptId: string;
    ownerId: string;
  }) => Promise<CheckoutAttemptState | null>;
  findUserByStripeCustomerId: (
    customerId: string
  ) => Promise<WebhookUser | null>;
  getConfig: () => {
    apiKey: string;
    priceId: string;
    webhookSecret: string;
  } | null;
  recordManualReconciliation: (
    record: StripeWebhookManualReconciliationRecord
  ) => Promise<StripeEventWriteResult>;
  reportManualReconciliation: (
    record: StripeWebhookManualReconciliationRecord
  ) => void;
};

function webhookResponse(
  requestValue: Request,
  dependencies: WebhookDependencies,
  sourceIp: string | null
): Promise<Response> {
  return (
    productionWebhookResponse as unknown as (
      request: Request,
      dependencies: WebhookDependencies,
      sourceIp: string | null
    ) => Promise<Response>
  )(requestValue, dependencies, sourceIp);
}

function request(input: {
  body?: BodyInit;
  headers?: HeadersInit;
  onBodyRead?: () => void;
  signature?: string;
}): Request {
  const headers = new Headers();
  for (const [name, value] of new Headers(input.headers)) {
    headers.set(name, value);
  }
  if (input.signature) {
    headers.set("stripe-signature", input.signature);
  }
  const value = new Request("https://example.test/api/stripe/webhook", {
    body: input.body ?? '{"exact":"raw body"}',
    duplex: "half",
    headers,
    method: "POST",
  } as RequestInit & { duplex: "half" });
  if (input.onBodyRead) {
    const { onBodyRead } = input;
    const { body } = value;
    assert.ok(body);
    Object.defineProperty(value, "body", {
      value: {
        getReader() {
          onBodyRead();
          return body.getReader();
        },
      },
    });
  }
  return value;
}

function dependenciesFor(
  event: Stripe.Event,
  overrides: Partial<WebhookDependencies> = {}
): WebhookDependencies {
  const dependencies: WebhookDependencies = {
    applyEventUpdate: () => Promise.resolve("applied"),
    createProvider: () => providerForEvent(event, dependencies),
    enforceAbuse: () => Promise.resolve({ kind: "allowed" }),
    findCheckoutAttemptState: () =>
      Promise.resolve({
        customerId: "cus_webhook",
        kind: "session_created",
        sessionId: "cs_webhook",
      }),
    findUserByStripeCustomerId: () => Promise.resolve(paidUser()),
    getConfig: () => ({
      apiKey: "sk_test_webhook",
      priceId: PRICE_ID,
      webhookSecret: "whsec_test",
    }),
    recordManualReconciliation: (record) =>
      Promise.resolve({
        kind: "manual_reconciliation",
        record,
      }),
    reportManualReconciliation: () => undefined,
    ...overrides,
  };
  return dependencies;
}

function providerForEvent(
  event: Stripe.Event,
  _dependencies: WebhookDependencies
): ReturnType<WebhookDependencies["createProvider"]> {
  return {
    constructEvent: () => Promise.resolve(event),
    listInvoiceLines: () =>
      Promise.resolve({
        data: [],
        has_more: false,
        object: "list",
        url: "/v1/invoices/in_webhook/lines",
      }),
    retrieveCustomer: () =>
      Promise.resolve({
        id: "cus_webhook",
        metadata: {
          checkoutAttemptId: CHECKOUT_ATTEMPT_ID,
          checkoutFlowVersion: "1",
          userId: USER_ID,
        },
        object: "customer",
      }),
  };
}

function checkoutEvent(input: {
  expanded?: boolean;
  id: string;
  paymentStatus: Stripe.Checkout.Session.PaymentStatus;
  session?: Partial<Stripe.Checkout.Session>;
  type?:
    | "checkout.session.async_payment_succeeded"
    | "checkout.session.completed";
}): Stripe.Event {
  const customer = input.expanded
    ? ({
        id: "cus_webhook",
        metadata: { userId: USER_ID },
        object: "customer",
      } as unknown as Stripe.Customer)
    : "cus_webhook";
  const subscription = input.expanded
    ? ({ id: "sub_webhook", object: "subscription" } as Stripe.Subscription)
    : "sub_webhook";
  const base = {
    client_reference_id: USER_ID,
    customer,
    id: "cs_webhook",
    integration_identifier: CHECKOUT_INTEGRATION_IDENTIFIER,
    metadata: {
      checkoutAttemptId: CHECKOUT_ATTEMPT_ID,
      checkoutFlowVersion: "1",
      priceId: PRICE_ID,
      userId: USER_ID,
    },
    mode: "subscription",
    object: "checkout.session",
    payment_status: input.paymentStatus,
    subscription,
  } satisfies Partial<Stripe.Checkout.Session>;
  return stripeEvent(input.id, input.type ?? "checkout.session.completed", {
    ...base,
    ...input.session,
    metadata:
      input.session && Object.hasOwn(input.session, "metadata")
        ? input.session.metadata
        : base.metadata,
  } as unknown as Stripe.Checkout.Session);
}

function invoiceEvent(input: {
  billingReason?: Stripe.Invoice.BillingReason;
  customerMetadata?: Stripe.Metadata;
  expanded?: boolean;
  hasMore?: boolean;
  id: string;
  lines?: Stripe.InvoiceLineItem[];
  periodEnd?: Date;
  periodStart?: Date;
  subscriptionId?: string;
  type: "invoice.paid" | "invoice.payment_failed";
}): Stripe.Event {
  const subscriptionId = input.subscriptionId ?? "sub_webhook";
  const subscription = input.expanded
    ? ({ id: subscriptionId, object: "subscription" } as Stripe.Subscription)
    : subscriptionId;
  const customer = input.expanded
    ? ({
        id: "cus_webhook",
        metadata: input.customerMetadata ?? {
          checkoutAttemptId: CHECKOUT_ATTEMPT_ID,
          checkoutFlowVersion: "1",
          userId: USER_ID,
        },
        object: "customer",
      } as unknown as Stripe.Customer)
    : "cus_webhook";
  const periodEnd = input.periodEnd ?? NEXT_PERIOD_END;
  const periodStart = input.periodStart ?? PAID_UNTIL;
  const lines = input.lines ?? [
    invoiceLine({
      expanded: input.expanded,
      periodEnd,
      periodStart,
      subscriptionId,
    }),
  ];
  return stripeEvent(input.id, input.type, {
    billing_reason: input.billingReason ?? "subscription_cycle",
    customer,
    id: "in_webhook",
    lines: {
      data: lines,
      has_more: input.hasMore ?? false,
      object: "list",
      url: "/v1/invoices/in_webhook/lines",
    },
    object: "invoice",
    parent: {
      quote_details: null,
      subscription_details: {
        metadata: { userId: USER_ID },
        subscription,
      },
      type: "subscription_details",
    },
    period_end: Math.floor(PAID_UNTIL.getTime() / 1000),
    period_start: Math.floor(PAID_FROM.getTime() / 1000),
  } as unknown as Stripe.Invoice);
}

function invoiceLine(
  input: {
    expanded?: boolean;
    parentType?: "invoice_item_details" | "subscription_item_details";
    periodEnd?: Date;
    periodStart?: Date;
    priceId?: string;
    proration?: boolean;
    subscriptionId?: string;
  } = {}
): Stripe.InvoiceLineItem {
  const parentType = input.parentType ?? "subscription_item_details";
  const periodEnd = input.periodEnd ?? NEXT_PERIOD_END;
  const periodStart = input.periodStart ?? PAID_UNTIL;
  const priceId = input.priceId ?? PRICE_ID;
  const subscriptionId = input.subscriptionId ?? "sub_webhook";
  const subscription = input.expanded
    ? ({
        id: subscriptionId,
        object: "subscription",
      } as Stripe.Subscription)
    : subscriptionId;
  const price = input.expanded
    ? ({ id: priceId, object: "price" } as Stripe.Price)
    : priceId;
  const details = {
    invoice_item: parentType === "invoice_item_details" ? "ii_webhook" : null,
    proration: input.proration ?? false,
    proration_details: null,
    subscription: subscriptionId,
    ...(parentType === "subscription_item_details"
      ? { subscription_item: "si_webhook" }
      : {}),
  };

  return {
    id: `il_${parentType}_${priceId}_${subscriptionId}`,
    object: "line_item",
    parent: {
      invoice_item_details:
        parentType === "invoice_item_details"
          ? (details as Stripe.InvoiceLineItem.Parent.InvoiceItemDetails)
          : null,
      subscription_item_details:
        parentType === "subscription_item_details"
          ? (details as Stripe.InvoiceLineItem.Parent.SubscriptionItemDetails)
          : null,
      type: parentType,
    },
    period: {
      end: Math.floor(periodEnd.getTime() / 1000),
      start: Math.floor(periodStart.getTime() / 1000),
    },
    pricing: {
      price_details: {
        price,
        product: "prod_webhook",
      },
      type: "price_details",
      unit_amount_decimal: "1000",
    },
    subscription,
  } as unknown as Stripe.InvoiceLineItem;
}

function stripeEvent(
  id: string,
  type: Stripe.Event["type"],
  object: Stripe.Event["data"]["object"]
): Stripe.Event {
  return {
    api_version: "2026-07-29.dahlia",
    created: Math.floor(Date.now() / 1000),
    data: { object },
    id,
    livemode: false,
    object: "event",
    pending_webhooks: 1,
    request: null,
    type,
  } as Stripe.Event;
}

class MemoryStripeEventWriter {
  readonly events = new Set<string>();
  failNextClaim = false;
  failNextReconciliationInsert = false;
  failNextUpdate = false;
  private transactionTail = Promise.resolve();
  readonly reconciliations = new Map<
    string,
    StripeWebhookManualReconciliationRecord
  >();
  updateCount = 0;
  readonly users = new Map<string, WebhookUser>();

  constructor(users: WebhookUser[]) {
    for (const user of users) {
      this.users.set(user.id, { ...user });
    }
  }

  readonly findByCustomer = (customerId: string): Promise<WebhookUser | null> =>
    Promise.resolve(
      [...this.users.values()].find(
        (candidate) => candidate.stripeCustomerId === customerId
      ) ?? null
    );

  readonly apply = async (
    input: StripeEventUpdateInput
  ): Promise<StripeEventWriteResult> => {
    let release: () => void = () => undefined;
    const previous = this.transactionTail;
    this.transactionTail = new Promise<void>((resolve) => {
      release = resolve;
    });
    await previous;
    try {
      return this.applyLocked(input);
    } finally {
      release();
    }
  };

  readonly recordReconciliation = async (
    record: StripeWebhookManualReconciliationRecord
  ): Promise<StripeEventWriteResult> => {
    let release: () => void = () => undefined;
    const previous = this.transactionTail;
    this.transactionTail = new Promise<void>((resolve) => {
      release = resolve;
    });
    await previous;
    try {
      if (this.events.has(record.eventId)) {
        return "duplicate";
      }
      if (this.failNextClaim) {
        this.failNextClaim = false;
        throw new Error("simulated claim failure");
      }

      const stagedEvents = new Set(this.events);
      const stagedReconciliations = new Map(this.reconciliations);
      stagedEvents.add(record.eventId);
      if (this.failNextReconciliationInsert) {
        this.failNextReconciliationInsert = false;
        throw new Error("simulated reconciliation insert failure");
      }
      stagedReconciliations.set(record.eventId, record);

      this.events.clear();
      for (const eventId of stagedEvents) {
        this.events.add(eventId);
      }
      this.reconciliations.clear();
      for (const [eventId, reconciliation] of stagedReconciliations) {
        this.reconciliations.set(eventId, reconciliation);
      }
      return { kind: "manual_reconciliation", record };
    } finally {
      release();
    }
  };

  private applyLocked(input: StripeEventUpdateInput): StripeEventWriteResult {
    const stagedEvents = new Set(this.events);
    const stagedUsers = new Map(
      [...this.users].map(([id, value]) => [id, { ...value }])
    );
    const stagedReconciliations = new Map(this.reconciliations);

    if (stagedEvents.has(input.eventId)) {
      return "duplicate";
    }
    stagedEvents.add(input.eventId);

    if (this.failNextUpdate) {
      this.failNextUpdate = false;
      throw new Error("simulated database failure");
    }

    const owner = input.userId
      ? stagedUsers.get(input.userId)
      : [...stagedUsers.values()].find(
          (candidate) => candidate.stripeCustomerId === input.customerId
        );
    if (
      !owner ||
      (owner.stripeCustomerId !== null &&
        owner.stripeCustomerId !== input.customerId)
    ) {
      throw new Error("Stripe Customer owner does not match.");
    }

    const decision = stripeEventMutation(owner, input);
    if (
      decision &&
      "kind" in decision &&
      decision.kind === "manual_reconciliation"
    ) {
      const record: StripeWebhookManualReconciliationRecord = {
        eventId: input.eventId,
        eventType:
          input.eventType === "invoice_paid"
            ? "invoice.paid"
            : "invoice.payment_failed",
        reason: decision.reason,
        status: "pending",
      };
      stagedReconciliations.set(input.eventId, record);
      this.events.clear();
      for (const eventId of stagedEvents) {
        this.events.add(eventId);
      }
      this.reconciliations.clear();
      for (const [eventId, reconciliation] of stagedReconciliations) {
        this.reconciliations.set(eventId, reconciliation);
      }
      return { kind: "manual_reconciliation", record };
    }
    const mutation = decision as StripeUserMutation | null;
    if (mutation) {
      stagedUsers.set(owner.id, { ...owner, ...mutation });
    }

    this.events.clear();
    for (const eventId of stagedEvents) {
      this.events.add(eventId);
    }
    this.users.clear();
    for (const [id, user] of stagedUsers) {
      this.users.set(id, user);
    }
    if (mutation) {
      this.updateCount += 1;
    }
    return "applied";
  }
}
