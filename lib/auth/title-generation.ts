import type {
  AbuseAdmission,
  AbuseEnforcementInput,
} from "@/lib/abuse/enforce";
import type {
  SessionLike,
  SubscriberAccessDecision,
} from "./subscriber-access";

export type TitleGenerationDependencies<Message = unknown> = {
  authorize: (session: SessionLike) => Promise<SubscriberAccessDecision>;
  enforceAbuse: (input: AbuseEnforcementInput) => Promise<AbuseAdmission>;
  generate: (message: Message) => Promise<string>;
};

export async function generateTitleWithAuthorization<Message>(
  message: Message,
  session: SessionLike,
  dependencies: TitleGenerationDependencies<Message>
): Promise<string> {
  const access = await dependencies.authorize(session);
  if (access.kind === "unauthorized") {
    throw new Error("Unauthorized");
  }
  if (access.kind === "subscription_required") {
    throw new Error("Subscription required");
  }

  const admission = await dependencies.enforceAbuse({
    ip: null,
    route: "chat",
    userId: access.userId,
  });
  if (admission.kind === "denied") {
    throw new Error("Title generation rate limit exceeded.");
  }
  if (admission.kind === "unavailable") {
    throw new Error("Abuse control unavailable.");
  }

  return dependencies.generate(message);
}
