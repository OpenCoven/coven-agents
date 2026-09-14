import assert from "node:assert/strict";
import test from "node:test";
import type { UIMessage } from "ai";
import { generateTitleFromUserMessageInternal } from "./title";
import { normalizeChatTitle, titleInputFromMessage } from "./title-text";

function message(text: string): UIMessage {
  return { id: "first", parts: [{ text, type: "text" }], role: "user" };
}

test("model failure returns a deterministic offline title without logging content", async () => {
  const reports: string[] = [];
  const input = message("Explain how rainbows form");
  const dependencies = {
    generate: () => Promise.reject(new Error("private provider payload")),
    report: (reason: string) => reports.push(reason),
  };
  assert.equal(
    await generateTitleFromUserMessageInternal(
      { message: input },
      dependencies
    ),
    "Explain how rainbows form"
  );
  assert.equal(
    await generateTitleFromUserMessageInternal(
      { message: input },
      dependencies
    ),
    "Explain how rainbows form"
  );
  assert.deepEqual(reports, ["generation_failed", "generation_failed"]);
});

test("timeout aborts a hung model and returns fallback even if abort is ignored", async () => {
  const reports: string[] = [];
  let signal: AbortSignal | undefined;
  const title = await generateTitleFromUserMessageInternal(
    { message: message("Plan a garden") },
    {
      generate: (_prompt, candidateSignal) => {
        signal = candidateSignal;
        return new Promise<string>(() => {
          // Deliberately simulate a provider that ignores cancellation.
        });
      },
      report: (reason) => reports.push(reason),
      timeoutMs: 5,
    }
  );
  assert.equal(title, "Plan a garden");
  assert.equal(signal?.aborted, true);
  assert.deepEqual(reports, ["generation_timeout"]);
});

test("empty model output falls back and textless messages keep the legacy placeholder", async () => {
  const reports: string[] = [];
  const dependencies = {
    generate: () => Promise.resolve("### **"),
    report: (reason: string) => reports.push(reason),
  };
  assert.equal(
    await generateTitleFromUserMessageInternal(
      { message: message("Plan a garden") },
      dependencies
    ),
    "Plan a garden"
  );
  assert.equal(
    await generateTitleFromUserMessageInternal(
      { message: { id: "empty", parts: [], role: "user" } },
      dependencies
    ),
    "New chat"
  );
  assert.deepEqual(reports, ["generation_invalid"]);
});

test("normalization removes markdown, control and bidi characters and uses NFC", () => {
  assert.equal(
    normalizeChatTitle('# **"Cafe\u0301\u202e guide\u0000"**'),
    "Café guide"
  );
  assert.equal(
    normalizeChatTitle("[Garden guide](https://example.invalid)"),
    "Garden guide"
  );
  assert.equal(normalizeChatTitle("### ** <>"), "");
  assert.equal(normalizeChatTitle("1. **Garden plan**"), "Garden plan");
  assert.equal(normalizeChatTitle("1) Garden plan"), "Garden plan");
});

test("normalization removes credential URLs and obvious secrets before shortening", () => {
  const key = `sk-${"x".repeat(28)}`;
  for (const sensitive of [
    key,
    `sk-**${"x".repeat(28)}**`,
    `sk-\u202e${"x".repeat(28)}`,
    "https://user:private@example.invalid/path?token=private",
    "https://example.invalid/?token=private",
    "user:private@example.invalid",
    "example.invalid?token=private",
    "password=private",
    "password: private",
    "token: private",
    "api key: private",
    "password is private",
    "Bearer private",
    // secret-scan: allow-next-line -- Synthetic PEM header, not key material.
    "-----BEGIN PRIVATE KEY-----\nprivate",
  ]) {
    const normalized = normalizeChatTitle(`Garden tips ${sensitive}`);
    assert.doesNotMatch(normalized, /private|sk-|https|example|REDACTED/u);
    assert.match(normalized, /^Garden tips/u);
    assert.doesNotMatch(
      titleInputFromMessage(message(`Garden tips ${sensitive}`)),
      /private|sk-|https|example|REDACTED/u
    );
  }
});

