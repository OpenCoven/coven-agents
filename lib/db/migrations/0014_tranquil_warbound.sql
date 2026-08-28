ALTER TABLE "RunnerAgent" DROP CONSTRAINT "RunnerAgent_sandboxLifecycle_valid";--> statement-breakpoint
ALTER TABLE "RunnerRun" ADD COLUMN "cancellationRequestedAt" timestamp;--> statement-breakpoint
ALTER TABLE "RunnerRun" ADD COLUMN "daytonaLogCursor" integer DEFAULT 0 NOT NULL;--> statement-breakpoint
ALTER TABLE "RunnerAgent" ADD CONSTRAINT "RunnerAgent_sandboxLifecycle_valid" CHECK ("RunnerAgent"."sandboxLifecycle" in ('unprovisioned', 'provisioning', 'provisioning_ambiguous', 'ready', 'resetting', 'decommissioning', 'decommission_failed'));--> statement-breakpoint
ALTER TABLE "RunnerRun" ADD CONSTRAINT "RunnerRun_daytonaLogCursor_nonnegative" CHECK ("RunnerRun"."daytonaLogCursor" >= 0);--> statement-breakpoint
ALTER TABLE "RunnerRun" ADD CONSTRAINT "RunnerRun_daytonaSession_requires_attempt" CHECK ("RunnerRun"."daytonaSessionId" is null or "RunnerRun"."daytonaAttemptId" is not null);