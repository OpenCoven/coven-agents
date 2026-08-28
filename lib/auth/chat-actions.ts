import type { VisibilityType } from "@/components/chat/visibility-selector";
import type {
  deleteMessagesByChatIdAfterTimestamp,
  getChatById,
  getMessageById,
  updateChatVisibilityById,
} from "@/lib/db/queries";
import type { SessionLike } from "./subscriber-access";
import type { authorizeSubscriberAccess } from "./subscriber-authorization.server";

export type ChatActionSession = SessionLike;

export type ChatActionDependencies = {
  authorize: typeof authorizeSubscriberAccess;
  deleteMessages: typeof deleteMessagesByChatIdAfterTimestamp;
  getChat: typeof getChatById;
  getMessage: typeof getMessageById;
  updateVisibility: typeof updateChatVisibilityById;
};

function assertActionAccess(
  access: Awaited<ReturnType<typeof authorizeSubscriberAccess>>
) {
  if (access.kind !== "allowed") {
    throw new Error(
      access.kind === "unauthorized" ? "Unauthorized" : "Subscription required"
    );
  }
  return access;
}

export async function deleteTrailingMessagesForSession(
  { id }: { id: string },
  session: ChatActionSession,
  dependencies: ChatActionDependencies
) {
  const access = assertActionAccess(await dependencies.authorize(session));

  const [message] = await dependencies.getMessage({ id });
  if (!message) {
    throw new Error("Message not found");
  }

  const chat = await dependencies.getChat({ id: message.chatId });
  if (!chat || chat.userId !== access.userId) {
    throw new Error("Unauthorized");
  }

  await dependencies.deleteMessages({
    chatId: message.chatId,
    timestamp: message.createdAt,
  });
}

export async function updateChatVisibilityForSession(
  {
    chatId,
    visibility,
  }: {
    chatId: string;
    visibility: VisibilityType;
  },
  session: ChatActionSession,
  dependencies: ChatActionDependencies
) {
  const access = assertActionAccess(await dependencies.authorize(session));

  const chat = await dependencies.getChat({ id: chatId });
  if (!chat || chat.userId !== access.userId) {
    throw new Error("Unauthorized");
  }

  await dependencies.updateVisibility({ chatId, visibility });
}
