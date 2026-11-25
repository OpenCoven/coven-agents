import assert from "node:assert/strict";
import test from "node:test";
import {
  HARNESS_SPECS,
  harnessAuthHint,
  harnessInstallSpecifier,
  harnessSpec,
  harnessStatus,
  isRunnableHarness,
  resolveHarnessAuth,
  SUPPORTED_HARNESS_IDS,
} from "./registry";

test("Copilot, Codex and Claude form the supported harness subset", () => {
  assert.deepEqual([...SUPPORTED_HARNESS_IDS], ["copilot", "codex", "claude"]);
  assert.ok(isRunnableHarness("copilot"));
  assert.ok(isRunnableHarness("codex"));
  assert.ok(isRunnableHarness("claude"));
});

test("no harness authenticates with a model provider API key", () => {
  const copilot = harnessSpec("copilot");
  assert.ok(copilot);
  assert.ok(!copilot.authEnvVars.includes("OPENAI_API_KEY"));
  for (const spec of HARNESS_SPECS) {
    if (spec.supported) {
      assert.ok(
        spec.authEnvVars.every(
          (name) =>
            name.startsWith("COPILOT_") ||
            name.endsWith("GITHUB_TOKEN") ||
            name === "GH_TOKEN" ||
            (spec.id === "codex" && name === "COVEN_CODEX_AUTH_JSON") ||
            (spec.id === "claude" && name === "CLAUDE_CODE_OAUTH_TOKEN")
        ),
        `${spec.id} must authenticate through its own CLI credential`
      );
    }
  }
});

test("auth resolution honours the CLI's documented precedence", () => {
  const spec = harnessSpec("copilot");
  assert.ok(spec);
  assert.deepEqual(
    resolveHarnessAuth(spec, {
      COPILOT_GITHUB_TOKEN: "first",
      GH_TOKEN: "second",
      GITHUB_TOKEN: "third",
    }),
    { name: "COPILOT_GITHUB_TOKEN", value: "first" }
  );
  assert.deepEqual(resolveHarnessAuth(spec, { GH_TOKEN: "second" }), {
    name: "GH_TOKEN",
    value: "second",
  });
});

test("a blank credential counts as not signed in", () => {
  const spec = harnessSpec("copilot");
  assert.ok(spec);
  assert.equal(resolveHarnessAuth(spec, { COPILOT_GITHUB_TOKEN: "   " }), null);
  assert.equal(resolveHarnessAuth(spec, {}), null);
});

test("the auth hint names the harness credential, never a provider key", () => {
  const spec = harnessSpec("copilot");
  assert.ok(spec);
  const hint = harnessAuthHint(spec);
  assert.ok(hint.includes("COPILOT_GITHUB_TOKEN"));
  assert.ok(hint.includes("never uses a model provider API key"));
  assert.ok(!hint.includes("OPENAI_API_KEY"));
});

test("an uninstalled harness reports the package that provides it", () => {
  const spec = harnessSpec("copilot");
  assert.ok(spec);
  const status = harnessStatus(spec, { installed: false, version: null });
  assert.equal(status.installed, false);
  assert.ok(status.detail.includes("@github/copilot@1.0.80"));
});

test("every harness carries an exact version pin", () => {
  for (const spec of HARNESS_SPECS) {
    assert.match(
      spec.installVersion,
      /^\d+\.\d+\.\d+$/u,
      `${spec.id} must pin an exact version, never a range or a tag`
    );
    assert.equal(
      harnessInstallSpecifier(spec),
      `${spec.installPackage}@${spec.installVersion}`
    );
  }
});
