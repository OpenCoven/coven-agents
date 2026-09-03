import assert from "node:assert/strict";
import test from "node:test";
import {
  minutePackForPrice,
  minutePacksFromEnv,
  offerableMinutePacksFromEnv,
  parseMinutePacks,
  remainingPackMinutes,
} from "./minute-packs";

test("packs parse from the configured list, smallest first, and blank means none", () => {
  assert.deepEqual(parseMinutePacks(undefined), []);
  assert.deepEqual(parseMinutePacks("  "), []);
  assert.deepEqual(
    parseMinutePacks(" price_big:1000 , price_small:100,price_mid:300"),
    [
      { minutes: 100, priceId: "price_small" },
      { minutes: 300, priceId: "price_mid" },
      { minutes: 1000, priceId: "price_big" },
    ]
  );
});

test("a malformed pack list is a configuration error, never a partial offer", () => {
  for (const value of [
    "price_a",
    "price_a:0",
    "price_a:-5",
    "price_a:1.5",
    "price_a:100,price_a:200",
    "prod_a:100",
    "price_a:100;price_b:200",
    "price_a:1000000",
    Array.from({ length: 9 }, (_, index) => `price_${index}:100`).join(","),
  ]) {
    assert.throws(() => parseMinutePacks(value), /MINUTE_PACK_PRICES/, value);
  }
});

test("a pack is found by its exact price id", () => {
  const packs = parseMinutePacks("price_a:100,price_b:300");
  assert.deepEqual(minutePackForPrice(packs, "price_b"), {
    minutes: 300,
    priceId: "price_b",
  });
  assert.equal(minutePackForPrice(packs, "price_c"), null);
  assert.equal(minutePackForPrice(packs, "price_"), null);
});

test("remaining pack minutes are purchases less what past periods drew down", () => {
  assert.equal(
    remainingPackMinutes({ priorPeriodOverflow: 0, purchased: 300 }),
    300
  );
  assert.equal(
    remainingPackMinutes({ priorPeriodOverflow: 120, purchased: 300 }),
    180
  );
  // Overflow beyond purchases can only come from a cap that changed since;
  // it never goes negative.
  assert.equal(
    remainingPackMinutes({ priorPeriodOverflow: 500, purchased: 300 }),
    0
  );
  assert.throws(() =>
    remainingPackMinutes({ priorPeriodOverflow: -1, purchased: 300 })
  );
});

test("a malformed pack configuration hides the offer instead of throwing", () => {
  const malformed = {
    MINUTE_PACK_PRICES: "price_bonus100;100",
    NODE_ENV: "test",
  } as NodeJS.ProcessEnv;

  // Transacting callers still see the error and refuse to sell.
  assert.throws(() => minutePacksFromEnv(malformed));
  // Rendering callers show no top-up rather than failing the page.
  assert.deepEqual(offerableMinutePacksFromEnv(malformed), []);
  assert.deepEqual(
    offerableMinutePacksFromEnv({
      MINUTE_PACK_PRICES: "price_bonus100:100",
      NODE_ENV: "test",
    } as NodeJS.ProcessEnv),
    [{ minutes: 100, priceId: "price_bonus100" }]
  );
});

test("a price id can never exceed the column that stores it", () => {
  const longest = `price_${"a".repeat(60)}`;
  // MinutePack.priceId is varchar(66); accepting more would fail the insert,
  // which leaves Stripe retrying an event that can never be written.
  assert.equal(longest.length, 66);
  assert.deepEqual(
    minutePacksFromEnv({
      MINUTE_PACK_PRICES: `${longest}:100`,
      NODE_ENV: "test",
    } as NodeJS.ProcessEnv),
    [{ minutes: 100, priceId: longest }]
  );
  assert.throws(() =>
    minutePacksFromEnv({
      MINUTE_PACK_PRICES: `price_${"a".repeat(61)}:100`,
      NODE_ENV: "test",
    } as NodeJS.ProcessEnv)
  );
});
