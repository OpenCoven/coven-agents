import "server-only";

import { generateText, type UIMessage } from "ai";
import { getTextFromMessage } from "@/lib/utils";
import { titleModel } from "./models";
import { titlePrompt } from "./prompts";
import { getTitleModel } from "./providers";

/**
 * Internal title generation for an already-authorized chat operation.
 *
 * This is intentionally kept out of the server-action module. The exported
 * action performs its own session, subscription, and abuse checks; the chat
 * route uses this server-only helper after it has already performed those
 * checks and admitted the request.
 */
export async function generateTitleFromUserMessageInternal({
  message,
}: {
  message: UIMessage;
}): Promise<string> {
  const { text } = await generateText({
    instructions: titlePrompt,
    model: getTitleModel(),
    prompt: getTextFromMessage(message),
    providerOptions: {
      gateway: { order: titleModel.gatewayOrder },
    },
  });
  return text
    .replace(/^[#*"\s]+/, "")
    .replace(/["]+$/, "")
    .trim();
}
