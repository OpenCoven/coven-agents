import assert from "node:assert/strict";
import test from "node:test";
import { generateText, streamText } from "ai";

test("test providers support the real chat catalog and current SDK lifecycle", async (t) => {
  const previous = process.env.PLAYWRIGHT;
  process.env.PLAYWRIGHT = "1";
  t.after(() => {
    if (previous === undefined) {
      delete process.env.PLAYWRIGHT;
    } else {
      process.env.PLAYWRIGHT = previous;
    }
  });
  const { chatModels, getCapabilities } = await import("./models");
  const { getLanguageModel, getTitleModel, myProvider } = await import(
    "./providers"
  );
  assert.ok(myProvider, "This test must never use the live gateway.");

  await t.test(
    "capabilities do not contact the live gateway",
    async (context) => {
      const fetch = context.mock.method(globalThis, "fetch", () =>
        Promise.reject(new Error("Unexpected external capability request"))
      );
      const capabilities = await getCapabilities();
      assert.deepEqual(
        Object.keys(capabilities),
        chatModels.map(({ id }) => id)
      );
      assert.equal(fetch.mock.callCount(), 0);
    }
  );

  await Promise.all(
    chatModels.map(({ id }) =>
      t.test(id, async () => {
        const model = getLanguageModel(id);
        assert.equal(model.provider, "mock");
        const result = streamText({
          model,
          prompt: "Explain how rainbows form.",
        });
        await result.consumeStream();
        assert.ok((await result.text).length > 0);
        assert.equal(await result.finishReason, "stop");
      })
    )
  );

  await t.test("title generation completes normally", async () => {
    const model = getTitleModel();
    assert.equal(model.provider, "mock");
    const result = await generateText({
      model,
      prompt: "Explain how rainbows form.",
    });
    assert.equal(result.text, "Test Conversation");
    assert.equal(result.finishReason, "stop");
  });
});
