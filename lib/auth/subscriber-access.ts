import { isSubscriber, type SubscriberSession, toSession } from "@/lib/session";
import { validAuthVersion } from "./session-revocation";

export type SessionLike = {
  user?: {
    authVersion?: number | null;
    id?: string | null;
    type?: string | null;
  } | null;
} | null;

export type SubscriberAccessDecision =
  | {
      authVersion: number;
      kind: "allowed";
      session: SubscriberSession;
      userId: string;
    }
  | { kind: "subscription_required" }
  | { kind: "unauthorized" };

export function decideSubscriberAccess(
  session: SessionLike
): SubscriberAccessDecision {
  const userId = session?.user?.id;
  if (!userId) {
    return { kind: "unauthorized" };
  }

  let productSession: ReturnType<typeof toSession>;
  try {
    productSession = toSession({
      id: userId,
      type: session.user?.type ?? "",
    });
  } catch {
    return { kind: "unauthorized" };
  }
  if (!isSubscriber(productSession)) {
    return { kind: "subscription_required" };
  }

  const authVersion = session.user?.authVersion;
  if (!validAuthVersion(authVersion)) {
    return { kind: "unauthorized" };
  }

  return { authVersion, kind: "allowed", session: productSession, userId };
}

export function subscriberAccessResponse(
  decision: Exclude<SubscriberAccessDecision, { kind: "allowed" }>
): Response {
  if (decision.kind === "unauthorized") {
    return Response.json(
      {
        error: "unauthorized",
        message: "Sign in before continuing.",
      },
      { status: 401 }
    );
  }

  return Response.json(
    {
      error: "subscription_required",
      message:
        "Guest accounts can explore the safe replay and account setup. Live and persistent features need an active subscription.",
    },
    { status: 403 }
  );
}
