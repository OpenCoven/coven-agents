DO $$
BEGIN
  IF EXISTS (SELECT 1 FROM "RunnerTeamRun") THEN
    RAISE EXCEPTION '0021 cannot reconstruct initiating authority for existing team runs';
  END IF;
END $$;--> statement-breakpoint
ALTER TABLE "RunnerRun" ADD COLUMN "agentInstructions" varchar(12000);--> statement-breakpoint
ALTER TABLE "RunnerRun" ADD COLUMN "agentModel" varchar(120);--> statement-breakpoint
ALTER TABLE "RunnerRun" ADD COLUMN "agentRuntime" varchar(16);--> statement-breakpoint
ALTER TABLE "RunnerRun" ADD COLUMN "agentWorkspace" varchar(1024);--> statement-breakpoint
UPDATE "RunnerRun" AS "run"
SET "agentInstructions" = "agent"."instructions",
    "agentModel" = "agent"."model",
    "agentRuntime" = "agent"."runtime",
    "agentWorkspace" = "agent"."workspace"
FROM "RunnerAgent" AS "agent"
WHERE "agent"."id" = "run"."agentId"
  AND "agent"."tenant" = "run"."tenant";--> statement-breakpoint
ALTER TABLE "RunnerRun" ALTER COLUMN "agentInstructions" SET NOT NULL;--> statement-breakpoint
ALTER TABLE "RunnerRun" ALTER COLUMN "agentModel" SET NOT NULL;--> statement-breakpoint
ALTER TABLE "RunnerRun" ALTER COLUMN "agentRuntime" SET NOT NULL;--> statement-breakpoint
ALTER TABLE "RunnerTeamRun" ADD COLUMN "authVersion" integer;--> statement-breakpoint
ALTER TABLE "RunnerTeamRun" ADD COLUMN "createdByUserId" uuid;--> statement-breakpoint
ALTER TABLE "RunnerTeamRun" ALTER COLUMN "authVersion" SET NOT NULL;--> statement-breakpoint
ALTER TABLE "RunnerTeamRun" ALTER COLUMN "createdByUserId" SET NOT NULL;--> statement-breakpoint
ALTER TABLE "RunnerTeamStep" ADD COLUMN "agentInstructions" varchar(12000);--> statement-breakpoint
ALTER TABLE "RunnerTeamStep" ADD COLUMN "agentModel" varchar(120);--> statement-breakpoint
ALTER TABLE "RunnerTeamStep" ADD COLUMN "agentRuntime" varchar(16);--> statement-breakpoint
ALTER TABLE "RunnerTeamStep" ADD COLUMN "agentWorkspace" varchar(1024);--> statement-breakpoint
UPDATE "RunnerTeamStep" AS "step"
SET "agentInstructions" = "agent"."instructions",
    "agentModel" = "agent"."model",
    "agentRuntime" = "agent"."runtime",
    "agentWorkspace" = "agent"."workspace"
FROM "RunnerAgent" AS "agent"
WHERE "agent"."id" = "step"."agentId"
  AND "agent"."tenant" = "step"."tenant";--> statement-breakpoint
