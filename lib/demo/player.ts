import type { DemoTranscript } from "@opencoven/agent-contracts";

/** Longer pauses convey nothing to someone watching a replay. */
export const MAX_GAP_MS = 1500;

/** Unmodified playback. One constant, so relative rhythm is preserved. */
export const DEMO_SPEED = 1;

export type PlaybackStep = {
  delayMs: number;
  event: DemoTranscript["events"][number]["event"];
};

/**
 * Turns recorded offsets into the delays a player waits between events.
 *
 * Both transforms live here rather than in the fixture, so the committed
 * recording stays a faithful record and only its presentation is adjusted.
 */
export function planPlayback(
  entries: DemoTranscript["events"],
  options: { speed?: number } = {}
): PlaybackStep[] {
  const speed = options.speed ?? DEMO_SPEED;
  if (!(speed > 0)) {
    throw new Error(`Playback speed must be greater than zero, got ${speed}.`);
  }

  let previous = 0;
  return entries.map((entry, index) => {
    const gap = index === 0 ? 0 : entry.offsetMs - previous;
    previous = entry.offsetMs;
    return {
      delayMs: Math.round(Math.min(Math.max(gap, 0), MAX_GAP_MS) / speed),
      event: entry.event,
    };
  });
}
