import { isHarnessId } from "@opencoven/harness";
import {
  isSubscriber,
  type Session,
  type SubscriberSession,
} from "@/lib/session";
import { CODEX_AUTH_MESSAGE, prepareCodexAuth } from "./codex-auth";

export type CredentialWriteDecision =
  | { harnessId: string; kind: "allowed"; session: SubscriberSession }
  | { kind: "forbidden" }
  | { kind: "invalid"; reason: string; message?: string }
  | { kind: "unauthorized" };

/**
 * Decides whether a caller may write a credential, and for which harness.
 *
 * Deliberately a pure function rather than logic inside the route handler.
 * Inline route code is unreachable by a unit test, and this is the decision
 * that says who may write to the owner's database — the same shape of mistake
 * as hardcoding a subscriber plan inside a mint endpoint, which passed every
 * test until it was extracted.
 *
 * A demo session is `forbidden`, not `unauthorized`: the caller is
 * authenticated, they simply have no subscription. Collapsing the two would
 * tell a signed-in user to sign in again.
 */
export function decideCredentialWrite(
  session: Session | null,
  body: { credential?: unknown; harnessId?: unknown },
  operation: "store" | "remove" = "store"
): CredentialWriteDecision {
  if (!session) {
    return { kind: "unauthorized" };
  }
  if (!isSubscriber(session)) {
    return { kind: "forbidden" };
  }

  const { harnessId } = body;
  if (typeof harnessId !== "string" || !isHarnessId(harnessId)) {
    // Rejecting unknown ids keeps the table to rows a run could actually use.
    // An arbitrary id would store a credential nothing ever reads, which looks
    // like a working setup and behaves like a missing one.
    return { kind: "invalid", reason: "unknown_harness" };
  }

  const { credential } = body;
  if (typeof credential !== "string" || !credential.trim()) {
    return { kind: "invalid", reason: "empty_credential" };
  }

  if (harnessId === "codex" && operation === "store") {
    try {
      prepareCodexAuth(credential);
    } catch {
      return {
        kind: "invalid",
        message: CODEX_AUTH_MESSAGE,
        reason: "invalid_codex_auth",
      };
    }
  }
  return { harnessId, kind: "allowed", session };
}