for (const [prefix, payload] of [
  ["ghp_", "x".repeat(25)],
  ["github_pat_", "x".repeat(25)],
  ["sk-proj-", "x".repeat(25)],
  ["sk_live_", "x".repeat(25)],
  ["rk_test_", "x".repeat(25)],
  ["npm_", "x".repeat(25)],
  ["hf_", "x".repeat(25)],
  ["dop_v1_", "x".repeat(25)],
  ["glpat-", "x".repeat(25)],
  ["pypi-", "x".repeat(25)],
  ["xoxb-", "x".repeat(25)],
  ["AKIA", "X".repeat(16)],
  ["AIza", "x".repeat(32)],
  ["ya29.", "x".repeat(25)],
]) {
  test(`fragmented ${prefix} provider tokens are redacted before title truncation`, async () => {
    await Promise.all(
      [
        `${prefix}\`${payload}\``,
        `${prefix}**${payload}**`,
        `${prefix}<b>${payload}</b>`,
        `__${prefix}\`${payload}\`__`,
        `${prefix.slice(0, 2)}**${prefix.slice(2)}**\`${payload}\``,
      ].map(async (fragment) => {
        const text = `Help ${fragment}`;
        assert.equal(normalizeChatTitle(text), "Help");
        assert.equal(titleInputFromMessage(message(text)), "Help");
        assert.equal(
          await generateTitleFromUserMessageInternal(
            { message: message(text) },
            {
              generate: () => Promise.reject(new Error("unavailable")),
              report: () => undefined,
            }
          ),
          "Help"
        );
        assert.equal(
          await generateTitleFromUserMessageInternal(
            { message: message("Help") },
            {
              generate: () => Promise.resolve(text),
              report: () => undefined,
            }
          ),
          "Help"
        );
      })
    );
  });
}

test("underscore emphasis is removed without destroying identifier delimiters", () => {
  assert.equal(normalizeChatTitle("_Garden guide_"), "Garden guide");
  assert.equal(normalizeChatTitle("__Garden guide__"), "Garden guide");
  assert.equal(normalizeChatTitle("Explain snake_case"), "Explain snake_case");
});

test("titles are bounded by seven words and forty intact graphemes", () => {
  const segmenter = new Intl.Segmenter("en", { granularity: "grapheme" });
  for (const input of [
    "one two three four five six seven eight nine",
    "Explore the remarkably beautiful Mediterranean islands",
    "🌱".repeat(100),
    "🌱 ".repeat(100),
    "a\u0301".repeat(100),
    "x".repeat(100_000),
    `a${"\u0301".repeat(4000)}`,
  ]) {
    const title = normalizeChatTitle(input);
    assert.ok([...segmenter.segment(title)].length <= 40);
    assert.ok(title.length <= 256);
    assert.ok(title.split(/\s+/u).length <= 7);
    assert.equal(title, title.normalize("NFC"));
    assert.doesNotMatch(title, /[\p{Cc}\p{Cf}\p{Cs}]/u);
  }
});

test("a model placeholder cannot suppress a meaningful deterministic fallback", async () => {
  assert.equal(
    await generateTitleFromUserMessageInternal(
      { message: message("Plan a garden") },
      {
        generate: () => Promise.resolve("New chat"),
        report: (reason) => assert.equal(reason, "generation_invalid"),
      }
    ),
    "Plan a garden"
  );
});

test("model input is bounded and redacted; successful output uses the same title policy", async () => {
  const key = `sk-${"x".repeat(28)}`;
  const title = await generateTitleFromUserMessageInternal(
    { message: message(`Garden tips ${key} ${"flowers ".repeat(4000)}`) },
    {
      generate: (prompt) => {
        assert.ok(prompt.length <= 4096);
        assert.ok(!prompt.includes(key));
        return Promise.resolve("## **Garden planning**");
      },
      report: () =>
        assert.fail("successful generation should not report failure"),
    }
  );
  assert.equal(title, "Garden planning");
});

test("Unicode normalization expansion cannot exceed the model input budget", () => {
  const prompt = titleInputFromMessage(message("\u0344 ".repeat(2000)));
  assert.ok(prompt.length <= 4096);
  assert.equal(prompt, prompt.normalize("NFC"));
});
