CREATE TABLE "RunnerAttemptRedaction" (
	"aadVersion" integer NOT NULL,
	"attemptId" varchar(36) NOT NULL,
	"ciphertext" text NOT NULL,
	"createdAt" timestamp DEFAULT now() NOT NULL,
	"iv" varchar(64) NOT NULL,
	"kekVersion" varchar(32) NOT NULL,
	"runId" uuid PRIMARY KEY NOT NULL,
	"wrappedKey" varchar(128) NOT NULL,
	CONSTRAINT "RunnerAttemptRedaction_attemptId_unique" UNIQUE("attemptId"),
	CONSTRAINT "RunnerAttemptRedaction_aadVersion_valid" CHECK ("RunnerAttemptRedaction"."aadVersion" = 1),
	CONSTRAINT "RunnerAttemptRedaction_attemptId_valid" CHECK ("RunnerAttemptRedaction"."attemptId" ~ '^[0-9a-f]{8}-[0-9a-f]{4}-[1-5][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$'),
	CONSTRAINT "RunnerAttemptRedaction_envelope_nonempty" CHECK (char_length("RunnerAttemptRedaction"."ciphertext") > 0 and char_length("RunnerAttemptRedaction"."iv") > 0 and char_length("RunnerAttemptRedaction"."kekVersion") > 0 and char_length("RunnerAttemptRedaction"."wrappedKey") > 0)
);
--> statement-breakpoint
ALTER TABLE "RunnerAgent" DROP CONSTRAINT "RunnerAgent_sandboxLifecycle_valid";--> statement-breakpoint
ALTER TABLE "RunnerRun" ADD COLUMN "cancellationRequestedAt" timestamp;--> statement-breakpoint
ALTER TABLE "RunnerRun" ADD COLUMN "daytonaLogCursor" integer DEFAULT 0 NOT NULL;--> statement-breakpoint
ALTER TABLE "RunnerAttemptRedaction" ADD CONSTRAINT "RunnerAttemptRedaction_runId_RunnerRun_id_fk" FOREIGN KEY ("runId") REFERENCES "public"."RunnerRun"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
CREATE INDEX "RunnerAgent_sandbox_recovery_idx" ON "RunnerAgent" USING btree ("sandboxLifecycle","sandboxUpdatedAt") WHERE "RunnerAgent"."sandboxLifecycle" in ('provisioning', 'provisioning_ambiguous', 'resetting', 'decommissioning');--> statement-breakpoint
CREATE INDEX "RunnerRun_terminal_attempt_cleanup_idx" ON "RunnerRun" USING btree ("dispatchLeaseExpiresAt") WHERE "RunnerRun"."dispatchState" = 'terminal' and "RunnerRun"."daytonaAttemptId" is not null and "RunnerRun"."dispatchLeaseToken" is not null;--> statement-breakpoint
ALTER TABLE "RunnerAgent" ADD CONSTRAINT "RunnerAgent_sandboxLifecycle_valid" CHECK ("RunnerAgent"."sandboxLifecycle" in ('unprovisioned', 'provisioning', 'provisioning_ambiguous', 'ready', 'resetting', 'decommissioning', 'decommission_failed'));--> statement-breakpoint
ALTER TABLE "RunnerRun" ADD CONSTRAINT "RunnerRun_daytonaLogCursor_nonnegative" CHECK ("RunnerRun"."daytonaLogCursor" >= 0);--> statement-breakpoint
ALTER TABLE "RunnerRun" ADD CONSTRAINT "RunnerRun_daytonaSession_requires_attempt" CHECK ("RunnerRun"."daytonaSessionId" is null or "RunnerRun"."daytonaAttemptId" is not null);