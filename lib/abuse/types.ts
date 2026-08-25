export const ABUSE_ROUTES = [
  "auth_start",
  "auth_callback",
  "chat",
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
] as const;

export type AbuseRoute = (typeof ABUSE_ROUTES)[number];

export type AbuseSubject = "ip" | "tenant" | "user";

export type AbusePolicy = {
  bodyBytes: number;
  burst: {
    limit: number;
    windowSeconds: number;
  };
  failureMode: "closed" | "open";
  sustained: {
    limit: number;
    windowSeconds: number;
  };
  subjects: readonly AbuseSubject[];
};
