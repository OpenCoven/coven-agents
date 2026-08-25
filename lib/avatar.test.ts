import assert from "node:assert/strict";
import test from "node:test";
import { avatarFor, generatedAvatar, isStorableAvatarUrl } from "./avatar";

const UUID_A = "3f2504e0-4f89-11d3-9a0c-0305e82c3301";
const UUID_B = "9c858901-8a57-4791-81fe-4c455b099bc9";

test("the same account always gets the same avatar", () => {
  // The whole point of generating rather than storing: a picture that changed
  // per render would read as a broken account rather than a default.
  assert.equal(generatedAvatar(UUID_A), generatedAvatar(UUID_A));
});

test("different accounts get different avatars", () => {
  assert.notEqual(generatedAvatar(UUID_A), generatedAvatar(UUID_B));
});

test("a generated avatar is a self-contained data URI", () => {
  // No external host, so it cannot leak the account id to a third party and
  // cannot fail to load because someone else's CDN is down.
  const avatar = generatedAvatar(UUID_A);

  assert.match(avatar, /^data:image\/svg\+xml;charset=utf-8,/);
  assert.doesNotMatch(avatar, /https?:\/\//);
});

test("a generated avatar is symmetric", () => {
  // Asserted through the decoded markup rather than by eye: an asymmetric
  // pattern reads as noise, and nothing else here would catch losing the
  // mirroring.
  const svg = decodeURIComponent(
    generatedAvatar(UUID_A).replace(/^data:image\/svg\+xml;charset=utf-8,/, "")
  );
  const filled = new Set(
    Array.from(
      svg.matchAll(/<rect x="(\d)" y="(\d)" width="1" height="1"\/>/g),
      (match) => `${match[1]},${match[2]}`
    )
  );

  assert.ok(filled.size > 0, "an identicon with no squares is not a picture");
  for (const cell of filled) {
    const [column, row] = cell.split(",").map(Number);
    assert.ok(
      filled.has(`${4 - column},${row}`),
      `column ${column} of row ${row} has no mirror`
    );
  }
});

test("an empty seed still produces an avatar", () => {
  assert.match(generatedAvatar(""), /^data:image\/svg\+xml/);
});

test("only https urls are storable", () => {
  assert.ok(isStorableAvatarUrl("https://example.com/a.png"));

  for (const bad of [
    // Rendered as an image `src`, so these are stored-content injection, not
    // merely invalid input.
    "javascript:alert(1)",
    "data:image/svg+xml,<svg onload=alert(1)>",
    // Blocked as mixed content on an https page: it would save and never show.
    "http://example.com/a.png",
    "",
    "not a url",
    `https://example.com/${"a".repeat(2100)}`,
  ]) {
    assert.equal(isStorableAvatarUrl(bad), false, bad);
  }
});

test("a stored avatar wins over the generated one", () => {
  assert.equal(
    avatarFor({ id: UUID_A, image: "https://example.com/me.png" }),
    "https://example.com/me.png"
  );
});

test("an unstorable stored value falls back rather than rendering", () => {
  // Defence in depth: the write path validates, but a row written before that
  // validation existed must not become an image `src` now.
  for (const stored of [null, undefined, "", "   ", "javascript:alert(1)"]) {
    assert.equal(
      avatarFor({ id: UUID_A, image: stored }),
      generatedAvatar(UUID_A),
      String(stored)
    );
  }
});

test("the avatar follows the id, not the email", () => {
  // Changing an address should not change someone's picture.
  assert.equal(
    avatarFor({ id: UUID_A, image: null }),
    avatarFor({ id: UUID_A, image: null })
  );
});
