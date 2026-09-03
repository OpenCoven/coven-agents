import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import test from "node:test";

/**
 * The credit transaction's ordering is a money invariant that no stubbed
 * dependency can observe, and its integration probe only runs when a database
 * is configured. This reads the source so the gate still fails if the order is
 * reversed, in the same spirit as the migration text assertions.
 */
test("crediting a pack checks ownership before it claims the Stripe event", async () => {
  const source = await readFile(
    new URL("./queries.ts", import.meta.url),
    "utf8"
  );
  const start = source.indexOf("export async function creditMinutePack");
  assert.ok(start > 0, "creditMinutePack must exist");
  const body = source.slice(start, source.indexOf("\nexport ", start + 1));

  const duplicateProbe = body.indexOf(".from(stripeEvent)");
  const ownership = body.indexOf(".from(user)");
  const claim = body.indexOf(".insert(stripeEvent)");
  const credit = body.indexOf(".insert(minutePack)");

  for (const [name, index] of [
    ["duplicate probe", duplicateProbe],
    ["ownership check", ownership],
    ["event claim", claim],
    ["pack insert", credit],
  ] as const) {
    assert.ok(index > 0, `${name} must be present`);
  }

  // Claiming before the ownership check consumes the only key Stripe has for
  // the payment, so a corrected redelivery reads as a duplicate and credits
  // nothing. The duplicate probe must precede both, or an already-credited
  // event whose customer id later changed reports a mismatch forever.
  assert.ok(
    duplicateProbe < ownership,
    "the duplicate probe must run before the ownership check"
  );
  assert.ok(
    ownership < claim,
    "ownership must be checked before the event is claimed"
  );
  assert.ok(claim < credit, "the event must be claimed before minutes land");
});
