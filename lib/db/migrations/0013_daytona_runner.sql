CREATE TABLE "RunnerAgent" (
	"createdAt" timestamp DEFAULT now() NOT NULL,
	"daytonaSandboxId" text,
	"description" varchar(240) DEFAULT '' NOT NULL,
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"instructions" varchar(12000) NOT NULL,
	"lastRunAt" timestamp,
	"model" varchar(120) NOT NULL,
	"name" varchar(64) NOT NULL,
	"runtime" varchar(16) NOT NULL,
	"sandboxGeneration" integer DEFAULT 0 NOT NULL,
	"sandboxLifecycle" varchar(24) DEFAULT 'unprovisioned' NOT NULL,
	"sandboxUpdatedAt" timestamp DEFAULT now() NOT NULL,
	"status" varchar(16) DEFAULT 'idle' NOT NULL,
	"tenant" varchar(64) NOT NULL,
	"updatedAt" timestamp DEFAULT now() NOT NULL,
	"version" integer DEFAULT 0 NOT NULL,
	"warmStatus" varchar(16) DEFAULT 'not_started' NOT NULL,
	"warmUpdatedAt" timestamp DEFAULT now() NOT NULL,
	"workspace" varchar(1024),
	CONSTRAINT "RunnerAgent_id_tenant_key" UNIQUE("id","tenant"),
	CONSTRAINT "RunnerAgent_tenant_valid" CHECK ("RunnerAgent"."tenant" ~ '^[A-Za-z0-9_]{1,64}$'),
	CONSTRAINT "RunnerAgent_runtime_valid" CHECK ("RunnerAgent"."runtime" in ('cloud', 'codex', 'claude', 'copilot')),
	CONSTRAINT "RunnerAgent_status_valid" CHECK ("RunnerAgent"."status" in ('idle', 'running', 'error')),
	CONSTRAINT "RunnerAgent_sandboxLifecycle_valid" CHECK ("RunnerAgent"."sandboxLifecycle" in ('unprovisioned', 'provisioning', 'ready', 'decommissioning', 'decommission_failed')),
	CONSTRAINT "RunnerAgent_warmStatus_valid" CHECK ("RunnerAgent"."warmStatus" in ('not_started', 'provisioning', 'ready', 'failed')),
	CONSTRAINT "RunnerAgent_sandboxGeneration_nonnegative" CHECK ("RunnerAgent"."sandboxGeneration" >= 0),
	CONSTRAINT "RunnerAgent_version_nonnegative" CHECK ("RunnerAgent"."version" >= 0)
);
--> statement-breakpoint
CREATE TABLE "RunnerRun" (
	"agentId" uuid NOT NULL,
	"commandEvidence" jsonb DEFAULT '[]'::jsonb NOT NULL,
	"completedAt" timestamp,
	"createdAt" timestamp DEFAULT now() NOT NULL,
	"daytonaCommandId" text,
	"daytonaAttemptId" varchar(36),
	"daytonaSessionId" text,
	"dispatchLeaseExpiresAt" timestamp,
	"dispatchLeaseToken" varchar(80),
	"dispatchState" varchar(16) DEFAULT 'queued' NOT NULL,
	"error" jsonb,
	"fileEvidence" jsonb DEFAULT '[]'::jsonb NOT NULL,
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"logCursor" integer DEFAULT 0 NOT NULL,
	"operationId" uuid NOT NULL,
	"output" text DEFAULT '' NOT NULL,
	"queueSequence" integer GENERATED ALWAYS AS IDENTITY NOT NULL,
	"requestHash" varchar(64) NOT NULL,
	"startedAt" timestamp,
	"status" varchar(16) DEFAULT 'queued' NOT NULL,
	"task" varchar(40000) NOT NULL,
	"tenant" varchar(64) NOT NULL,
	"updatedAt" timestamp DEFAULT now() NOT NULL,
	"version" integer DEFAULT 0 NOT NULL,
	CONSTRAINT "RunnerRun_tenant_valid" CHECK ("RunnerRun"."tenant" ~ '^[A-Za-z0-9_]{1,64}$'),
	CONSTRAINT "RunnerRun_status_valid" CHECK ("RunnerRun"."status" in ('queued', 'running', 'completed', 'failed', 'cancelled')),
	CONSTRAINT "RunnerRun_dispatchState_valid" CHECK ("RunnerRun"."dispatchState" in ('queued', 'dispatching', 'running', 'terminal')),
	CONSTRAINT "RunnerRun_queueSequence_positive" CHECK ("RunnerRun"."queueSequence" > 0),
	CONSTRAINT "RunnerRun_logCursor_nonnegative" CHECK ("RunnerRun"."logCursor" >= 0),
	CONSTRAINT "RunnerRun_version_nonnegative" CHECK ("RunnerRun"."version" >= 0),
	CONSTRAINT "RunnerRun_timestamps_valid" CHECK (("RunnerRun"."status" = 'queued' and "RunnerRun"."startedAt" is null and "RunnerRun"."completedAt" is null) or ("RunnerRun"."status" = 'running' and "RunnerRun"."startedAt" is not null and "RunnerRun"."completedAt" is null and "RunnerRun"."startedAt" >= "RunnerRun"."createdAt") or ("RunnerRun"."status" in ('completed', 'failed', 'cancelled') and "RunnerRun"."completedAt" is not null and "RunnerRun"."completedAt" >= "RunnerRun"."createdAt" and ("RunnerRun"."startedAt" is null or ("RunnerRun"."startedAt" >= "RunnerRun"."createdAt" and "RunnerRun"."completedAt" >= "RunnerRun"."startedAt")))),
	CONSTRAINT "RunnerRun_dispatchLease_valid" CHECK (("RunnerRun"."dispatchState" = 'queued' and "RunnerRun"."status" = 'queued' and "RunnerRun"."dispatchLeaseToken" is null and "RunnerRun"."dispatchLeaseExpiresAt" is null) or ("RunnerRun"."dispatchState" = 'dispatching' and "RunnerRun"."status" = 'queued' and "RunnerRun"."dispatchLeaseToken" is not null and "RunnerRun"."dispatchLeaseExpiresAt" is not null and "RunnerRun"."dispatchLeaseExpiresAt" > "RunnerRun"."createdAt") or ("RunnerRun"."dispatchState" = 'running' and "RunnerRun"."status" = 'running' and "RunnerRun"."dispatchLeaseToken" is not null and "RunnerRun"."dispatchLeaseExpiresAt" is not null and "RunnerRun"."dispatchLeaseExpiresAt" > "RunnerRun"."createdAt") or ("RunnerRun"."dispatchState" = 'terminal' and "RunnerRun"."status" in ('completed', 'failed', 'cancelled') and (("RunnerRun"."dispatchLeaseToken" is null and "RunnerRun"."dispatchLeaseExpiresAt" is null) or ("RunnerRun"."dispatchLeaseToken" is not null and "RunnerRun"."dispatchLeaseExpiresAt" is not null)))),
	CONSTRAINT "RunnerRun_output_bounded" CHECK (char_length("RunnerRun"."output") <= 100000),
	CONSTRAINT "RunnerRun_error_bounded" CHECK ("RunnerRun"."error" is null or (jsonb_typeof("RunnerRun"."error") = 'object' and "RunnerRun"."error" ?& array['code', 'message', 'retryable'] and ("RunnerRun"."error" - 'code' - 'message' - 'retryable' - 'details') = '{}'::jsonb and jsonb_typeof("RunnerRun"."error"->'code') = 'string' and ("RunnerRun"."error"->>'code') = btrim("RunnerRun"."error"->>'code') and char_length("RunnerRun"."error"->>'code') between 1 and 64 and jsonb_typeof("RunnerRun"."error"->'message') = 'string' and ("RunnerRun"."error"->>'message') = btrim("RunnerRun"."error"->>'message') and char_length("RunnerRun"."error"->>'message') between 1 and 500 and jsonb_typeof("RunnerRun"."error"->'retryable') = 'boolean' and (not ("RunnerRun"."error" ? 'details') or (jsonb_typeof("RunnerRun"."error"->'details') = 'string' and ("RunnerRun"."error"->>'details') = btrim("RunnerRun"."error"->>'details') and char_length("RunnerRun"."error"->>'details') between 1 and 2000)))),
	CONSTRAINT "RunnerRun_commandEvidence_bounded" CHECK (jsonb_typeof("RunnerRun"."commandEvidence") = 'array' and jsonb_array_length("RunnerRun"."commandEvidence") <= 256),
	CONSTRAINT "RunnerRun_fileEvidence_bounded" CHECK (jsonb_typeof("RunnerRun"."fileEvidence") = 'array' and jsonb_array_length("RunnerRun"."fileEvidence") <= 256),
	CONSTRAINT "RunnerRun_daytonaCommand_requires_session" CHECK ("RunnerRun"."daytonaCommandId" is null or "RunnerRun"."daytonaSessionId" is not null),
	CONSTRAINT "RunnerRun_daytonaAttempt_valid" CHECK ("RunnerRun"."daytonaAttemptId" is null or "RunnerRun"."daytonaAttemptId" ~ '^[0-9a-f]{8}-[0-9a-f]{4}-[1-5][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$')
);
--> statement-breakpoint
CREATE TABLE "RunnerRunEvent" (
	"createdAt" timestamp DEFAULT now() NOT NULL,
	"event" jsonb NOT NULL,
	"eventId" integer NOT NULL,
	"runId" uuid NOT NULL,
	CONSTRAINT "RunnerRunEvent_runId_eventId_pk" PRIMARY KEY("runId","eventId"),
	CONSTRAINT "RunnerRunEvent_eventId_nonnegative" CHECK ("RunnerRunEvent"."eventId" >= 0),
	CONSTRAINT "RunnerRunEvent_event_object" CHECK (jsonb_typeof("RunnerRunEvent"."event") = 'object')
);
--> statement-breakpoint
CREATE TABLE "RunnerScheduler" (
	"consecutiveDispatchCount" integer DEFAULT 0 NOT NULL,
	"lastDispatchedTenantHash" varchar(67),
	"singleton" boolean PRIMARY KEY DEFAULT true NOT NULL,
	"updatedAt" timestamp DEFAULT now() NOT NULL,
	CONSTRAINT "RunnerScheduler_singleton" CHECK ("RunnerScheduler"."singleton" = true),
	CONSTRAINT "RunnerScheduler_consecutiveDispatchCount_nonnegative" CHECK ("RunnerScheduler"."consecutiveDispatchCount" >= 0)
);
--> statement-breakpoint
ALTER TABLE "RunnerRun" ADD CONSTRAINT "RunnerRun_agentId_tenant_RunnerAgent_id_tenant_fk" FOREIGN KEY ("agentId","tenant") REFERENCES "public"."RunnerAgent"("id","tenant") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "RunnerRunEvent" ADD CONSTRAINT "RunnerRunEvent_runId_RunnerRun_id_fk" FOREIGN KEY ("runId") REFERENCES "public"."RunnerRun"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
CREATE INDEX "RunnerAgent_tenant_updatedAt_idx" ON "RunnerAgent" USING btree ("tenant","updatedAt");--> statement-breakpoint
CREATE INDEX "RunnerRun_agent_createdAt_idx" ON "RunnerRun" USING btree ("agentId","createdAt");--> statement-breakpoint
CREATE INDEX "RunnerRun_queued_sequence_idx" ON "RunnerRun" USING btree ("queueSequence") WHERE "RunnerRun"."dispatchState" = 'queued';--> statement-breakpoint
CREATE UNIQUE INDEX "RunnerRun_queueSequence_unique_idx" ON "RunnerRun" USING btree ("queueSequence");--> statement-breakpoint
CREATE INDEX "RunnerRun_active_tenant_idx" ON "RunnerRun" USING btree ("tenant","status") WHERE "RunnerRun"."status" in ('queued', 'running');--> statement-breakpoint
CREATE INDEX "RunnerRun_expired_dispatch_lease_idx" ON "RunnerRun" USING btree ("dispatchLeaseExpiresAt") WHERE "RunnerRun"."dispatchLeaseToken" is not null and "RunnerRun"."dispatchState" in ('dispatching', 'running');--> statement-breakpoint
CREATE INDEX "RunnerRun_terminal_retention_idx" ON "RunnerRun" USING btree ("agentId","completedAt") WHERE "RunnerRun"."status" in ('completed', 'failed', 'cancelled');--> statement-breakpoint
CREATE UNIQUE INDEX "RunnerRun_agent_operation_idx" ON "RunnerRun" USING btree ("agentId","operationId");--> statement-breakpoint
CREATE UNIQUE INDEX "RunnerRun_daytonaSessionId_live_idx" ON "RunnerRun" USING btree ("daytonaSessionId") WHERE "RunnerRun"."daytonaSessionId" is not null and "RunnerRun"."status" in ('queued', 'running');--> statement-breakpoint
CREATE UNIQUE INDEX "RunnerRun_daytonaCommandId_live_idx" ON "RunnerRun" USING btree ("daytonaCommandId") WHERE "RunnerRun"."daytonaCommandId" is not null and "RunnerRun"."status" in ('queued', 'running');