CREATE TABLE "RunnerGitHubCapability" (
	"approvedCapabilities" jsonb NOT NULL,
	"createdAt" timestamp DEFAULT now() NOT NULL,
	"expiresAt" timestamp NOT NULL,
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"maxCallCount" integer NOT NULL,
	"repositoryAllowlist" jsonb NOT NULL,
	"revokedAt" timestamp,
	"teamStepId" uuid NOT NULL,
	"tenant" varchar(64) NOT NULL,
	"tokenHash" varchar(64) NOT NULL,
	"usedCallCount" integer DEFAULT 0 NOT NULL,
	"version" integer DEFAULT 0 NOT NULL,
	CONSTRAINT "RGHCap_id_tenant_uq" UNIQUE("id","tenant"),
	CONSTRAINT "RGHCap_step_owner_uq" UNIQUE("id","tenant","teamStepId"),
	CONSTRAINT "RGHCap_tokenHash_uq" UNIQUE("tokenHash"),
	CONSTRAINT "RGHCap_tenant_valid" CHECK ("RunnerGitHubCapability"."tenant" ~ '^[A-Za-z0-9_]{1,64}$'),
	CONSTRAINT "RGHCap_tokenHash_valid" CHECK ("RunnerGitHubCapability"."tokenHash" ~ '^[a-f0-9]{64}$'),
	CONSTRAINT "RGHCap_caps_valid" CHECK (jsonb_typeof("RunnerGitHubCapability"."approvedCapabilities") = 'array' and jsonb_array_length("RunnerGitHubCapability"."approvedCapabilities") between 1 and 8 and "RunnerGitHubCapability"."approvedCapabilities" <@ '["github.issues.read","github.issues.write","github.pull_requests.read","github.pull_requests.write","github.projects.read","github.projects.write"]'::jsonb),
	CONSTRAINT "RGHCap_repos_valid" CHECK (jsonb_typeof("RunnerGitHubCapability"."repositoryAllowlist") = 'array' and jsonb_array_length("RunnerGitHubCapability"."repositoryAllowlist") between 1 and 16),
	CONSTRAINT "RGHCap_calls_valid" CHECK ("RunnerGitHubCapability"."maxCallCount" between 1 and 32 and "RunnerGitHubCapability"."usedCallCount" between 0 and "RunnerGitHubCapability"."maxCallCount"),
	CONSTRAINT "RGHCap_timestamps_valid" CHECK ("RunnerGitHubCapability"."expiresAt" > "RunnerGitHubCapability"."createdAt" and ("RunnerGitHubCapability"."revokedAt" is null or "RunnerGitHubCapability"."revokedAt" >= "RunnerGitHubCapability"."createdAt")),
	CONSTRAINT "RGHCap_version_valid" CHECK ("RunnerGitHubCapability"."version" >= 0)
);
--> statement-breakpoint
CREATE TABLE "RunnerGitHubConnection" (
	"accountId" varchar(20) NOT NULL,
	"accountLogin" varchar(100) NOT NULL,
	"accountType" varchar(16) NOT NULL,
	"createdAt" timestamp DEFAULT now() NOT NULL,
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"installationId" varchar(20) NOT NULL,
	"repositoryId" varchar(20) NOT NULL,
	"repositoryName" varchar(100) NOT NULL,
	"repositoryNodeId" varchar(256) NOT NULL,
	"repositoryOwner" varchar(100) NOT NULL,
	"tenant" varchar(64) NOT NULL,
	"updatedAt" timestamp DEFAULT now() NOT NULL,
	"version" integer DEFAULT 0 NOT NULL,
	CONSTRAINT "RGHConn_id_tenant_uq" UNIQUE("id","tenant"),
	CONSTRAINT "RGHConn_tenant_repo_uq" UNIQUE("tenant","repositoryId"),
	CONSTRAINT "RGHConn_tenant_valid" CHECK ("RunnerGitHubConnection"."tenant" ~ '^[A-Za-z0-9_]{1,64}$'),
	CONSTRAINT "RGHConn_decimal_ids" CHECK ("RunnerGitHubConnection"."installationId" ~ '^(0|[1-9][0-9]{0,19})$' and "RunnerGitHubConnection"."accountId" ~ '^(0|[1-9][0-9]{0,19})$' and "RunnerGitHubConnection"."repositoryId" ~ '^(0|[1-9][0-9]{0,19})$'),
	CONSTRAINT "RGHConn_accountType_valid" CHECK ("RunnerGitHubConnection"."accountType" in ('Organization', 'User')),
	CONSTRAINT "RGHConn_version_valid" CHECK ("RunnerGitHubConnection"."version" >= 0)
);
--> statement-breakpoint
CREATE TABLE "RunnerGitHubOperation" (
	"capabilityId" uuid NOT NULL,
	"completedAt" timestamp,
	"createdAt" timestamp DEFAULT now() NOT NULL,
	"error" jsonb,
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"kind" varchar(32) NOT NULL,
	"operationId" uuid NOT NULL,
	"providerRequestId" varchar(256),
	"requestHash" varchar(64) NOT NULL,
	"resultNodeId" varchar(256),
	"resultUrl" varchar(2048),
	"startedAt" timestamp,
	"status" varchar(16) DEFAULT 'pending' NOT NULL,
	"target" varchar(512) NOT NULL,
	"teamStepId" uuid NOT NULL,
	"tenant" varchar(64) NOT NULL,
	"updatedAt" timestamp DEFAULT now() NOT NULL,
	"version" integer DEFAULT 0 NOT NULL,
	CONSTRAINT "RGHOp_id_tenant_uq" UNIQUE("id","tenant"),
	CONSTRAINT "RGHOp_step_operation_uq" UNIQUE("teamStepId","tenant","operationId"),
	CONSTRAINT "RGHOp_tenant_valid" CHECK ("RunnerGitHubOperation"."tenant" ~ '^[A-Za-z0-9_]{1,64}$'),
	CONSTRAINT "RGHOp_kind_valid" CHECK ("RunnerGitHubOperation"."kind" in ('issue.get', 'issue.search', 'issue.create', 'issue.comment', 'pull.get', 'pull.create', 'pull.comment', 'pull.review', 'project.item.add', 'project.item.field.update')),
	CONSTRAINT "RGHOp_status_valid" CHECK ("RunnerGitHubOperation"."status" in ('pending', 'running', 'completed', 'failed')),
	CONSTRAINT "RGHOp_requestHash_valid" CHECK ("RunnerGitHubOperation"."requestHash" ~ '^[a-f0-9]{64}$'),
	CONSTRAINT "RGHOp_version_valid" CHECK ("RunnerGitHubOperation"."version" >= 0),
	CONSTRAINT "RGHOp_resultUrl_valid" CHECK ("RunnerGitHubOperation"."resultUrl" is null or "RunnerGitHubOperation"."resultUrl" ~ '^https://github\.com/'),
	CONSTRAINT "RGHOp_timestamps_valid" CHECK (("RunnerGitHubOperation"."startedAt" is null or "RunnerGitHubOperation"."startedAt" >= "RunnerGitHubOperation"."createdAt") and ("RunnerGitHubOperation"."completedAt" is null or ("RunnerGitHubOperation"."completedAt" >= "RunnerGitHubOperation"."createdAt" and ("RunnerGitHubOperation"."startedAt" is null or "RunnerGitHubOperation"."completedAt" >= "RunnerGitHubOperation"."startedAt")))),
	CONSTRAINT "RGHOp_error_bounded" CHECK ("RunnerGitHubOperation"."error" is null or (jsonb_typeof("RunnerGitHubOperation"."error") = 'object' and "RunnerGitHubOperation"."error" ?& array['code', 'message', 'retryable'] and ("RunnerGitHubOperation"."error" - 'code' - 'message' - 'retryable' - 'details') = '{}'::jsonb and jsonb_typeof("RunnerGitHubOperation"."error"->'code') = 'string' and char_length("RunnerGitHubOperation"."error"->>'code') between 1 and 64 and jsonb_typeof("RunnerGitHubOperation"."error"->'message') = 'string' and char_length("RunnerGitHubOperation"."error"->>'message') between 1 and 500 and jsonb_typeof("RunnerGitHubOperation"."error"->'retryable') = 'boolean' and (not ("RunnerGitHubOperation"."error" ? 'details') or (jsonb_typeof("RunnerGitHubOperation"."error"->'details') = 'string' and char_length("RunnerGitHubOperation"."error"->>'details') between 1 and 2000))))
);
--> statement-breakpoint
CREATE TABLE "RunnerSkill" (
	"createdAt" timestamp DEFAULT now() NOT NULL,
	"description" varchar(240) DEFAULT '' NOT NULL,
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"instructions" varchar(4000) NOT NULL,
	"name" varchar(64) NOT NULL,
	"requiredCapabilities" jsonb DEFAULT '[]'::jsonb NOT NULL,
	"tenant" varchar(64) NOT NULL,
	"updatedAt" timestamp DEFAULT now() NOT NULL,
	"version" integer DEFAULT 0 NOT NULL,
	CONSTRAINT "RSkill_id_tenant_uq" UNIQUE("id","tenant"),
	CONSTRAINT "RSkill_tenant_valid" CHECK ("RunnerSkill"."tenant" ~ '^[A-Za-z0-9_]{1,64}$'),
	CONSTRAINT "RSkill_version_valid" CHECK ("RunnerSkill"."version" >= 0),
	CONSTRAINT "RSkill_caps_valid" CHECK (jsonb_typeof("RunnerSkill"."requiredCapabilities") = 'array' and jsonb_array_length("RunnerSkill"."requiredCapabilities") <= 8 and "RunnerSkill"."requiredCapabilities" <@ '["workspace.read","workspace.write","github.issues.read","github.issues.write","github.pull_requests.read","github.pull_requests.write","github.projects.read","github.projects.write"]'::jsonb)
);
--> statement-breakpoint
CREATE TABLE "RunnerTeam" (
	"createdAt" timestamp DEFAULT now() NOT NULL,
	"description" varchar(240) DEFAULT '' NOT NULL,
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"name" varchar(64) NOT NULL,
	"tenant" varchar(64) NOT NULL,
	"updatedAt" timestamp DEFAULT now() NOT NULL,
	"version" integer DEFAULT 0 NOT NULL,
	CONSTRAINT "RTeam_id_tenant_uq" UNIQUE("id","tenant"),
	CONSTRAINT "RTeam_tenant_valid" CHECK ("RunnerTeam"."tenant" ~ '^[A-Za-z0-9_]{1,64}$'),
	CONSTRAINT "RTeam_version_valid" CHECK ("RunnerTeam"."version" >= 0)
);
--> statement-breakpoint
CREATE TABLE "RunnerTeamMember" (
	"agentId" uuid NOT NULL,
	"createdAt" timestamp DEFAULT now() NOT NULL,
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"position" integer NOT NULL,
	"required" boolean DEFAULT true NOT NULL,
	"responsibility" varchar(12000) NOT NULL,
	"teamId" uuid NOT NULL,
	"tenant" varchar(64) NOT NULL,
	"updatedAt" timestamp DEFAULT now() NOT NULL,
	CONSTRAINT "RTMember_id_tenant_uq" UNIQUE("id","tenant"),
	CONSTRAINT "RTMember_team_pos_uq" UNIQUE("teamId","tenant","position"),
	CONSTRAINT "RTMember_team_agent_uq" UNIQUE("teamId","tenant","agentId"),
	CONSTRAINT "RTMember_tenant_valid" CHECK ("RunnerTeamMember"."tenant" ~ '^[A-Za-z0-9_]{1,64}$'),
	CONSTRAINT "RTMember_position_valid" CHECK ("RunnerTeamMember"."position" >= 0 and "RunnerTeamMember"."position" < 8)
);
--> statement-breakpoint
CREATE TABLE "RunnerTeamMemberSkill" (
	"memberId" uuid NOT NULL,
	"skillId" uuid NOT NULL,
	"tenant" varchar(64) NOT NULL,
	CONSTRAINT "RTMemberSkill_pk" PRIMARY KEY("memberId","tenant","skillId"),
	CONSTRAINT "RTMemberSkill_tenant_valid" CHECK ("RunnerTeamMemberSkill"."tenant" ~ '^[A-Za-z0-9_]{1,64}$')
);
--> statement-breakpoint
CREATE TABLE "RunnerTeamRun" (
	"completedAt" timestamp,
	"createdAt" timestamp DEFAULT now() NOT NULL,
	"currentPosition" integer DEFAULT 0 NOT NULL,
	"error" jsonb,
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"mission" varchar(40000) NOT NULL,
	"operationId" uuid NOT NULL,
	"requestHash" varchar(64) NOT NULL,
	"startedAt" timestamp,
	"status" varchar(24) DEFAULT 'queued' NOT NULL,
	"teamId" uuid NOT NULL,
	"tenant" varchar(64) NOT NULL,
	"updatedAt" timestamp DEFAULT now() NOT NULL,
	"version" integer DEFAULT 0 NOT NULL,
	CONSTRAINT "RTRun_id_tenant_uq" UNIQUE("id","tenant"),
	CONSTRAINT "RTRun_team_operation_uq" UNIQUE("teamId","tenant","operationId"),
	CONSTRAINT "RTRun_tenant_valid" CHECK ("RunnerTeamRun"."tenant" ~ '^[A-Za-z0-9_]{1,64}$'),
	CONSTRAINT "RTRun_status_valid" CHECK ("RunnerTeamRun"."status" in ('queued', 'running', 'waiting_approval', 'completed', 'completed_with_warnings', 'failed', 'cancelled')),
	CONSTRAINT "RTRun_position_valid" CHECK ("RunnerTeamRun"."currentPosition" >= 0 and "RunnerTeamRun"."currentPosition" <= 8),
	CONSTRAINT "RTRun_version_valid" CHECK ("RunnerTeamRun"."version" >= 0),
	CONSTRAINT "RTRun_requestHash_valid" CHECK ("RunnerTeamRun"."requestHash" ~ '^[a-f0-9]{64}$'),
	CONSTRAINT "RTRun_timestamps_valid" CHECK (("RunnerTeamRun"."startedAt" is null or "RunnerTeamRun"."startedAt" >= "RunnerTeamRun"."createdAt") and ("RunnerTeamRun"."completedAt" is null or ("RunnerTeamRun"."completedAt" >= "RunnerTeamRun"."createdAt" and ("RunnerTeamRun"."startedAt" is null or "RunnerTeamRun"."completedAt" >= "RunnerTeamRun"."startedAt")))),
	CONSTRAINT "RTRun_error_bounded" CHECK ("RunnerTeamRun"."error" is null or (jsonb_typeof("RunnerTeamRun"."error") = 'object' and "RunnerTeamRun"."error" ?& array['code', 'message', 'retryable'] and ("RunnerTeamRun"."error" - 'code' - 'message' - 'retryable' - 'details') = '{}'::jsonb and jsonb_typeof("RunnerTeamRun"."error"->'code') = 'string' and char_length("RunnerTeamRun"."error"->>'code') between 1 and 64 and jsonb_typeof("RunnerTeamRun"."error"->'message') = 'string' and char_length("RunnerTeamRun"."error"->>'message') between 1 and 500 and jsonb_typeof("RunnerTeamRun"."error"->'retryable') = 'boolean' and (not ("RunnerTeamRun"."error" ? 'details') or (jsonb_typeof("RunnerTeamRun"."error"->'details') = 'string' and char_length("RunnerTeamRun"."error"->>'details') between 1 and 2000))))
);
--> statement-breakpoint
CREATE TABLE "RunnerTeamStep" (
	"agentId" uuid NOT NULL,
	"approvalStatus" varchar(16) DEFAULT 'not_required' NOT NULL,
	"completedAt" timestamp,
	"createdAt" timestamp DEFAULT now() NOT NULL,
	"error" jsonb,
	"handoff" jsonb,
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"memberId" uuid NOT NULL,
	"position" integer NOT NULL,
	"required" boolean NOT NULL,
	"responsibility" varchar(12000) NOT NULL,
	"runnerRunId" uuid,
	"skillIds" jsonb DEFAULT '[]'::jsonb NOT NULL,
	"skillSnapshots" jsonb DEFAULT '[]'::jsonb NOT NULL,
	"startedAt" timestamp,
	"status" varchar(24) DEFAULT 'pending' NOT NULL,
	"teamRunId" uuid NOT NULL,
	"tenant" varchar(64) NOT NULL,
	"updatedAt" timestamp DEFAULT now() NOT NULL,
	"version" integer DEFAULT 0 NOT NULL,
	CONSTRAINT "RTStep_id_tenant_uq" UNIQUE("id","tenant"),
	CONSTRAINT "RTStep_run_position_uq" UNIQUE("teamRunId","tenant","position"),
	CONSTRAINT "RTStep_tenant_valid" CHECK ("RunnerTeamStep"."tenant" ~ '^[A-Za-z0-9_]{1,64}$'),
	CONSTRAINT "RTStep_position_valid" CHECK ("RunnerTeamStep"."position" >= 0 and "RunnerTeamStep"."position" < 8),
	CONSTRAINT "RTStep_status_valid" CHECK ("RunnerTeamStep"."status" in ('pending', 'queued', 'running', 'waiting_approval', 'completed', 'failed', 'cancelled', 'skipped')),
	CONSTRAINT "RTStep_approval_valid" CHECK ("RunnerTeamStep"."approvalStatus" in ('not_required', 'pending', 'approved', 'rejected')),
	CONSTRAINT "RTStep_version_valid" CHECK ("RunnerTeamStep"."version" >= 0),
	CONSTRAINT "RTStep_skillIds_valid" CHECK (jsonb_typeof("RunnerTeamStep"."skillIds") = 'array' and jsonb_array_length("RunnerTeamStep"."skillIds") <= 8),
	CONSTRAINT "RTStep_skillSnapshots_valid" CHECK (jsonb_typeof("RunnerTeamStep"."skillSnapshots") = 'array' and jsonb_array_length("RunnerTeamStep"."skillSnapshots") <= 8),
	CONSTRAINT "RTStep_handoff_bounded" CHECK ("RunnerTeamStep"."handoff" is null or (jsonb_typeof("RunnerTeamStep"."handoff") = 'object' and "RunnerTeamStep"."handoff" ?& array['output', 'commandEvidence', 'fileEvidence'] and ("RunnerTeamStep"."handoff" - 'output' - 'commandEvidence' - 'fileEvidence') = '{}'::jsonb and octet_length("RunnerTeamStep"."handoff"::text) <= 16384 and jsonb_typeof("RunnerTeamStep"."handoff"->'output') = 'string' and jsonb_typeof("RunnerTeamStep"."handoff"->'commandEvidence') = 'array' and jsonb_array_length("RunnerTeamStep"."handoff"->'commandEvidence') <= 256 and jsonb_typeof("RunnerTeamStep"."handoff"->'fileEvidence') = 'array' and jsonb_array_length("RunnerTeamStep"."handoff"->'fileEvidence') <= 256)),
	CONSTRAINT "RTStep_error_bounded" CHECK ("RunnerTeamStep"."error" is null or (jsonb_typeof("RunnerTeamStep"."error") = 'object' and "RunnerTeamStep"."error" ?& array['code', 'message', 'retryable'] and ("RunnerTeamStep"."error" - 'code' - 'message' - 'retryable' - 'details') = '{}'::jsonb and jsonb_typeof("RunnerTeamStep"."error"->'code') = 'string' and char_length("RunnerTeamStep"."error"->>'code') between 1 and 64 and jsonb_typeof("RunnerTeamStep"."error"->'message') = 'string' and char_length("RunnerTeamStep"."error"->>'message') between 1 and 500 and jsonb_typeof("RunnerTeamStep"."error"->'retryable') = 'boolean' and (not ("RunnerTeamStep"."error" ? 'details') or (jsonb_typeof("RunnerTeamStep"."error"->'details') = 'string' and char_length("RunnerTeamStep"."error"->>'details') between 1 and 2000)))),
	CONSTRAINT "RTStep_timestamps_valid" CHECK (("RunnerTeamStep"."startedAt" is null or "RunnerTeamStep"."startedAt" >= "RunnerTeamStep"."createdAt") and ("RunnerTeamStep"."completedAt" is null or ("RunnerTeamStep"."completedAt" >= "RunnerTeamStep"."createdAt" and ("RunnerTeamStep"."startedAt" is null or "RunnerTeamStep"."completedAt" >= "RunnerTeamStep"."startedAt"))))
);
--> statement-breakpoint
ALTER TABLE "RunnerGitHubCapability" ADD CONSTRAINT "RGHCap_step_fk" FOREIGN KEY ("teamStepId","tenant") REFERENCES "public"."RunnerTeamStep"("id","tenant") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "RunnerGitHubOperation" ADD CONSTRAINT "RGHOp_step_fk" FOREIGN KEY ("teamStepId","tenant") REFERENCES "public"."RunnerTeamStep"("id","tenant") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "RunnerGitHubOperation" ADD CONSTRAINT "RGHOp_capability_fk" FOREIGN KEY ("capabilityId","tenant","teamStepId") REFERENCES "public"."RunnerGitHubCapability"("id","tenant","teamStepId") ON DELETE restrict ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "RunnerTeamMember" ADD CONSTRAINT "RTMember_team_fk" FOREIGN KEY ("teamId","tenant") REFERENCES "public"."RunnerTeam"("id","tenant") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "RunnerTeamMember" ADD CONSTRAINT "RTMember_agent_fk" FOREIGN KEY ("agentId","tenant") REFERENCES "public"."RunnerAgent"("id","tenant") ON DELETE restrict ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "RunnerTeamMemberSkill" ADD CONSTRAINT "RTMemberSkill_member_fk" FOREIGN KEY ("memberId","tenant") REFERENCES "public"."RunnerTeamMember"("id","tenant") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "RunnerTeamMemberSkill" ADD CONSTRAINT "RTMemberSkill_skill_fk" FOREIGN KEY ("skillId","tenant") REFERENCES "public"."RunnerSkill"("id","tenant") ON DELETE restrict ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "RunnerTeamRun" ADD CONSTRAINT "RTRun_team_fk" FOREIGN KEY ("teamId","tenant") REFERENCES "public"."RunnerTeam"("id","tenant") ON DELETE restrict ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "RunnerTeamStep" ADD CONSTRAINT "RTStep_teamRun_fk" FOREIGN KEY ("teamRunId","tenant") REFERENCES "public"."RunnerTeamRun"("id","tenant") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "RunnerTeamStep" ADD CONSTRAINT "RTStep_agent_fk" FOREIGN KEY ("agentId","tenant") REFERENCES "public"."RunnerAgent"("id","tenant") ON DELETE restrict ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "RunnerTeamStep" ADD CONSTRAINT "RTStep_runnerRun_fk" FOREIGN KEY ("runnerRunId","tenant") REFERENCES "public"."RunnerRun"("id","tenant") ON DELETE restrict ON UPDATE no action;--> statement-breakpoint
CREATE INDEX "RGHCap_expiry_idx" ON "RunnerGitHubCapability" USING btree ("expiresAt");--> statement-breakpoint
CREATE INDEX "RGHConn_installation_idx" ON "RunnerGitHubConnection" USING btree ("installationId");--> statement-breakpoint
CREATE INDEX "RGHOp_status_updated_idx" ON "RunnerGitHubOperation" USING btree ("status","updatedAt");--> statement-breakpoint
CREATE INDEX "RSkill_tenant_updated_idx" ON "RunnerSkill" USING btree ("tenant","updatedAt");--> statement-breakpoint
CREATE INDEX "RTeam_tenant_updated_idx" ON "RunnerTeam" USING btree ("tenant","updatedAt");--> statement-breakpoint
CREATE INDEX "RTMemberSkill_skill_idx" ON "RunnerTeamMemberSkill" USING btree ("skillId","tenant");--> statement-breakpoint
CREATE INDEX "RTRun_tenant_created_idx" ON "RunnerTeamRun" USING btree ("tenant","createdAt");--> statement-breakpoint
CREATE INDEX "RTRun_status_updated_idx" ON "RunnerTeamRun" USING btree ("status","updatedAt");--> statement-breakpoint
CREATE UNIQUE INDEX "RTStep_runnerRun_uq" ON "RunnerTeamStep" USING btree ("runnerRunId");--> statement-breakpoint
CREATE INDEX "RTStep_status_updated_idx" ON "RunnerTeamStep" USING btree ("status","updatedAt");--> statement-breakpoint
ALTER TABLE "RunnerRun" ADD CONSTRAINT "RunnerRun_id_tenant_key" UNIQUE("id","tenant");