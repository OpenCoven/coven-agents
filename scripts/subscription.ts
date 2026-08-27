#!/usr/bin/env tsx
import { eq, sql } from "drizzle-orm";
import { periodStart } from "@/lib/billing/period";
import { db } from "@/lib/db/queries";
import { user } from "@/lib/db/schema";
import { userTypeFor } from "@/lib/subscription";

/**
 * Grants or revokes a subscription by email.
 *
 * Billing does not exist yet, and without a subscriber nobody can store a
 * harness credential, which means nobody can run an agent at all. This is the
 * bootstrap: it sets the same column Stripe will set, so it is a stopgap in
 * who calls it rather than in what it writes.
 *
 *   pnpm subscription grant you@example.com          # one year
 *   pnpm subscription grant you@example.com 30       # thirty days
 *   pnpm subscription revoke you@example.com
 *   pnpm subscription status you@example.com
 *
 * A session carries its type from sign-in, so an existing session keeps the
 * type it was minted with — sign out and back in after granting.
 */

const DAY_MS = 86_400_000;
const DEFAULT_DAYS = 365;

async function findUser(email: string) {
  const normalizedEmail = email.trim().toLowerCase();
  const [row] = await db
    .select()
    .from(user)
    .where(sql`lower(${user.email}) = lower(${normalizedEmail})`)
    .limit(1);
  return row ?? null;
}

async function main(): Promise<number> {
  const [command, email, days] = process.argv.slice(2);

  if (!(command && email)) {
    process.stderr.write(
      "Usage: pnpm subscription <grant|revoke|status> <email> [days]\n"
    );
    return 2;
  }

  const found = await findUser(email);
  if (!found) {
    process.stderr.write(`No user with email ${email}.\n`);
    return 1;
  }

  if (command === "status") {
    const type = userTypeFor(found, new Date());
    process.stdout.write(
      `${email}: ${type} (subscribedUntil=${found.subscribedUntil?.toISOString() ?? "null"})\n`
    );
    return 0;
  }

  if (command === "grant") {
    const span = Number.parseInt(days ?? String(DEFAULT_DAYS), 10);
    if (!Number.isInteger(span) || span <= 0) {
      process.stderr.write(`Days must be a positive integer, got ${days}.\n`);
      return 2;
    }
    const until = new Date(Date.now() + span * DAY_MS);
    await db
      .update(user)
      .set({ billingPeriodStart: periodStart(until), subscribedUntil: until })
      .where(eq(user.id, found.id));
    process.stdout.write(
      `${email}: subscriber until ${until.toISOString()}\nSign out and back in for an existing session to pick this up.\n`
    );
    return 0;
  }

  if (command === "revoke") {
    await db
      .update(user)
      .set({ billingPeriodStart: null, subscribedUntil: null })
      .where(eq(user.id, found.id));
    process.stdout.write(`${email}: subscription revoked\n`);
    return 0;
  }

  process.stderr.write(`Unknown command: ${command}\n`);
  return 2;
}

main()
  .then((code) => process.exit(code))
  .catch((error: unknown) => {
    process.stderr.write(`${String(error)}\n`);
    process.exit(1);
  });
