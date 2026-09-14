import "server-only";

import { generateText, type UIMessage } from "ai";
import {
  type ChatTitleFailure,
  reportChatTitleFailure,
} from "./chat-title-stream";
import { titleModel } from "./models";
import { titlePrompt } from "./prompts";
import { getTitleModel } from "./providers";
import {
  DEFAULT_CHAT_TITLE,
  normalizeChatTitle,
  titleInputFromMessage,
} from "./title-text";

const TITLE_TIMEOUT_MS = 1500;

type TitleDependencies = {
  generate?: (prompt: string, signal: AbortSignal) => Promise<string>;
  report?: (reason: ChatTitleFailure) => void;
  timeoutMs?: number;
};

async function generateModelTitle(prompt: string, abortSignal: AbortSignal) {
  const { text } = await generateText({
    abortSignal,
    instructions: titlePrompt,
    maxOutputTokens: 64,
    maxRetries: 0,
    model: getTitleModel(),
    prompt,
    providerOptions: {
      gateway: { order: titleModel.gatewayOrder },
    },
  });
  return text;
}

/**
 * Internal title generation for an already-authorized chat operation.
 *
 * This is intentionally kept out of the server-action module. The exported
 * action performs its own session, subscription, and abuse checks; the chat
 * route uses this server-only helper after it has already performed those
 * checks and admitted the request.
 */
export async function generateTitleFromUserMessageInternal(
  { message }: { message: UIMessage },
  {
    generate = generateModelTitle,
    report = reportChatTitleFailure,
    timeoutMs = TITLE_TIMEOUT_MS,
  }: TitleDependencies = {}
): Promise<string> {
  const prompt = titleInputFromMessage(message);
  const fallback = normalizeChatTitle(prompt) || DEFAULT_CHAT_TITLE;
  if (!prompt) {
    return fallback;
  }

  const controller = new AbortController();
  let timer: ReturnType<typeof setTimeout> | undefined;
  const timeout = new Promise<null>((resolve) => {
    timer = setTimeout(() => {
      resolve(null);
      controller.abort();
    }, timeoutMs);
  });
  try {
    const text = await Promise.race([
      Promise.resolve().then(() => generate(prompt, controller.signal)),
      timeout,
    ]);
    if (text === null) {
      report("generation_timeout");
      return fallback;
    }
    const title = normalizeChatTitle(text);
    if (!title || title === DEFAULT_CHAT_TITLE) {
      report("generation_invalid");
      return fallback;
    }
    return title;
  } catch {
    report("generation_failed");
    return fallback;
  } finally {
    clearTimeout(timer);
  }
}
