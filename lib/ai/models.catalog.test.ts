import assert from "node:assert/strict";
import test from "node:test";
import { allowedModelIds, chatModels, modelsByProvider } from "./models";

test("Astra is available as the GPT-6 Astra model", () => {
  const astra = chatModels.find((model) => model.name === "Astra");

  assert.ok(astra);
  assert.deepEqual(astra, {
    description: "OpenAI's flagship agentic model",
    id: "openai/gpt-6-astra",
    name: "Astra",
    provider: "openai",
    reasoningEffort: "high",
  });
  assert.ok(allowedModelIds.has("openai/gpt-6-astra"));
  assert.ok(modelsByProvider.openai?.includes(astra));
});