ALTER TABLE "RunnerTeamStep" ALTER COLUMN "agentInstructions" SET NOT NULL;--> statement-breakpoint
ALTER TABLE "RunnerTeamStep" ALTER COLUMN "agentModel" SET NOT NULL;--> statement-breakpoint
ALTER TABLE "RunnerTeamStep" ALTER COLUMN "agentRuntime" SET NOT NULL;--> statement-breakpoint
ALTER TABLE "RunnerTeamStep" ADD COLUMN "approvalActorUserId" uuid;--> statement-breakpoint
ALTER TABLE "RunnerTeamStep" ADD COLUMN "approvalDecidedAt" timestamp;--> statement-breakpoint
ALTER TABLE "RunnerTeamStep" ADD COLUMN "approvedCapabilities" jsonb DEFAULT '[]'::jsonb NOT NULL;--> statement-breakpoint
ALTER TABLE "RunnerTeamRun" ADD CONSTRAINT "RTRun_createdByUser_fk" FOREIGN KEY ("createdByUserId") REFERENCES "public"."User"("id") ON DELETE restrict ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "RunnerTeamStep" ADD CONSTRAINT "RTStep_approvalActorUser_fk" FOREIGN KEY ("approvalActorUserId") REFERENCES "public"."User"("id") ON DELETE restrict ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "RunnerRun" ADD CONSTRAINT "RunnerRun_agentSnapshot_valid" CHECK (char_length(btrim("RunnerRun"."agentInstructions")) between 1 and 12000 and char_length(btrim("RunnerRun"."agentModel")) between 1 and 120 and "RunnerRun"."agentRuntime" in ('codex', 'claude', 'copilot'));--> statement-breakpoint
ALTER TABLE "RunnerTeamRun" ADD CONSTRAINT "RTRun_authVersion_valid" CHECK ("RunnerTeamRun"."authVersion" >= 0);--> statement-breakpoint
ALTER TABLE "RunnerTeamStep" ADD CONSTRAINT "RTStep_approvedCapabilities_valid" CHECK (jsonb_typeof("RunnerTeamStep"."approvedCapabilities") = 'array' and jsonb_array_length("RunnerTeamStep"."approvedCapabilities") <= 8 and "RunnerTeamStep"."approvedCapabilities" <@ '["github.issues.read","github.issues.write","github.pull_requests.read","github.pull_requests.write","github.projects.read","github.projects.write"]'::jsonb);--> statement-breakpoint
ALTER TABLE "RunnerTeamStep" ADD CONSTRAINT "RTStep_approval_audit_valid" CHECK ((("RunnerTeamStep"."approvalStatus" in ('not_required', 'pending')) and "RunnerTeamStep"."approvalActorUserId" is null and "RunnerTeamStep"."approvalDecidedAt" is null and jsonb_array_length("RunnerTeamStep"."approvedCapabilities") = 0) or ("RunnerTeamStep"."approvalStatus" = 'approved' and "RunnerTeamStep"."approvalActorUserId" is not null and "RunnerTeamStep"."approvalDecidedAt" is not null and "RunnerTeamStep"."approvalDecidedAt" >= "RunnerTeamStep"."createdAt" and jsonb_array_length("RunnerTeamStep"."approvedCapabilities") between 1 and 8) or ("RunnerTeamStep"."approvalStatus" = 'rejected' and "RunnerTeamStep"."approvalActorUserId" is not null and "RunnerTeamStep"."approvalDecidedAt" is not null and "RunnerTeamStep"."approvalDecidedAt" >= "RunnerTeamStep"."createdAt" and jsonb_array_length("RunnerTeamStep"."approvedCapabilities") = 0));--> statement-breakpoint
ALTER TABLE "RunnerTeamStep" ADD CONSTRAINT "RTStep_agentSnapshot_valid" CHECK (char_length(btrim("RunnerTeamStep"."agentInstructions")) between 1 and 12000 and char_length(btrim("RunnerTeamStep"."agentModel")) between 1 and 120 and "RunnerTeamStep"."agentRuntime" in ('codex', 'claude', 'copilot'));
--> statement-breakpoint
ALTER TABLE "RunnerTeamStep" DROP CONSTRAINT "RTStep_handoff_bounded";--> statement-breakpoint
ALTER TABLE "RunnerTeamStep" ADD CONSTRAINT "RTStep_handoff_bounded" CHECK ("RunnerTeamStep"."handoff" is null or (jsonb_typeof("RunnerTeamStep"."handoff") = 'object' and "RunnerTeamStep"."handoff" ?& array['output', 'commandEvidence', 'fileEvidence'] and ("RunnerTeamStep"."handoff" - 'output' - 'commandEvidence' - 'fileEvidence') = '{}'::jsonb and octet_length("RunnerTeamStep"."handoff"::text) <= 24576 and jsonb_typeof("RunnerTeamStep"."handoff"->'output') = 'string' and jsonb_typeof("RunnerTeamStep"."handoff"->'commandEvidence') = 'array' and jsonb_array_length("RunnerTeamStep"."handoff"->'commandEvidence') <= 256 and jsonb_typeof("RunnerTeamStep"."handoff"->'fileEvidence') = 'array' and jsonb_array_length("RunnerTeamStep"."handoff"->'fileEvidence') <= 256));