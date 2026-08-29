import type { RunEvent, RunSnapshot } from "@opencoven/agent-contracts";

/**
 * A run the console is holding.
 *
 * The runner publishes no route that lists runs for an agent — only
 * `GET /api/runs/:id` for one the client already knows about. So the rail shows
 * the runs this browser session started or opened rather than implying an
 * archive that cannot be fetched.
 */
export type ConsoleRun = {
  agentId: string;
  events: RunEvent[];
  /** The highest event id already applied, used to resume a dropped stream. */
  lastEventId: number;
  snapshot: RunSnapshot;
};

export type ConsoleView = "console" | "composer" | "create" | "settings";
