import "server-only";

import { eq, sql } from "drizzle-orm";
import {
  advancingSubscriptionUpdate,
  subscriptionUpdate,
} from "@/lib/billing/webhook";
import { ChatbotError } from "@/lib/errors";
import { db } from "./queries";
import { stripeEvent, user } from "./schema";

export type StripeEventApplication =
  | "applied"
  | "deduped"
  | "ignored"
  | "rejected";

/**
 * Records an authenticated event that cannot affect entitlement.
 *
 * The insert remains the global provider-event idempotency boundary. No user
 * lookup, entitlement mutation, or external provider call is needed for an
 * event type the product does not consume.
 */
export async function recordIgnoredStripeEvent(
  eventId: string
): Promise<"deduped" | "ignored"> {
  try {
    const inserted = await db
      .insert(stripeEvent)
      .values({ id: eventId })
      .onConflictDoNothing()
      .returning({ id: stripeEvent.id });
    return inserted.length === 1 ? "ignored" : "deduped";
  } catch (error) {
    throw new ChatbotError("bad_request:database", { cause: error });
  }
}

/**
 * Atomically deduplicates one verified Stripe event and applies its normalized
 * entitlement effect.
 *
 * The old route inserted the event receipt before customer lookup and before
 * the user update. A crash in between made every later Stripe retry look
 * complete. Here the receipt and entitlement write share one PostgreSQL
 * transaction: failure rolls both back, while a concurrent duplicate waits for
 * the transaction outcome and can safely retry after rollback.
 */
export async function applyStripeEntitlementEvent(input: {
  billingReason: string;
  customerId: string;
  eventId: string;
  eventType: string;
  periodEnd: Date | null;
  periodStart: Date | null;
  userId: string;
}): Promise<StripeEventApplication> {
  try {
    return await db.transaction(async (transaction) => {
      const [claimed] = await transaction
        .insert(stripeEvent)
        .values({ id: input.eventId })
        .onConflictDoNothing()
        .returning({ id: stripeEvent.id });

      if (!claimed) {
        return "deduped";
      }

      // Distinct Stripe events for one account can arrive concurrently or out
      // of order. Serialize their normalized decisions before reading current
      // entitlement so a stale event cannot race a newer renewal.
      await transaction.execute(
        sql`select pg_advisory_xact_lock(hashtextextended(${input.userId}, 0))`
      );

      const [owner] = await transaction
        .select()
        .from(user)
        .where(eq(user.id, input.userId))
        .limit(1);

      // Missing ownership is retryable: throwing rolls the event receipt back
      // so a later delivery can converge after checkout/account propagation.
      if (!owner) {
        throw new Error("stripe_owner_missing");
      }

      // A provider customer id may bootstrap an account once. It may never be
      // used to rebind an account that already owns another customer.
      if (
        owner.stripeCustomerId &&
        owner.stripeCustomerId !== input.customerId
      ) {
        return "rejected";
      }

      const update = advancingSubscriptionUpdate(
        owner.subscribedUntil ?? null,
        subscriptionUpdate({
          billingReason: input.billingReason,
          current: owner.subscribedUntil ?? null,
          currentPeriodStart: owner.billingPeriodStart ?? null,
          periodEnd: input.periodEnd,
          periodStart: input.periodStart,
          type: input.eventType,
        })
      );

      if (!update) {
        return "ignored";
      }

      const updated = await transaction
        .update(user)
        .set({
          billingPeriodStart: update.billingPeriodStart,
          stripeCustomerId: input.customerId,
          subscribedUntil: update.subscribedUntil,
          updatedAt: new Date(),
        })
        .where(eq(user.id, owner.id))
        .returning({ id: user.id });

      if (updated.length !== 1) {
        throw new Error("stripe_owner_update_failed");
      }
      return "applied";
    });
  } catch (error) {
    throw new ChatbotError("bad_request:database", { cause: error });
  }
}
