"use server";

import { generateText, type UIMessage } from "ai";
import { cookies } from "next/headers";
import { auth } from "@/app/(auth)/auth";
import type { VisibilityType } from "@/components/chat/visibility-selector";
import { titleModel } from "@/lib/ai/models";
import { titlePrompt } from "@/lib/ai/prompts";
import { getTitleModel } from "@/lib/ai/providers";
import {
  type ChatActionDependencies,
  deleteTrailingMessagesForSession as deleteTrailingMessagesWithSession,
  updateChatVisibilityForSession as updateChatVisibilityWithSession,
} from "@/lib/auth/chat-actions";
import { authorizeSubscriberAccess } from "@/lib/auth/subscriber-authorization.server";
import {
  deleteMessagesByChatIdAfterTimestamp,
  getChatById,
  getMessageById,
  updateChatVisibilityById,
} from "@/lib/db/queries";
import { getTextFromMessage } from "@/lib/utils";

const chatActionDependencies: ChatActionDependencies = {
  authorize: authorizeSubscriberAccess,
  deleteMessages: deleteMessagesByChatIdAfterTimestamp,
  getChat: getChatById,
  getMessage: getMessageById,
  updateVisibility: updateChatVisibilityById,
};

export async function saveChatModelAsCookie(model: string) {
  const cookieStore = await cookies();
  cookieStore.set("chat-model", model);
}

export async function generateTitleFromUserMessage({
  message,
}: {
  message: UIMessage;
}) {
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

export async function deleteTrailingMessages({ id }: { id: string }) {
  const session = await auth();
  return deleteTrailingMessagesWithSession(
    { id },
    session,
    chatActionDependencies
  );
}

export async function updateChatVisibility({
  chatId,
  visibility,
}: {
  chatId: string;
  visibility: VisibilityType;
}) {
  const session = await auth();
  return updateChatVisibilityWithSession(
    { chatId, visibility },
    session,
    chatActionDependencies
  );
}
