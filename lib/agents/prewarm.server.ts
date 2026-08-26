import { claimsForUser, mintRunnerToken } from "@/lib/agents/runner-token";
import { isSubscribedAt } from "@/lib/subscription";

const PREWARM_TIMEOUT_MS = 5000;

/**
 * Asks the runner to boot the sandbox of the user's most recently run agent,
 * so a returning subscriber's first mission skips the container cold start.
 *
 * Called from the sign-in path via `after()`, which is why every exit here is
 * silent: warming is an optimization, and an optimization that can fail
 * sign-in — or even slow it — has its priorities inverted. A refused or
 * failed warm costs exactly what not calling this costs: one cold start.
 *
 * Gates itself on the subscription rather than trusting the caller, because
 * the worker will 403 a demo claim anyway and the cheapest refusal is the
 * one that skips the network. This is the app's only server-side call to the
 * worker; everything else goes browser-direct.
 */
export async function prewarmTenantSandbox(
  user: {
    id: string;
    subscribedUntil: Date | null;
  },
  request: typeof fetch = fetch
): Promise<void> {
  try {
    if (!isSubscribedAt(user, new Date())) {
      return;
    }
    const endpoint = (
      process.env.CLOUD_RUNNER_URL ?? process.env.NEXT_PUBLIC_CLOUD_RUNNER_URL
    )?.replace(/\/+$/, "");
    const controlToken = process.env.AGENT_CONTROL_TOKEN;
    const signingKey = process.env.RUNNER_SIGNING_KEY;
    if (!(endpoint && controlToken && signingKey)) {
      return;
    }

    const identity = await mintRunnerToken(
      claimsForUser({ id: user.id, type: "subscriber" }),
      signingKey
    );
    await request(`${endpoint}/api/tenant/prewarm`, {
      headers: {
        authorization: `Bearer ${identity}`,
        "x-runner-token": controlToken,
      },
      method: "POST",
      signal: AbortSignal.timeout(PREWARM_TIMEOUT_MS),
    });
  } catch {
    // The next run pays the cold start it would have paid anyway.
  }
}
