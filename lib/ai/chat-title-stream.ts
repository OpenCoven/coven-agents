import "server-only";

export type ChatTitleFailure =
  | "generation_failed"
  | "generation_timeout"
  | "generation_invalid"
  | "persistence_failed"
  | "delivery_failed";

export function reportChatTitleFailure(reason: ChatTitleFailure): void {
  console.warn("[chat-title]", reason);
}

type TitleTask = {
  emit: (title: string) => void;
  generate: () => Promise<string>;
  persist: (title: string) => Promise<{ title: string } | null>;
  report?: (reason: ChatTitleFailure) => void;
  waitUntil: (task: Promise<void>) => void;
};

async function commitTitle({
  emit,
  generate,
  persist,
  report = reportChatTitleFailure,
}: TitleTask): Promise<void> {
  let title: string;
  try {
    title = await generate();
  } catch {
    report("generation_failed");
    return;
  }

  let saved: { title: string } | null;
  try {
    saved = await persist(title);
  } catch {
    report("persistence_failed");
    return;
  }
  if (!saved) {
    return;
  }
  try {
    emit(saved.title);
  } catch {
    report("delivery_failed");
  }
}

export function scheduleChatTitle(task: TitleTask): void {
  // Retain the side task without adding it to the response stream's lifetime.
  task.waitUntil(commitTitle(task));
}
