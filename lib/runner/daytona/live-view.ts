import "server-only";

import type { RunSnapshot } from "@opencoven/agent-contracts";
import type { RunnerLiveViewProvider, RunnerLiveViewResult } from "../service";
import { daytonaSandboxName } from "./names";
import { classifyDaytonaProviderError } from "./sandbox";

/**
 * Daytona's computer-use stack serves noVNC on this port once started. The
 * signed preview URL is minted for exactly that port and nothing else.
 */
export const DAYTONA_NOVNC_PORT = 6080;

/** Signed URLs are short-lived; the console refreshes before they lapse. */
export const DAYTONA_LIVE_VIEW_TTL_SECONDS = 300;

/**
 * The narrow slice of a Daytona sandbox the live view needs, so tests and
 * the diagnostic path can stand one in without a real client.
 */
export type DaytonaLiveViewSandbox = Readonly<{
  computerUse: Readonly<{
    getStatus: () => Promise<Readonly<{ status?: string }>>;
    start: () => Promise<unknown>;
  }>;
  getSignedPreviewUrl: (
    port: number,
    expiresInSeconds?: number
  ) => Promise<Readonly<{ url: string }>>;
}>;

export type DaytonaLiveViewDependencies = Readonly<{
  clock?: () => Date;
  enabled: boolean;
  get: (sandboxName: string) => Promise<DaytonaLiveViewSandbox>;
  ttlSeconds?: number;
}>;

/**
 * Whether operators may open a live view at all. Off by default: the view
 * shows the sandbox unredacted, so it is a deliberate deployment decision
 * (`RUNNER_LIVE_VIEW=1`) rather than something that ships on.
 */
export function liveViewEnabledFromEnvironment(
  environment: NodeJS.ProcessEnv = process.env
): boolean {
  const raw = environment.RUNNER_LIVE_VIEW?.trim().toLowerCase();
  return raw === "1" || raw === "true";
}

function desktopRunning(status: string | undefined): boolean {
  return status === "active" || status === "running";
}

/**
 * Resolves a run's persistent sandbox by its deterministic name, brings the
 * desktop up if it is not already, and mints a signed noVNC URL.
 *
 * Failures are classified, never surfaced: a missing sandbox and an image
 * without a desktop are both ordinary outcomes the console must explain,
 * while transport errors are reported as a provider outage. No provider
 * message reaches the caller.
 */
export function daytonaLiveViewProvider(
  dependencies: DaytonaLiveViewDependencies
): RunnerLiveViewProvider {
  const ttlSeconds = dependencies.ttlSeconds ?? DAYTONA_LIVE_VIEW_TTL_SECONDS;
  const clock = dependencies.clock ?? (() => new Date());
  return async ({
    run,
    tenant,
  }: Readonly<{ run: RunSnapshot; tenant: string }>): Promise<
    Exclude<RunnerLiveViewResult, { kind: "not_found" }>
  > => {
    if (!dependencies.enabled) {
      return { kind: "unavailable", reason: "not_configured" };
    }
    let sandbox: DaytonaLiveViewSandbox;
    try {
      sandbox = await dependencies.get(daytonaSandboxName(tenant, run.agentId));
    } catch (error) {
      return {
        kind: "unavailable",
        reason:
          classifyDaytonaProviderError(error) === "not_found"
            ? "sandbox_missing"
            : "provider_unavailable",
      };
    }
    try {
      const status = await sandbox.computerUse.getStatus();
      if (!desktopRunning(status.status)) {
        await sandbox.computerUse.start();
      }
    } catch (error) {
      // The image has no Xvfb/noVNC, or the toolbox refused: either way the
      // run is fine and there is simply nothing to look at.
      return {
        kind: "unavailable",
        reason:
          classifyDaytonaProviderError(error) === "retryable"
            ? "provider_unavailable"
            : "desktop_unavailable",
      };
    }
    try {
      const signed = await sandbox.getSignedPreviewUrl(
        DAYTONA_NOVNC_PORT,
        ttlSeconds
      );
      return {
        expiresAt: new Date(
          clock().getTime() + ttlSeconds * 1000
        ).toISOString(),
        kind: "ready",
        url: signed.url,
      };
    } catch {
      return { kind: "unavailable", reason: "provider_unavailable" };
    }
  };
}
