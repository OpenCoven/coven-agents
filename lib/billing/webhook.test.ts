import assert from "node:assert/strict";
import test from "node:test";
import type Stripe from "stripe";
import { GRACE_PERIOD_DAYS } from "./limits";
import {
  stripeWebhookResponse as productionWebhookResponse,
  subscriptionUpdate,
} from "./webhook";

const PAID_UNTIL = new Date("2026-09-20T12:00:00.000Z");
const PAID_FROM = new Date("2026-08-20T12:00:00.000Z");
const NEXT_PERIOD_END = new Date("2026-10-20T12:00:00.000Z");
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

test("webhook admission precedes body parsing and Stripe work", async () => {
  const calls: string[] = [];
  const response = await webhookResponse(
    request({
      onText: () => calls.push("body"),
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
      onText: () => calls.push("body"),
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

test("missing and bad signatures mutate nothing", async (t) => {
  await t.test("missing signature", async () => {
    let bodyReads = 0;
    let providerCalls = 0;
    let writes = 0;
    const response = await webhookResponse(
      request({
        onText: () => {
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
  let writes = 0;
  const event = invoiceEvent({
    id: "evt_unresolved",
    type: "invoice.paid",
  });
  const response = await webhookResponse(
    request({ signature: "valid" }),
    dependenciesFor(event, {
      applyEventUpdate: () => {
        writes += 1;
        return Promise.resolve("applied");
      },
      createProvider: () => ({
        constructEvent: () => Promise.resolve(event),
        retrieveCustomer: () =>
          Promise.resolve({
            deleted: false,
            id: "cus_webhook",
            metadata: { userId: USER_ID },
            object: "customer",
          }),
      }),
      findUserById: () => Promise.resolve(null),
      findUserByStripeCustomerId: () => Promise.resolve(null),
    }),
    null
  );

  assert.equal(response.status, 503);
  assert.equal(writes, 0);
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
      billingPeriodStart: PAID_UNTIL,
      customerId: "cus_webhook",
      eventId: "evt_invoice_paid",
      stripeSubscriptionId: "sub_webhook",
      subscribedUntil: NEXT_PERIOD_END,
      userId: USER_ID,
    },
  ]);
});

test("an initial invoice.payment_failed grants nothing", async () => {
  const writes: StripeEventUpdateInput[] = [];
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
      applyEventUpdate: (input) => {
        writes.push(input);
        return Promise.resolve("applied");
      },
      findUserByStripeCustomerId: () =>
        Promise.resolve({
          billingPeriodStart: null,
          id: USER_ID,
          stripeCustomerId: "cus_webhook",
          stripeSubscriptionId: null,
          subscribedUntil: null,
        }),
    }),
    null
  );

  assert.equal(response.status, 200);
  assert.deepEqual(writes, [
    {
      customerId: "cus_webhook",
      eventId: "evt_initial_failure",
      stripeSubscriptionId: "sub_webhook",
      userId: USER_ID,
    },
  ]);
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

type StripeEventUpdateInput = {
  billingPeriodStart?: Date;
  customerId: string;
  eventId: string;
  stripeSubscriptionId?: string;
  subscribedUntil?: Date;
  userId: string;
};

type WebhookUser = {
  billingPeriodStart: Date | null;
  id: string;
  stripeCustomerId: string | null;
  stripeSubscriptionId: string | null;
  subscribedUntil: Date | null;
};

type WebhookDependencies = {
  applyEventUpdate: (
    input: StripeEventUpdateInput
  ) => Promise<"applied" | "duplicate">;
  createProvider: (apiKey: string) => {
    constructEvent: (
      raw: string,
      signature: string,
      secret: string
    ) => Promise<Stripe.Event>;
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
  getConfig: () => { apiKey: string; webhookSecret: string } | null;
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

function request(input: { onText?: () => void; signature?: string }): Request {
  const headers = new Headers();
  if (input.signature) {
    headers.set("stripe-signature", input.signature);
  }
  const value = new Request("https://example.test/api/stripe/webhook", {
    body: '{"exact":"raw body"}',
    headers,
    method: "POST",
  });
  if (input.onText) {
    const { onText } = input;
    const text = value.text.bind(value);
    Object.defineProperty(value, "text", {
      value: async () => {
        onText();
        return await text();
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
  id: string;
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
  return stripeEvent(input.id, input.type, {
    billing_reason: input.billingReason ?? "subscription_cycle",
    customer,
    lines: {
      data: [
        {
          object: "line_item",
          parent: {
            invoice_item_details: null,
            subscription_item_details: {
              invoice_item: null,
              proration: false,
              proration_details: null,
              subscription: "sub_webhook",
              subscription_item: "si_webhook",
            },
            type: "subscription_item_details",
          },
          period: {
            end: Math.floor(periodEnd.getTime() / 1000),
            start: Math.floor(periodStart.getTime() / 1000),
          },
          subscription,
        },
      ],
      has_more: false,
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

  readonly apply = (
    input: StripeEventUpdateInput
  ): Promise<"applied" | "duplicate"> => {
    const stagedEvents = new Set(this.events);
    const stagedUsers = new Map(
      [...this.users].map(([id, value]) => [id, { ...value }])
    );

    if (stagedEvents.has(input.eventId)) {
      return Promise.resolve("duplicate");
    }
    stagedEvents.add(input.eventId);

    if (this.failNextUpdate) {
      this.failNextUpdate = false;
      return Promise.reject(new Error("simulated database failure"));
    }

    const owner = stagedUsers.get(input.userId);
    if (
      !owner ||
      (owner.stripeCustomerId !== null &&
        owner.stripeCustomerId !== input.customerId)
    ) {
      return Promise.reject(new Error("Stripe Customer owner does not match."));
    }

    stagedUsers.set(input.userId, {
      ...owner,
      billingPeriodStart: input.billingPeriodStart ?? owner.billingPeriodStart,
      stripeCustomerId: input.customerId,
      stripeSubscriptionId:
        input.stripeSubscriptionId ?? owner.stripeSubscriptionId,
      subscribedUntil: input.subscribedUntil ?? owner.subscribedUntil,
    });

    this.events.clear();
    for (const eventId of stagedEvents) {
      this.events.add(eventId);
    }
    this.users.clear();
    for (const [id, user] of stagedUsers) {
      this.users.set(id, user);
    }
    this.updateCount += 1;
    return Promise.resolve("applied");
  };
}
