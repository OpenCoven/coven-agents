import { and, eq } from "drizzle-orm";
import { DEFAULT_CHAT_TITLE } from "@/lib/ai/title-text";
import { chat } from "./schema";

export function automaticChatTitleWhere({
  chatId,
  userId,
}: {
  chatId: string;
  userId: string;
}) {
  // Automatic naming is one-shot and only admitted by the chat's creator.
  // Never replace a newer title, even if it was written during generation.
  return and(
    eq(chat.id, chatId),
    eq(chat.userId, userId),
    eq(chat.title, DEFAULT_CHAT_TITLE)
  );
}
