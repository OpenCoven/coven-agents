import { isSubscriber, type SubscriberSession, toSession } from "@/lib/session";

export type SessionLike = {
  user?: {
    id?: string | null;
    type?: string | null;
  } | null;
} | null;

export type SubscriberAccessDecision =
  | {
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

  const productSession = toSession({
    id: userId,
    type: session.user?.type ?? "",
  });
  if (!isSubscriber(productSession)) {
    return { kind: "subscription_required" };
  }

  return { kind: "allowed", session: productSession, userId };
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
