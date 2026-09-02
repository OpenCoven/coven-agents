import assert from "node:assert/strict";
import test from "node:test";
import { compareAscii } from "./ascii";

test("ASCII comparison is deterministic across locale collators", () => {
  const values = ["owner/a_a", "owner/a.a", "owner/a-a"];
  const expected = ["owner/a-a", "owner/a.a", "owner/a_a"];

  assert.deepEqual([...values].sort(compareAscii), expected);
  for (const locale of ["en", "sv", "tr"]) {
    const collatorOrder = [...values].sort(new Intl.Collator(locale).compare);
    assert.notDeepEqual(collatorOrder, expected, locale);
    assert.deepEqual([...values].sort(compareAscii), expected, locale);
  }
  assert.throws(() => compareAscii("owner/café", "owner/cafe"), /ASCII/u);
});
