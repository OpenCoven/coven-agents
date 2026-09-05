import assert from "node:assert/strict";
import test from "node:test";
import { cleanDraftedMission, teamMissionRequest } from "./mission";

const team = {
  description: "  Moves approved work through delivery.  ",
  hint: "",
  members: [
    { required: true, responsibility: "Triage the issue and restate it." },
    { required: false, responsibility: "Review the diff." },
  ],
  name: "Delivery team",
};

test("the model sees the roster in run order and nothing else about the team", () => {
  const request = teamMissionRequest(team);

  assert.match(request, /^Team: Delivery team$/m);
  assert.match(request, /^Purpose: Moves approved work through delivery\.$/m);
  assert.match(request, /^1\. Triage the issue and restate it\.$/m);
  assert.match(request, /^2\. Review the diff\. \(optional member\)$/m);
  // No hint was given, so no line invents one.
  assert.doesNotMatch(request, /What the person asked for/);
});

test("a half-written note is carried in as a steer, normalized", () => {
  const request = teamMissionRequest({
    ...team,
    hint: "  fix   the\n flaky login test  ",
  });

  assert.match(
    request,
    /^What the person asked for: fix the flaky login test$/m
  );
});

test("an empty purpose is omitted rather than sent as a blank line", () => {
  assert.doesNotMatch(
    teamMissionRequest({ ...team, description: "   " }),
    /Purpose/
  );
});

test("the roster is bounded so one enormous team cannot dominate the prompt", () => {
  const request = teamMissionRequest({
    ...team,
    members: Array.from({ length: 20 }, () => ({
      required: true,
      responsibility: "x".repeat(2000),
    })),
  });

  assert.equal(request.includes("13. "), false);
  assert.equal(request.includes("x".repeat(401)), false);
});

test("drafted text loses the heading and quoting a model adds unbidden", () => {
  assert.equal(
    cleanDraftedMission('## "Ship the fix and return a passing check."'),
    "Ship the fix and return a passing check."
  );
  assert.equal(cleanDraftedMission("  - Do the thing.  "), "Do the thing.");
  assert.equal(cleanDraftedMission("   "), "");
});
