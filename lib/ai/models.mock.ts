import type {
  LanguageModelV3,
  LanguageModelV3StreamPart,
} from "@ai-sdk/provider";

const mockResponses: Record<string, string> = {
  default: "This is a mock response for testing.",
  greeting: "Hello! How can I help you today?",
  weather: "The weather in San Francisco is sunny and 72°F.",
};

const mockUsage = {
  inputTokens: { cacheRead: 0, cacheWrite: 0, noCache: 10, total: 10 },
  outputTokens: { reasoning: 0, text: 20, total: 20 },
};

const mockFinishReason = { raw: undefined, unified: "stop" as const };

function getResponseForPrompt(prompt: unknown): string {
  const promptStr = JSON.stringify(prompt).toLowerCase();

  if (promptStr.includes("weather") || promptStr.includes("temperature")) {
    return mockResponses.weather;
  }
  if (
    promptStr.includes("hello") ||
    promptStr.includes("hi") ||
    promptStr.includes("hey")
  ) {
    return mockResponses.greeting;
  }

  return mockResponses.default;
}

const createMockModel = (): LanguageModelV3 => ({
  doGenerate: async ({ prompt }: { prompt: unknown }) => ({
    content: [{ text: getResponseForPrompt(prompt), type: "text" }],
    finishReason: mockFinishReason,
    usage: mockUsage,
    warnings: [],
  }),
  doStream: ({ prompt }: { prompt: unknown }) => {
    const response = getResponseForPrompt(prompt);
    const words = response.split(" ");

    return Promise.resolve({
      stream: new ReadableStream<LanguageModelV3StreamPart>({
        async start(controller) {
          controller.enqueue({ id: "t1", type: "text-start" });
          await words.reduce<Promise<void>>(async (previous, word) => {
            await previous;
            controller.enqueue({
              delta: `${word} `,
              id: "t1",
              type: "text-delta",
            });
            await new Promise((resolve) => {
              setTimeout(resolve, 100);
            });
          }, Promise.resolve());
          controller.enqueue({ id: "t1", type: "text-end" });
          controller.enqueue({
            finishReason: mockFinishReason,
            type: "finish",
            usage: mockUsage,
          });
          controller.close();
        },
      }),
    });
  },
  modelId: "mock-model",
  provider: "mock",
  specificationVersion: "v3",
  supportedUrls: {},
});

const createMockTitleModel = (): LanguageModelV3 => ({
  doGenerate: async () => ({
    content: [{ text: "Test Conversation", type: "text" }],
    finishReason: mockFinishReason,
    usage: {
      inputTokens: { cacheRead: 0, cacheWrite: 0, noCache: 5, total: 5 },
      outputTokens: { reasoning: 0, text: 5, total: 5 },
    },
    warnings: [],
  }),
  doStream: async () => ({
    stream: new ReadableStream<LanguageModelV3StreamPart>({
      start(controller) {
        controller.enqueue({ id: "t1", type: "text-start" });
        controller.enqueue({
          delta: "Test Conversation",
          id: "t1",
          type: "text-delta",
        });
        controller.enqueue({ id: "t1", type: "text-end" });
        controller.enqueue({
          finishReason: mockFinishReason,
          type: "finish",
          usage: {
            inputTokens: {
              cacheRead: 0,
              cacheWrite: 0,
              noCache: 5,
              total: 5,
            },
            outputTokens: { reasoning: 0, text: 5, total: 5 },
          },
        });
        controller.close();
      },
    }),
  }),
  modelId: "mock-title-model",
  provider: "mock",
  specificationVersion: "v3",
  supportedUrls: {},
});

export const chatModel = createMockModel();
export const titleModel = createMockTitleModel();
