import assert from "node:assert/strict";
import test from "node:test";
import type Stripe from "stripe";
import { GRACE_PERIOD_DAYS } from "./limits";
import {
  stripeWebhookResponse as productionWebhookResponse,
  type StripeEventUpdateInput,
  stripeEventMutation,
  subscriptionUpdate,
  type WebhookUser,
} from "./webhook";

const PAID_UNTIL = new Date("2026-09-20T12:00:00.000Z");
const PAID_FROM = new Date("2026-08-20T12:00:00.000Z");
const NEXT_PERIOD_END = new Date("2026-10-20T12:00:00.000Z");
const PRICE_ID = "price_webhook";
const USER_ID = "3f2504e0-4f89-41d3-9a0c-0305e82c3301";

test("a paid invoice sets the period end", () => {
  const update = subscriptionUpdate({
    billingReason: "subscription_cycle",
    current: null,
    periodEnd: PAID_UNTIL,
    type: "invoice.paid",
  });

  assert.equal(update?.subscribedUntil.toISOString(), PAID_UNTIL.toISOString());
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

test("a failed renewal extends by the grace window", () => {
  const update = subscriptionUpdate({
    billingReason: "subscription_cycle",
    current: PAID_UNTIL,
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

test("an older paid event cannot replace a later unbacked subscription reference", async () => {
  const writer = new MemoryStripeEventWriter([
    {
      billingPeriodStart: null,
      id: USER_ID,
      stripeCustomerId: "cus_webhook",
      stripeSubscriptionId: "sub_later",
      subscribedUntil: null,
    },
  ]);
  const stale = paidIntent({
    eventId: "evt_paid_before_later_checkout",
    periodEnd: PAID_UNTIL,
    periodStart: PAID_FROM,
  });

  assert.equal(await writer.apply(stale), "applied");
  assert.deepEqual(writer.users.get(USER_ID), {
    billingPeriodStart: null,
    id: USER_ID,
    stripeCustomerId: "cus_webhook",
    stripeSubscriptionId: "sub_later",
    subscribedUntil: null,
  });
  assert.equal(writer.events.has(stale.eventId), true);
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
            metadata: { userId: USER_ID },
            object: "customer",
          }),
      }),
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

test("unpaid Checkout completion is an explicit no-op", async () => {
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
    reason: "unpaid",
  });
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
      userId: USER_ID,
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

test("ambiguous duplicate entitlement lines fail retryably", async () => {
  let writes = 0;
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
      applyEventUpdate: () => {
        writes += 1;
        return Promise.resolve("applied");
      },
      findUserByStripeCustomerId: () => Promise.resolve(paidUser()),
    }),
    null
  );

  assert.equal(response.status, 503);
  assert.equal(writes, 0);
});

test("proration-only, wrong-price, and manual invoices fail retryably", async (t) => {
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
      name: "malformed period",
    },
  ];

  await Promise.all(
    cases.map(({ event, name }) =>
      t.test(name, async () => {
        let writes = 0;
        const response = await webhookResponse(
          request({ signature: "valid" }),
          dependenciesFor(event, {
            applyEventUpdate: () => {
              writes += 1;
              return Promise.resolve("applied");
            },
            findUserByStripeCustomerId: () => Promise.resolve(paidUser()),
          }),
          null
        );

        assert.equal(response.status, 503);
        assert.equal(writes, 0);
      })
    )
  );
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
    stripeSubscriptionId: "sub_webhook",
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
}): StripeEventUpdateInput {
  return {
    billingReason: "subscription_cycle",
    customerId: "cus_webhook",
    eventId: input.eventId,
    eventType: "invoice_paid",
    periodEnd: input.periodEnd,
    periodStart: input.periodStart,
    stripeSubscriptionId: "sub_webhook",
    userId: USER_ID,
  };
}

function failedIntent(eventId: string): StripeEventUpdateInput {
  return {
    billingReason: "subscription_cycle",
    customerId: "cus_webhook",
    eventId,
    eventType: "invoice_payment_failed",
    periodEnd: NEXT_PERIOD_END,
    periodStart: PAID_UNTIL,
    stripeSubscriptionId: "sub_webhook",
    userId: USER_ID,
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
  ) => Promise<"applied" | "duplicate">;
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
  findUserById: (userId: string) => Promise<WebhookUser | null>;
  findUserByStripeCustomerId: (
    customerId: string
  ) => Promise<WebhookUser | null>;
  getConfig: () => {
    apiKey: string;
    priceId: string;
    webhookSecret: string;
  } | null;
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
    findUserById: () =>
      Promise.resolve({
        billingPeriodStart: null,
        id: USER_ID,
        stripeCustomerId: null,
        stripeSubscriptionId: null,
        subscribedUntil: null,
      }),
    findUserByStripeCustomerId: () => Promise.resolve(null),
    getConfig: () => ({
      apiKey: "sk_test_webhook",
      priceId: PRICE_ID,
      webhookSecret: "whsec_test",
    }),
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
        metadata: { userId: USER_ID },
        object: "customer",
      }),
  };
}

function checkoutEvent(input: {
  id: string;
  paymentStatus: Stripe.Checkout.Session.PaymentStatus;
  type?:
    | "checkout.session.async_payment_succeeded"
    | "checkout.session.completed";
}): Stripe.Event {
  return stripeEvent(input.id, input.type ?? "checkout.session.completed", {
    client_reference_id: USER_ID,
    customer: "cus_webhook",
    metadata: { userId: USER_ID },
    object: "checkout.session",
    payment_status: input.paymentStatus,
    subscription: "sub_webhook",
  } as unknown as Stripe.Checkout.Session);
}

function invoiceEvent(input: {
  billingReason?: Stripe.Invoice.BillingReason;
  expanded?: boolean;
  hasMore?: boolean;
  id: string;
  lines?: Stripe.InvoiceLineItem[];
  periodEnd?: Date;
  periodStart?: Date;
  type: "invoice.paid" | "invoice.payment_failed";
}): Stripe.Event {
  const subscription = input.expanded
    ? ({ id: "sub_webhook", object: "subscription" } as Stripe.Subscription)
    : "sub_webhook";
  const customer = input.expanded
    ? ({
        id: "cus_webhook",
        metadata: { userId: USER_ID },
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
  failNextUpdate = false;
  private transactionTail = Promise.resolve();
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
  ): Promise<"applied" | "duplicate"> => {
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

  private applyLocked(input: StripeEventUpdateInput): "applied" | "duplicate" {
    const stagedEvents = new Set(this.events);
    const stagedUsers = new Map(
      [...this.users].map(([id, value]) => [id, { ...value }])
    );

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

    const mutation = stripeEventMutation(owner, input);
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
