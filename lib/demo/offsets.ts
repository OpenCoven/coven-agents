import type { RunEvent } from "@opencoven/agent-contracts";

export type ArrivedEvent = {
  event: RunEvent;
  receivedAt: number;
};

export function toOffsets(
  arrivals: readonly ArrivedEvent[]
): { event: RunEvent; offsetMs: number }[] {
  if (arrivals.length === 0) {
    return [];
  }

  const firstReceivedAt = arrivals[0].receivedAt;
  let previousOffset = 0;

  return arrivals.map(({ event, receivedAt }) => {
    // Replay follows observed arrival time; optional event.at is source metadata
    // and may be absent or reflect a clock different from the recorder's.
    const computedOffset = Math.round(receivedAt - firstReceivedAt);
    // Late or reordered delivery must not move replay time behind the prior event.
    const offsetMs = Math.max(previousOffset, computedOffset);
    previousOffset = offsetMs;
    return { event, offsetMs };
  });
}
