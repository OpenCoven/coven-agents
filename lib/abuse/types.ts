export const ABUSE_ROUTES = Object.freeze([
  "auth_start",
  "auth_callback",
  "auth_session_update",
  "chat",
  "chat_delete",
  "document_read",
  "document_write",
  "document_delete",
  "history_read",
  "history_delete",
  "messages_read",
  "suggestions_read",
  "vote_read",
  "vote_write",
  "upload",
  "checkout",
  "subscription_read",
  "avatar_read",
  "avatar_write",
  "credential_list",
  "credential_write",
  "credential_delete",
  "credential_device_start",
  "credential_device_poll",
  "usage_read",
  "analytics_read",
  "model_list",
  // Stripe authenticates the payload; abuse admission still limits its source.
  "stripe_webhook",
  "run_start",
  "internal_credential",
  "runner_public_read",
  "runner_read",
  "runner_write",
  "runner_run_start",
  "runner_stop",
  "runner_diagnostic",
  "runner_reconcile",
  "skill_read",
  "skill_write",
  "skill_delete",
  "team_read",
  "team_write",
  "team_delete",
] as const);

export type AbuseRoute = (typeof ABUSE_ROUTES)[number];

export type AbuseSubject = "ip" | "tenant" | "user";

export type AbuseRateWindow = Readonly<{
  limit: number;
  windowSeconds: number;
}>;

export type AbusePolicy = Readonly<{
  bodyBytes: number;
  burst: AbuseRateWindow;
  failureMode: "closed" | "open";
  sustained: AbuseRateWindow;
  subjects: readonly AbuseSubject[];
}>;
