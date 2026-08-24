import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import test from "node:test";
import {
  buildInvocation,
  buildMission,
  shellQuote,
  toShellCommand,
} from "./invocation";

const BASE = {
  cwd: "/workspace",
  instructions: "Be careful.",
  model: "auto",
  task: "List the files.",
};

test("copilot runs headless with pre-approved tools", () => {
  const invocation = buildInvocation({ ...BASE, harness: "copilot" });
  assert.equal(invocation.command, "copilot");
  assert.ok(invocation.args.includes("--yolo"));
  assert.ok(invocation.args.includes("--no-ask-user"));
  assert.ok(invocation.args.includes("-p"));
  assert.ok(
    invocation.args.includes(buildMission(BASE.instructions, BASE.task))
  );
});

test("`auto` passes no --model flag so the harness picks", () => {
  const invocation = buildInvocation({ ...BASE, harness: "copilot" });
  assert.ok(!invocation.args.includes("--model"));

  const pinned = buildInvocation({
    ...BASE,
    harness: "copilot",
    model: "claude-opus-5",
  });
  assert.equal(pinned.args.at(-2), "--model");
  assert.equal(pinned.args.at(-1), "claude-opus-5");
});

test("streaming selects the structured output format", () => {
  const text = buildInvocation({ ...BASE, harness: "copilot" });
  const jsonl = buildInvocation({ ...BASE, harness: "copilot", stream: true });
  assert.equal(text.args[text.args.indexOf("--output-format") + 1], "text");
  assert.equal(jsonl.args[jsonl.args.indexOf("--output-format") + 1], "json");
});

test("an unknown harness is refused rather than silently defaulted", () => {
  assert.throws(
    () => buildInvocation({ ...BASE, harness: "gpt" }),
    /Unsupported harness: gpt/
  );
});

test("shell quoting neutralizes command substitution in a mission", () => {
  const quoted = shellQuote("$(touch /tmp/pwned) 'and' \"more\"");
  assert.equal(quoted, `'$(touch /tmp/pwned) '\\''and'\\'' "more"'`);
  // Verified against a real shell: the quoted form must round-trip as one arg.
  assert.ok(!quoted.includes("$(touch /tmp/pwned)'"));
});

test("the quoted command round-trips through a real shell as exact argv", () => {
  const invocation = buildInvocation({
    ...BASE,
    harness: "copilot",
    task: "rm -rf / ; echo $(whoami) `id` 'quoted' \"double\"\nsecond line",
  });
  // A real shell is the only honest oracle here: if quoting were wrong, the
  // mission's `$(...)` would execute instead of arriving as text.
  const printed = execFileSync(
    "sh",
    ["-c", `printf '%s\\0' ${toShellCommand(invocation)}`],
    { encoding: "utf8" }
  );
  const argv = printed.split("\0").slice(0, -1);
  assert.deepEqual(argv, [invocation.command, ...invocation.args]);
  assert.ok(argv.some((arg) => arg.includes("$(whoami)")));
});
