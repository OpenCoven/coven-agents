"use server";

import type { UIMessage } from "ai";
import { cookies } from "next/headers";
import { auth } from "@/app/(auth)/auth";
import type { VisibilityType } from "@/components/chat/visibility-selector";
import { enforceAbusePolicy } from "@/lib/abuse/enforce";
import { generateTitleFromUserMessageInternal } from "@/lib/ai/title";
import {
  type ChatActionDependencies,
  deleteTrailingMessagesForSession as deleteTrailingMessagesWithSession,
  updateChatVisibilityForSession as updateChatVisibilityWithSession,
} from "@/lib/auth/chat-actions";
import { authorizeSubscriberAccess } from "@/lib/auth/subscriber-authorization.server";
import { generateTitleWithAuthorization } from "@/lib/auth/title-generation";
import {
  deleteMessagesByChatIdAfterTimestamp,
  getChatById,
  getMessageById,
  updateChatVisibilityById,
} from "@/lib/db/queries";

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
  return generateTitleWithAuthorization(message, await auth(), {
    authorize: authorizeSubscriberAccess,
    enforceAbuse: enforceAbusePolicy,
    generate: (candidate) =>
      generateTitleFromUserMessageInternal({ message: candidate }),
  });
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
