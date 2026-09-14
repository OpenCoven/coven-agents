import { DEFAULT_CHAT_TITLE } from "./ai/title-text";

type TitleHistory = { chats: { id: string; title: string }[] }[];

const RETRY_INTERVAL_MS = 1000;
const RECONCILIATION_WINDOW_MS = 10_000;
const MAX_RETRIES = 9;

export function createChatTitleReconciler({
  chatId,
  onComplete,
  revalidateHistory,
}: {
  chatId: string;
  onComplete?: () => void;
  revalidateHistory: () => Promise<TitleHistory | undefined>;
}) {
  let pending = false;
  let pendingMessageId: string | undefined;
  let started = false;
  let disposed = false;
  let completed = false;
  let attempts = 0;
  let expiresAt = 0;
  let retryTimer: ReturnType<typeof setTimeout> | undefined;
  let deadlineTimer: ReturnType<typeof setTimeout> | undefined;

  function stop() {
    pending = false;
    clearTimeout(retryTimer);
    clearTimeout(deadlineTimer);
    if (!completed) {
      completed = true;
      onComplete?.();
    }
  }

  async function reconcile() {
    if (!pending || disposed || Date.now() >= expiresAt) {
      stop();
      return;
    }
    attempts += 1;
    try {
      const pages = await revalidateHistory();
      const chat = pages
        ?.flatMap((page) => page.chats)
        .find((candidate) => candidate.id === chatId);
      if (chat && chat.title !== DEFAULT_CHAT_TITLE) {
        stop();
      }
    } catch {
      console.warn("[chat-title] history reconciliation failed");
    }
    if (
      !pending ||
      disposed ||
      attempts >= MAX_RETRIES ||
      Date.now() + RETRY_INTERVAL_MS >= expiresAt
    ) {
      stop();
      return;
    }
    retryTimer = setTimeout(reconcile, RETRY_INTERVAL_MS);
  }

  return {
    dispose() {
      disposed = true;
      stop();
    },
    markPending(title: { chatId: string; messageId: string }) {
      if (!disposed && !started && title.chatId === chatId) {
        pending = true;
        pendingMessageId = title.messageId;
      }
    },
    responseSettled(messages: readonly { id: string }[]) {
      if (
        !pending ||
        started ||
        disposed ||
        !messages.some((message) => message.id === pendingMessageId)
      ) {
        return;
      }
      started = true;
      expiresAt = Date.now() + RECONCILIATION_WINDOW_MS;
      deadlineTimer = setTimeout(stop, RECONCILIATION_WINDOW_MS);
      // onFinish already refreshes once. Retry only an explicitly pending title.
      retryTimer = setTimeout(reconcile, RETRY_INTERVAL_MS);
    },
  };
}

export function createChatTitleReconciliationManager({
  revalidateHistory,
}: {
  revalidateHistory: () => Promise<TitleHistory | undefined>;
}) {
  const reconcilers = new Map<
    string,
    ReturnType<typeof createChatTitleReconciler>
  >();
  let disposed = false;
  return {
    dispose() {
      disposed = true;
      for (const reconciler of reconcilers.values()) {
        reconciler.dispose();
      }
      reconcilers.clear();
    },
    markPending(title: { chatId: string; messageId: string }) {
      if (disposed) {
        return;
      }
      let reconciler = reconcilers.get(title.chatId);
      if (!reconciler) {
        reconciler = createChatTitleReconciler({
          chatId: title.chatId,
          onComplete: () => {
            reconcilers.delete(title.chatId);
          },
          revalidateHistory,
        });
        reconcilers.set(title.chatId, reconciler);
      }
      reconciler.markPending(title);
    },
    responseSettled(messages: readonly { id: string }[]) {
      for (const reconciler of reconcilers.values()) {
        reconciler.responseSettled(messages);
      }
    },
  };
}
