export const ABUSE_ROUTES = Object.freeze([
  "auth_start",
  "auth_callback",
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
  "avatar_read",
  "avatar_write",
  "credential_list",
  "credential_write",
  "credential_delete",
  "credential_device_start",
  "credential_device_poll",
  "runner_connection",
  "runner_token",
  "usage_read",
  "analytics_read",
  "model_list",
  "stripe_webhook",
  "run_start",
  "internal_credential",
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
