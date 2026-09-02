-- Consolidated audited GitHub capability broker migration after current main.
CREATE TABLE "RunnerGitHubConnectionFence" (
	"generation" bigint DEFAULT 0 NOT NULL,
	"tenant" varchar(64) PRIMARY KEY NOT NULL,
	"updatedAt" timestamp DEFAULT now() NOT NULL,
	CONSTRAINT "RGHConnFence_tenant_valid" CHECK ("RunnerGitHubConnectionFence"."tenant" ~ '^[A-Za-z0-9_]{1,64}$'),
	CONSTRAINT "RGHConnFence_generation_nonnegative" CHECK ("RunnerGitHubConnectionFence"."generation" >= 0)
);
--> statement-breakpoint
INSERT INTO "RunnerGitHubConnectionFence" ("tenant", "generation", "updatedAt")
SELECT DISTINCT "tenant", 0, now()
FROM "RunnerGitHubConnection"
ON CONFLICT ("tenant") DO NOTHING;
--> statement-breakpoint
CREATE UNIQUE INDEX "RGHConnFence_tenant_generation_uq" ON "RunnerGitHubConnectionFence" USING btree ("tenant","generation");
--> statement-breakpoint
DO $$
BEGIN
  IF EXISTS (SELECT 1 FROM "RunnerGitHubCapability")
    OR EXISTS (SELECT 1 FROM "RunnerGitHubOperation") THEN
    RAISE EXCEPTION '0032 cannot migrate pre-gateway GitHub authority';
  END IF;
END $$;--> statement-breakpoint
ALTER TABLE "RunnerGitHubCapability" DROP CONSTRAINT "RGHCap_caps_valid";--> statement-breakpoint
ALTER TABLE "RunnerRun" DROP CONSTRAINT "RunnerRun_executionPermission_valid";--> statement-breakpoint
ALTER TABLE "RunnerGitHubCapability" ADD COLUMN "allowedCapabilities" jsonb NOT NULL;--> statement-breakpoint
ALTER TABLE "RunnerGitHubCapability" ADD COLUMN "attemptId" uuid NOT NULL;--> statement-breakpoint
ALTER TABLE "RunnerGitHubCapability" ADD COLUMN "authVersion" integer NOT NULL;--> statement-breakpoint
ALTER TABLE "RunnerGitHubCapability" ADD COLUMN "connectionGeneration" bigint NOT NULL;--> statement-breakpoint
ALTER TABLE "RunnerGitHubCapability" ADD COLUMN "declaredCapabilities" jsonb NOT NULL;--> statement-breakpoint
ALTER TABLE "RunnerGitHubCapability" ADD COLUMN "runnerRunId" uuid NOT NULL;--> statement-breakpoint
ALTER TABLE "RunnerGitHubCapability" ADD COLUMN "teamRunId" uuid NOT NULL;--> statement-breakpoint
ALTER TABLE "RunnerGitHubOperation" ADD COLUMN "connectionGeneration" bigint NOT NULL;--> statement-breakpoint
ALTER TABLE "RunnerGitHubOperation" ADD COLUMN "connectionId" uuid NOT NULL;--> statement-breakpoint
ALTER TABLE "RunnerGitHubOperation" ADD COLUMN "executionLeaseExpiresAt" timestamp NOT NULL;--> statement-breakpoint
ALTER TABLE "RunnerGitHubOperation" ADD COLUMN "operationMarker" varchar(80);--> statement-breakpoint
ALTER TABLE "RunnerGitHubOperation" ADD COLUMN "repository" varchar(201) NOT NULL;--> statement-breakpoint
ALTER TABLE "RunnerGitHubOperation" ADD COLUMN "requiredCapability" varchar(40) NOT NULL;--> statement-breakpoint
ALTER TABLE "RunnerGitHubOperation" ADD COLUMN "resultJson" jsonb;--> statement-breakpoint
ALTER TABLE "RunnerRun" ADD COLUMN "githubBrokerPolicy" jsonb;--> statement-breakpoint
ALTER TABLE "RunnerRun" ADD COLUMN "teamStepId" uuid;--> statement-breakpoint
UPDATE "RunnerRun" AS "run"
SET "teamStepId" = "step"."id"
FROM "RunnerTeamStep" AS "step"
WHERE COALESCE("step"."runnerRunId", "step"."plannedRunnerRunId") = "run"."id"
  AND "step"."tenant" = "run"."tenant";--> statement-breakpoint
ALTER TABLE "RunnerGitHubCapability" ADD CONSTRAINT "RunnerGitHubCapability_runnerRun_fk" FOREIGN KEY ("runnerRunId","tenant") REFERENCES "public"."RunnerRun"("id","tenant") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "RunnerGitHubCapability" ADD CONSTRAINT "RunnerGitHubCapability_teamRun_fk" FOREIGN KEY ("teamRunId","tenant") REFERENCES "public"."RunnerTeamRun"("id","tenant") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "RunnerGitHubOperation" ADD CONSTRAINT "RunnerGitHubOperation_connection_fk" FOREIGN KEY ("connectionId","tenant") REFERENCES "public"."RunnerGitHubConnection"("id","tenant") ON DELETE restrict ON UPDATE no action;--> statement-breakpoint
CREATE UNIQUE INDEX "RGHCap_active_runnerRun_uq" ON "RunnerGitHubCapability" USING btree ("runnerRunId") WHERE "RunnerGitHubCapability"."revokedAt" is null;--> statement-breakpoint
ALTER TABLE "RunnerGitHubCapability" ADD CONSTRAINT "RGHCap_binding_valid" CHECK ("RunnerGitHubCapability"."authVersion" >= 0 and "RunnerGitHubCapability"."connectionGeneration" >= 0);--> statement-breakpoint
ALTER TABLE "RunnerGitHubCapability" ADD CONSTRAINT "RGHCap_caps_valid" CHECK (jsonb_typeof("RunnerGitHubCapability"."declaredCapabilities") = 'array' and jsonb_array_length("RunnerGitHubCapability"."declaredCapabilities") between 1 and 8 and "RunnerGitHubCapability"."declaredCapabilities" <@ '["github.issues.read","github.issues.write","github.pull_requests.read","github.pull_requests.write","github.projects.read","github.projects.write"]'::jsonb and jsonb_typeof("RunnerGitHubCapability"."approvedCapabilities") = 'array' and jsonb_array_length("RunnerGitHubCapability"."approvedCapabilities") <= 8 and "RunnerGitHubCapability"."approvedCapabilities" <@ "RunnerGitHubCapability"."declaredCapabilities" and jsonb_typeof("RunnerGitHubCapability"."allowedCapabilities") = 'array' and jsonb_array_length("RunnerGitHubCapability"."allowedCapabilities") between 1 and 8 and "RunnerGitHubCapability"."allowedCapabilities" <@ "RunnerGitHubCapability"."declaredCapabilities");--> statement-breakpoint
ALTER TABLE "RunnerGitHubOperation" ADD CONSTRAINT "RGHOp_binding_valid" CHECK ("RunnerGitHubOperation"."connectionGeneration" >= 0 and "RunnerGitHubOperation"."repository" ~ '^[a-z0-9_.-]{1,100}/[a-z0-9_.-]{1,100}$' and "RunnerGitHubOperation"."requiredCapability" in ('github.issues.read','github.issues.write','github.pull_requests.read','github.pull_requests.write','github.projects.read','github.projects.write'));--> statement-breakpoint
ALTER TABLE "RunnerGitHubOperation" ADD CONSTRAINT "RGHOp_result_valid" CHECK (("RunnerGitHubOperation"."status" = 'completed' and "RunnerGitHubOperation"."resultJson" is not null and jsonb_typeof("RunnerGitHubOperation"."resultJson") = 'object') or ("RunnerGitHubOperation"."status" <> 'completed' and "RunnerGitHubOperation"."resultJson" is null));--> statement-breakpoint
ALTER TABLE "RunnerRun" ADD CONSTRAINT "RunnerRun_githubBrokerPolicy_valid" CHECK ("RunnerRun"."githubBrokerPolicy" is null or ("RunnerRun"."teamStepId" is not null and jsonb_typeof("RunnerRun"."githubBrokerPolicy") = 'object' and "RunnerRun"."githubBrokerPolicy"->>'version' = '1' and "RunnerRun"."githubBrokerPolicy"->>'teamStepId' = "RunnerRun"."teamStepId"::text and "RunnerRun"."githubBrokerPolicy"->>'authVersion' = "RunnerRun"."authVersion"::text and jsonb_typeof("RunnerRun"."githubBrokerPolicy"->'allowedCapabilities') = 'array' and jsonb_array_length("RunnerRun"."githubBrokerPolicy"->'allowedCapabilities') between 1 and 8 and jsonb_typeof("RunnerRun"."githubBrokerPolicy"->'repositories') = 'array' and jsonb_array_length("RunnerRun"."githubBrokerPolicy"->'repositories') between 1 and 16));--> statement-breakpoint
ALTER TABLE "RunnerRun" ADD CONSTRAINT "RunnerRun_executionPermission_valid" CHECK ("RunnerRun"."executionPermission" in ('unrestricted', 'workspace_read', 'workspace_write', 'github_only'));--> statement-breakpoint
DROP TRIGGER "RunnerRun_team_execution_permission_guard" ON "RunnerRun";--> statement-breakpoint
CREATE OR REPLACE FUNCTION "RunnerRun_enforce_team_execution_permission"() RETURNS trigger AS $$
DECLARE
  "agentTrust" varchar(16);
  "declaredGitHub" jsonb;
  "expectedAllowed" jsonb;
  "expectedApproved" jsonb;
  "expectedRepositories" jsonb;
  "stepAuthVersion" integer;
  "stepId" uuid;
  "stepRunId" uuid;
  "teamPermission" varchar(32);
BEGIN
  SELECT
    "step"."id",
    "step"."teamRunId",
    "teamRun"."authVersion",
    CASE
      WHEN EXISTS (
        SELECT 1
        FROM jsonb_array_elements("step"."skillSnapshots") AS "skill"("snapshot")
        WHERE ("skill"."snapshot"->'requiredCapabilities') ? 'workspace.write'
      ) THEN 'workspace_write'
      WHEN EXISTS (
        SELECT 1
        FROM jsonb_array_elements("step"."skillSnapshots") AS "skill"("snapshot")
        WHERE ("skill"."snapshot"->'requiredCapabilities') ? 'workspace.read'
      ) THEN 'workspace_read'
      WHEN EXISTS (
        SELECT 1
        FROM jsonb_array_elements("step"."skillSnapshots") AS "skill"("snapshot"),
          jsonb_array_elements_text("skill"."snapshot"->'requiredCapabilities') AS "capability"("value")
        WHERE "capability"."value" LIKE 'github.%'
      ) THEN 'github_only'
      ELSE NULL
    END,
    COALESCE((
      SELECT jsonb_agg("capability" ORDER BY "capability")
      FROM (
        SELECT DISTINCT "capability"."value" AS "capability"
        FROM jsonb_array_elements("step"."skillSnapshots") AS "skill"("snapshot"),
          jsonb_array_elements_text("skill"."snapshot"->'requiredCapabilities') AS "capability"("value")
        WHERE "capability"."value" LIKE 'github.%'
      ) AS "declared"
    ), '[]'::jsonb)
  INTO
    "stepId",
    "stepRunId",
    "stepAuthVersion",
    "teamPermission",
    "declaredGitHub"
  FROM "RunnerTeamStep" AS "step"
  JOIN "RunnerTeamRun" AS "teamRun"
    ON "teamRun"."id" = "step"."teamRunId"
    AND "teamRun"."tenant" = "step"."tenant"
  WHERE "step"."plannedRunnerRunId" = NEW."id"
    AND "step"."plannedOperationId" = NEW."operationId"
    AND "step"."tenant" = NEW."tenant"
  LIMIT 1;

  IF FOUND THEN
    IF NEW."teamStepId" IS NULL OR NEW."teamStepId" <> "stepId" THEN
      RAISE EXCEPTION 'Team child insert requires its exact team step';
    END IF;
    IF NEW."agentRuntime" <> 'copilot' THEN
      RAISE EXCEPTION 'Team child runtime cannot enforce workspace permissions';
    END IF;
    IF "teamPermission" IN ('workspace_read', 'workspace_write')
      AND (NEW."agentWorkspace" IS NULL OR btrim(NEW."agentWorkspace") = '') THEN
      RAISE EXCEPTION 'Team child requires an explicit workspace';
    END IF;
    IF "teamPermission" IS NULL THEN
      RAISE EXCEPTION 'Team child requires declared execution permission';
    END IF;
    IF NEW."executionPermission" IS NULL
      OR NEW."executionPermission" = 'unrestricted' THEN
      RAISE EXCEPTION 'Team child insert requires explicit execution permission';
    END IF;
    IF NEW."executionPermission" <> "teamPermission" THEN
      RAISE EXCEPTION 'Team child execution permission conflicts with its immutable snapshot';
    END IF;

    IF jsonb_array_length("declaredGitHub") = 0 THEN
      IF NEW."githubBrokerPolicy" IS NOT NULL THEN
        RAISE EXCEPTION 'Non-GitHub team child cannot persist broker authority';
      END IF;
    ELSE
      SELECT COALESCE(jsonb_agg("capability" ORDER BY "capability"), '[]'::jsonb)
      INTO "expectedApproved"
      FROM (
        SELECT DISTINCT "approved"."value" AS "capability"
        FROM jsonb_array_elements_text(
          COALESCE((
            SELECT "approvedCapabilities"
            FROM "RunnerTeamStep"
            WHERE "id" = "stepId"
              AND "tenant" = NEW."tenant"
          ), '[]'::jsonb)
        ) AS "approved"("value")
        WHERE "approved"."value" LIKE 'github.%.write'
          AND "declaredGitHub" ? "approved"."value"
      ) AS "approvedSet";

      SELECT COALESCE(jsonb_agg("capability" ORDER BY "capability"), '[]'::jsonb)
      INTO "expectedAllowed"
      FROM (
        SELECT "declared"."value" AS "capability"
        FROM jsonb_array_elements_text("declaredGitHub") AS "declared"("value")
        WHERE "declared"."value" LIKE '%.read'
          OR "expectedApproved" ? "declared"."value"
      ) AS "allowedSet";

      SELECT COALESCE(jsonb_agg(
        jsonb_build_object(
          'accountId', "connection"."accountId",
          'accountLogin', "connection"."accountLogin",
          'accountType', "connection"."accountType",
          'connectionId', "connection"."id",
          'installationId', "connection"."installationId",
          'repository', lower("connection"."repositoryOwner") || '/' || lower("connection"."repositoryName"),
          'repositoryId', "connection"."repositoryId",
          'repositoryName', "connection"."repositoryName",
          'repositoryNodeId', "connection"."repositoryNodeId",
          'repositoryOwner', "connection"."repositoryOwner"
        )
        ORDER BY lower("connection"."repositoryOwner"), lower("connection"."repositoryName")
      ), '[]'::jsonb)
      INTO "expectedRepositories"
      FROM "RunnerGitHubConnection" AS "connection"
      WHERE "connection"."tenant" = NEW."tenant";

      IF NEW."githubBrokerPolicy" IS NULL
        OR (NEW."githubBrokerPolicy" - ARRAY[
          'actorUserId',
          'allowedCapabilities',
          'approvedCapabilities',
          'authVersion',
          'connectionGeneration',
          'declaredCapabilities',
          'maxCallCount',
          'repositories',
          'teamRunId',
          'teamStepId',
          'version'
        ]) <> '{}'::jsonb
        OR NEW."githubBrokerPolicy"->>'version' <> '1'
        OR NEW."githubBrokerPolicy"->>'teamStepId' <> "stepId"::text
        OR NEW."githubBrokerPolicy"->>'teamRunId' <> "stepRunId"::text
        OR NEW."githubBrokerPolicy"->>'actorUserId' <> COALESCE((
          SELECT "createdByUserId"::text
          FROM "RunnerTeamRun"
          WHERE "id" = "stepRunId"
            AND "tenant" = NEW."tenant"
        ), '')
        OR NEW."githubBrokerPolicy"->>'authVersion' <> "stepAuthVersion"::text
        OR NEW."githubBrokerPolicy"->'declaredCapabilities' <> "declaredGitHub"
        OR NEW."githubBrokerPolicy"->'approvedCapabilities' <> "expectedApproved"
        OR NEW."githubBrokerPolicy"->'allowedCapabilities' <> "expectedAllowed"
        OR NEW."githubBrokerPolicy"->'repositories' <> "expectedRepositories"
        OR NEW."githubBrokerPolicy"->>'maxCallCount' <> '32'
        OR NEW."githubBrokerPolicy"->>'connectionGeneration' <> COALESCE((
          SELECT "generation"::text
          FROM "RunnerGitHubConnectionFence"
          WHERE "tenant" = NEW."tenant"
        ), '-1') THEN
        RAISE EXCEPTION 'Team child GitHub broker policy conflicts with durable authority';
      END IF;
    END IF;
  ELSE
    IF NEW."teamStepId" IS NOT NULL OR NEW."githubBrokerPolicy" IS NOT NULL THEN
      RAISE EXCEPTION 'Ordinary runner run cannot persist team broker authority';
    END IF;
  END IF;

  IF NEW."executionPermission" <> 'unrestricted' THEN
    SELECT "sandboxTrust"
    INTO "agentTrust"
    FROM "RunnerAgent"
    WHERE "id" = NEW."agentId"
      AND "tenant" = NEW."tenant"
    FOR UPDATE;

    IF "agentTrust" = 'unrestricted'
      OR EXISTS (
        SELECT 1
        FROM "RunnerRun"
        WHERE "agentId" = NEW."agentId"
          AND "tenant" = NEW."tenant"
          AND "status" IN ('queued', 'running')
          AND "cancellationRequestedAt" IS NULL
          AND "executionPermission" = 'unrestricted'
      ) THEN
      RAISE EXCEPTION 'Restricted execution requires a clean sandbox trust profile';
    END IF;
    UPDATE "RunnerAgent"
    SET "sandboxTrust" = 'restricted',
        "updatedAt" = clock_timestamp(),
        "version" = "version" + 1
    WHERE "id" = NEW."agentId"
      AND "tenant" = NEW."tenant"
      AND "sandboxTrust" <> 'unrestricted';
  END IF;
  RETURN NEW;
END;
$$ LANGUAGE plpgsql;--> statement-breakpoint
CREATE TRIGGER "RunnerRun_team_execution_permission_guard"
  BEFORE INSERT ON "RunnerRun"
  FOR EACH ROW
  EXECUTE FUNCTION "RunnerRun_enforce_team_execution_permission"();--> statement-breakpoint
CREATE FUNCTION "RunnerGitHubCapability_revoke_for_runner_state"() RETURNS trigger AS $$
BEGIN
  IF NEW."status" IN ('completed', 'failed', 'cancelled')
    OR NEW."cancellationRequestedAt" IS NOT NULL
    OR NEW."authVersion" IS DISTINCT FROM OLD."authVersion"
    OR (
      OLD."daytonaAttemptId" IS NOT NULL
      AND NEW."daytonaAttemptId" IS DISTINCT FROM OLD."daytonaAttemptId"
    ) THEN
    UPDATE "RunnerGitHubCapability"
    SET "revokedAt" = COALESCE("revokedAt", clock_timestamp()),
        "updatedAt" = clock_timestamp(),
        "version" = "version" + 1
    WHERE "runnerRunId" = NEW."id"
      AND "tenant" = NEW."tenant"
      AND "revokedAt" IS NULL;
  END IF;
  RETURN NEW;
END;
$$ LANGUAGE plpgsql;--> statement-breakpoint
CREATE TRIGGER "RunnerGitHubCapability_revoke_runner_terminal"
  AFTER UPDATE OF "status", "cancellationRequestedAt", "authVersion", "daytonaAttemptId"
  ON "RunnerRun"
  FOR EACH ROW
  EXECUTE FUNCTION "RunnerGitHubCapability_revoke_for_runner_state"();--> statement-breakpoint
CREATE FUNCTION "RunnerGitHubCapability_revoke_for_step_state"() RETURNS trigger AS $$
BEGIN
  IF NEW."status" IN ('completed', 'failed', 'cancelled', 'skipped')
    OR NEW."approvalStatus" = 'rejected' THEN
    UPDATE "RunnerGitHubCapability"
    SET "revokedAt" = COALESCE("revokedAt", clock_timestamp()),
        "updatedAt" = clock_timestamp(),
        "version" = "version" + 1
    WHERE "teamStepId" = NEW."id"
      AND "tenant" = NEW."tenant"
      AND "revokedAt" IS NULL;
  END IF;
  RETURN NEW;
END;
$$ LANGUAGE plpgsql;--> statement-breakpoint
CREATE TRIGGER "RunnerGitHubCapability_revoke_step_terminal"
  AFTER UPDATE OF "status", "approvalStatus"
  ON "RunnerTeamStep"
  FOR EACH ROW
  EXECUTE FUNCTION "RunnerGitHubCapability_revoke_for_step_state"();--> statement-breakpoint
CREATE FUNCTION "RunnerGitHubCapability_revoke_for_team_run_state"() RETURNS trigger AS $$
BEGIN
  IF NEW."status" IN (
    'completed',
    'completed_with_warnings',
    'failed',
    'cancelled'
  ) THEN
    UPDATE "RunnerGitHubCapability" AS "capability"
    SET "revokedAt" = COALESCE("capability"."revokedAt", clock_timestamp()),
        "updatedAt" = clock_timestamp(),
        "version" = "capability"."version" + 1
    WHERE "capability"."teamRunId" = NEW."id"
      AND "capability"."tenant" = NEW."tenant"
      AND "capability"."revokedAt" IS NULL;
  END IF;
  RETURN NEW;
END;
$$ LANGUAGE plpgsql;--> statement-breakpoint
CREATE TRIGGER "RunnerGitHubCapability_revoke_team_run_terminal"
  AFTER UPDATE OF "status"
  ON "RunnerTeamRun"
  FOR EACH ROW
  EXECUTE FUNCTION "RunnerGitHubCapability_revoke_for_team_run_state"();--> statement-breakpoint
CREATE FUNCTION "RunnerGitHubCapability_revoke_for_auth_version"() RETURNS trigger AS $$
BEGIN
  IF NEW."authVersion" IS DISTINCT FROM OLD."authVersion" THEN
    UPDATE "RunnerGitHubCapability" AS "capability"
    SET "revokedAt" = COALESCE("capability"."revokedAt", clock_timestamp()),
        "updatedAt" = clock_timestamp(),
        "version" = "capability"."version" + 1
    FROM "RunnerTeamRun" AS "teamRun"
    WHERE "teamRun"."id" = "capability"."teamRunId"
      AND "teamRun"."tenant" = "capability"."tenant"
      AND "teamRun"."createdByUserId" = NEW."id"
      AND "capability"."revokedAt" IS NULL;
  END IF;
  RETURN NEW;
END;
$$ LANGUAGE plpgsql;--> statement-breakpoint
CREATE TRIGGER "RunnerGitHubCapability_revoke_auth_version"
  AFTER UPDATE OF "authVersion"
  ON "User"
  FOR EACH ROW
  EXECUTE FUNCTION "RunnerGitHubCapability_revoke_for_auth_version"();--> statement-breakpoint
CREATE FUNCTION "RunnerGitHubCapability_revoke_for_connection_generation"() RETURNS trigger AS $$
BEGIN
  IF NEW."generation" IS DISTINCT FROM OLD."generation" THEN
    UPDATE "RunnerGitHubCapability"
    SET "revokedAt" = COALESCE("revokedAt", clock_timestamp()),
        "updatedAt" = clock_timestamp(),
        "version" = "version" + 1
    WHERE "tenant" = NEW."tenant"
      AND "connectionGeneration" <> NEW."generation"
      AND "revokedAt" IS NULL;
  END IF;
  RETURN NEW;
END;
$$ LANGUAGE plpgsql;--> statement-breakpoint
CREATE TRIGGER "RunnerGitHubCapability_revoke_connection_generation"
  AFTER UPDATE OF "generation"
  ON "RunnerGitHubConnectionFence"
  FOR EACH ROW
  EXECUTE FUNCTION "RunnerGitHubCapability_revoke_for_connection_generation"();
--> statement-breakpoint
ALTER TABLE "RunnerRun" DROP CONSTRAINT "RunnerRun_githubBrokerPolicy_valid";--> statement-breakpoint
ALTER TABLE "RunnerGitHubOperation" ADD CONSTRAINT "RGHOp_tenant_operation_uq" UNIQUE("tenant","operationId");--> statement-breakpoint
ALTER TABLE "RunnerRun" ADD CONSTRAINT "RunnerRun_githubBrokerPolicy_valid" CHECK ("RunnerRun"."githubBrokerPolicy" is null or ("RunnerRun"."teamStepId" is not null and jsonb_typeof("RunnerRun"."githubBrokerPolicy") = 'object' and "RunnerRun"."githubBrokerPolicy"->>'version' = '1' and "RunnerRun"."githubBrokerPolicy"->>'teamStepId' = "RunnerRun"."teamStepId"::text and "RunnerRun"."githubBrokerPolicy"->>'authVersion' = "RunnerRun"."authVersion"::text and ("RunnerRun"."githubBrokerPolicy"->>'actorUserId') ~ '^[0-9a-f]{8}-[0-9a-f]{4}-[1-5][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$' and jsonb_typeof("RunnerRun"."githubBrokerPolicy"->'allowedCapabilities') = 'array' and jsonb_array_length("RunnerRun"."githubBrokerPolicy"->'allowedCapabilities') between 1 and 8 and jsonb_typeof("RunnerRun"."githubBrokerPolicy"->'repositories') = 'array' and jsonb_array_length("RunnerRun"."githubBrokerPolicy"->'repositories') between 1 and 16));
--> statement-breakpoint
ALTER TABLE "RunnerGitHubCapability" DROP CONSTRAINT "RGHCap_caps_valid";--> statement-breakpoint
ALTER TABLE "RunnerGitHubCapability" DROP CONSTRAINT "RGHCap_timestamps_valid";--> statement-breakpoint
ALTER TABLE "RunnerGitHubCapability" ADD CONSTRAINT "RGHCap_caps_valid" CHECK (jsonb_typeof("RunnerGitHubCapability"."declaredCapabilities") = 'array' and jsonb_array_length("RunnerGitHubCapability"."declaredCapabilities") between 1 and 8 and "RunnerGitHubCapability"."declaredCapabilities" <@ '["github.issues.read","github.issues.write","github.pull_requests.read","github.pull_requests.write","github.projects.read","github.projects.write"]'::jsonb and jsonb_typeof("RunnerGitHubCapability"."approvedCapabilities") = 'array' and jsonb_array_length("RunnerGitHubCapability"."approvedCapabilities") <= 8 and "RunnerGitHubCapability"."approvedCapabilities" <@ "RunnerGitHubCapability"."declaredCapabilities" and jsonb_typeof("RunnerGitHubCapability"."allowedCapabilities") = 'array' and jsonb_array_length("RunnerGitHubCapability"."allowedCapabilities") between 1 and 8 and "RunnerGitHubCapability"."allowedCapabilities" <@ "RunnerGitHubCapability"."declaredCapabilities" and "RunnerGitHubCapability"."allowedCapabilities" <@ (jsonb_path_query_array("RunnerGitHubCapability"."declaredCapabilities", '$[*] ? (@ like_regex "read$")') || "RunnerGitHubCapability"."approvedCapabilities"));--> statement-breakpoint
ALTER TABLE "RunnerGitHubCapability" ADD CONSTRAINT "RGHCap_timestamps_valid" CHECK ("RunnerGitHubCapability"."expiresAt" > "RunnerGitHubCapability"."createdAt" and "RunnerGitHubCapability"."expiresAt" <= "RunnerGitHubCapability"."createdAt" + interval '15 minutes' and ("RunnerGitHubCapability"."revokedAt" is null or "RunnerGitHubCapability"."revokedAt" >= "RunnerGitHubCapability"."createdAt"));--> statement-breakpoint
ALTER TABLE "RunnerGitHubOperation" ADD CONSTRAINT "RGHOp_capability_mapping_valid" CHECK ("RunnerGitHubOperation"."requiredCapability" = CASE WHEN "RunnerGitHubOperation"."kind" in ('issue.get','issue.search') THEN 'github.issues.read' WHEN "RunnerGitHubOperation"."kind" in ('issue.create','issue.comment') THEN 'github.issues.write' WHEN "RunnerGitHubOperation"."kind" = 'pull.get' THEN 'github.pull_requests.read' WHEN "RunnerGitHubOperation"."kind" in ('pull.create','pull.comment','pull.review') THEN 'github.pull_requests.write' WHEN "RunnerGitHubOperation"."kind" in ('project.item.add','project.item.field.update') THEN 'github.projects.write' ELSE '' END);--> statement-breakpoint
ALTER TABLE "RunnerGitHubOperation" ADD CONSTRAINT "RGHOp_marker_valid" CHECK (("RunnerGitHubOperation"."kind" in ('issue.get','issue.search','pull.get') and "RunnerGitHubOperation"."operationMarker" is null) or ("RunnerGitHubOperation"."kind" not in ('issue.get','issue.search','pull.get') and "RunnerGitHubOperation"."operationMarker" ~ '^<!-- coven-github:v1:[a-f0-9]{40} -->$'));--> statement-breakpoint
CREATE FUNCTION "RunnerRun_reject_github_authority_change"() RETURNS trigger AS $$
BEGIN
  IF NEW."teamStepId" IS DISTINCT FROM OLD."teamStepId"
    OR NEW."githubBrokerPolicy" IS DISTINCT FROM OLD."githubBrokerPolicy"
    OR NEW."executionPermission" IS DISTINCT FROM OLD."executionPermission" THEN
    RAISE EXCEPTION 'Runner execution authority is immutable';
  END IF;
  RETURN NEW;
END;
$$ LANGUAGE plpgsql;--> statement-breakpoint
CREATE TRIGGER "RunnerRun_github_authority_immutable"
  BEFORE UPDATE OF "teamStepId", "githubBrokerPolicy", "executionPermission"
  ON "RunnerRun"
  FOR EACH ROW
  EXECUTE FUNCTION "RunnerRun_reject_github_authority_change"();--> statement-breakpoint
CREATE FUNCTION "RunnerGitHubCapability_reject_authority_change"() RETURNS trigger AS $$
BEGIN
  IF NEW."id" IS DISTINCT FROM OLD."id"
    OR NEW."tenant" IS DISTINCT FROM OLD."tenant"
    OR NEW."teamStepId" IS DISTINCT FROM OLD."teamStepId"
    OR NEW."teamRunId" IS DISTINCT FROM OLD."teamRunId"
    OR NEW."runnerRunId" IS DISTINCT FROM OLD."runnerRunId"
    OR NEW."attemptId" IS DISTINCT FROM OLD."attemptId"
    OR NEW."authVersion" IS DISTINCT FROM OLD."authVersion"
    OR NEW."connectionGeneration" IS DISTINCT FROM OLD."connectionGeneration"
    OR NEW."tokenHash" IS DISTINCT FROM OLD."tokenHash"
    OR NEW."expiresAt" IS DISTINCT FROM OLD."expiresAt"
    OR NEW."declaredCapabilities" IS DISTINCT FROM OLD."declaredCapabilities"
    OR NEW."approvedCapabilities" IS DISTINCT FROM OLD."approvedCapabilities"
    OR NEW."allowedCapabilities" IS DISTINCT FROM OLD."allowedCapabilities"
    OR NEW."repositoryAllowlist" IS DISTINCT FROM OLD."repositoryAllowlist"
    OR NEW."maxCallCount" IS DISTINCT FROM OLD."maxCallCount"
    OR NEW."createdAt" IS DISTINCT FROM OLD."createdAt"
    OR NEW."usedCallCount" < OLD."usedCallCount"
    OR (
      OLD."revokedAt" IS NOT NULL
      AND NEW."revokedAt" IS DISTINCT FROM OLD."revokedAt"
    ) THEN
    RAISE EXCEPTION 'GitHub capability authority is immutable';
  END IF;
  RETURN NEW;
END;
$$ LANGUAGE plpgsql;--> statement-breakpoint
CREATE TRIGGER "RunnerGitHubCapability_authority_immutable"
  BEFORE UPDATE ON "RunnerGitHubCapability"
  FOR EACH ROW
  EXECUTE FUNCTION "RunnerGitHubCapability_reject_authority_change"();--> statement-breakpoint
CREATE FUNCTION "RunnerGitHubOperation_reject_request_change"() RETURNS trigger AS $$
BEGIN
  IF NEW."id" IS DISTINCT FROM OLD."id"
    OR NEW."tenant" IS DISTINCT FROM OLD."tenant"
    OR NEW."teamStepId" IS DISTINCT FROM OLD."teamStepId"
    OR NEW."capabilityId" IS DISTINCT FROM OLD."capabilityId"
    OR NEW."operationId" IS DISTINCT FROM OLD."operationId"
    OR NEW."kind" IS DISTINCT FROM OLD."kind"
    OR NEW."requestHash" IS DISTINCT FROM OLD."requestHash"
    OR NEW."target" IS DISTINCT FROM OLD."target"
    OR NEW."repository" IS DISTINCT FROM OLD."repository"
    OR NEW."requiredCapability" IS DISTINCT FROM OLD."requiredCapability"
    OR NEW."connectionId" IS DISTINCT FROM OLD."connectionId"
    OR NEW."connectionGeneration" IS DISTINCT FROM OLD."connectionGeneration"
    OR NEW."operationMarker" IS DISTINCT FROM OLD."operationMarker"
    OR NEW."createdAt" IS DISTINCT FROM OLD."createdAt" THEN
    RAISE EXCEPTION 'GitHub operation request authority is immutable';
  END IF;
  RETURN NEW;
END;
$$ LANGUAGE plpgsql;--> statement-breakpoint
CREATE TRIGGER "RunnerGitHubOperation_request_immutable"
  BEFORE UPDATE ON "RunnerGitHubOperation"
  FOR EACH ROW
  EXECUTE FUNCTION "RunnerGitHubOperation_reject_request_change"();--> statement-breakpoint
CREATE FUNCTION "RunnerGitHubOperation_enforce_terminal_state"() RETURNS trigger AS $$
BEGIN
  IF OLD."status" IN ('completed', 'failed')
    AND NEW IS DISTINCT FROM OLD THEN
    RAISE EXCEPTION 'Terminal GitHub operation is immutable';
  END IF;
  IF OLD."status" = 'running'
    AND NEW."status" NOT IN ('running', 'completed', 'failed') THEN
    RAISE EXCEPTION 'GitHub operation status transition is invalid';
  END IF;
  RETURN NEW;
END;
$$ LANGUAGE plpgsql;--> statement-breakpoint
CREATE TRIGGER "RunnerGitHubOperation_terminal_immutable"
  BEFORE UPDATE ON "RunnerGitHubOperation"
  FOR EACH ROW
  EXECUTE FUNCTION "RunnerGitHubOperation_enforce_terminal_state"();
--> statement-breakpoint
ALTER TABLE "RunnerGitHubOperation" DROP CONSTRAINT "RunnerGitHubOperation_connection_fk";
--> statement-breakpoint
DROP TRIGGER "RunnerGitHubOperation_terminal_immutable" ON "RunnerGitHubOperation";--> statement-breakpoint
ALTER TABLE "RunnerGitHubCapability" ADD COLUMN "updatedAt" timestamp DEFAULT now() NOT NULL;--> statement-breakpoint
ALTER TABLE "RunnerGitHubOperation" ALTER COLUMN "connectionId" DROP NOT NULL;--> statement-breakpoint
ALTER TABLE "RunnerGitHubOperation" ADD COLUMN "accountId" varchar(20);--> statement-breakpoint
ALTER TABLE "RunnerGitHubOperation" ADD COLUMN "accountLogin" varchar(100);--> statement-breakpoint
ALTER TABLE "RunnerGitHubOperation" ADD COLUMN "accountType" varchar(16);--> statement-breakpoint
ALTER TABLE "RunnerGitHubOperation" ADD COLUMN "installationId" varchar(20);--> statement-breakpoint
ALTER TABLE "RunnerGitHubOperation" ADD COLUMN "repositoryId" varchar(20);--> statement-breakpoint
ALTER TABLE "RunnerGitHubOperation" ADD COLUMN "repositoryName" varchar(100);--> statement-breakpoint
ALTER TABLE "RunnerGitHubOperation" ADD COLUMN "repositoryNodeId" varchar(256);--> statement-breakpoint
ALTER TABLE "RunnerGitHubOperation" ADD COLUMN "repositoryOwner" varchar(100);--> statement-breakpoint
UPDATE "RunnerGitHubOperation" AS "operation"
SET "accountId" = "connection"."accountId",
    "accountLogin" = "connection"."accountLogin",
    "accountType" = "connection"."accountType",
    "installationId" = "connection"."installationId",
    "repositoryId" = "connection"."repositoryId",
    "repositoryName" = "connection"."repositoryName",
    "repositoryNodeId" = "connection"."repositoryNodeId",
    "repositoryOwner" = "connection"."repositoryOwner"
FROM "RunnerGitHubConnection" AS "connection"
WHERE "connection"."id" = "operation"."connectionId"
  AND "connection"."tenant" = "operation"."tenant";--> statement-breakpoint
DO $$
BEGIN
  IF EXISTS (
    SELECT 1
    FROM "RunnerGitHubOperation"
    WHERE "accountId" IS NULL
      OR "accountLogin" IS NULL
      OR "accountType" IS NULL
      OR "installationId" IS NULL
      OR "repositoryId" IS NULL
      OR "repositoryName" IS NULL
      OR "repositoryNodeId" IS NULL
      OR "repositoryOwner" IS NULL
  ) THEN
    RAISE EXCEPTION '0029 cannot snapshot a GitHub operation without its live connection';
  END IF;
END $$;--> statement-breakpoint
ALTER TABLE "RunnerGitHubOperation" ALTER COLUMN "accountId" SET NOT NULL;--> statement-breakpoint
ALTER TABLE "RunnerGitHubOperation" ALTER COLUMN "accountLogin" SET NOT NULL;--> statement-breakpoint
ALTER TABLE "RunnerGitHubOperation" ALTER COLUMN "accountType" SET NOT NULL;--> statement-breakpoint
ALTER TABLE "RunnerGitHubOperation" ALTER COLUMN "installationId" SET NOT NULL;--> statement-breakpoint
ALTER TABLE "RunnerGitHubOperation" ALTER COLUMN "repositoryId" SET NOT NULL;--> statement-breakpoint
ALTER TABLE "RunnerGitHubOperation" ALTER COLUMN "repositoryName" SET NOT NULL;--> statement-breakpoint
ALTER TABLE "RunnerGitHubOperation" ALTER COLUMN "repositoryNodeId" SET NOT NULL;--> statement-breakpoint
ALTER TABLE "RunnerGitHubOperation" ALTER COLUMN "repositoryOwner" SET NOT NULL;--> statement-breakpoint
ALTER TABLE "RunnerGitHubOperation" ADD CONSTRAINT "RunnerGitHubOperation_connection_fk" FOREIGN KEY ("connectionId") REFERENCES "public"."RunnerGitHubConnection"("id") ON DELETE set null ON UPDATE no action;--> statement-breakpoint
CREATE UNIQUE INDEX "RGHOp_step_write_intent_uq" ON "RunnerGitHubOperation" USING btree ("tenant","teamStepId","kind","requestHash") WHERE "RunnerGitHubOperation"."kind" in ('issue.create','issue.comment','pull.create','pull.comment','pull.review','project.item.add','project.item.field.update');--> statement-breakpoint
ALTER TABLE "RunnerGitHubOperation" ADD CONSTRAINT "RGHOp_connectionSnapshot_valid" CHECK ("RunnerGitHubOperation"."installationId" ~ '^[1-9][0-9]{0,19}$' and "RunnerGitHubOperation"."accountId" ~ '^[1-9][0-9]{0,19}$' and "RunnerGitHubOperation"."repositoryId" ~ '^[1-9][0-9]{0,19}$' and "RunnerGitHubOperation"."accountType" in ('Organization','User') and char_length("RunnerGitHubOperation"."repositoryNodeId") between 1 and 256 and "RunnerGitHubOperation"."repositoryNodeId" ~ '^[A-Za-z0-9_=-]+$');
--> statement-breakpoint
CREATE OR REPLACE FUNCTION "RunnerGitHubOperation_validate_live_connection"() RETURNS trigger AS $$
BEGIN
  IF NEW."connectionId" IS NOT NULL
    AND NOT EXISTS (
      SELECT 1
      FROM "RunnerGitHubConnection"
      WHERE "id" = NEW."connectionId"
        AND "tenant" = NEW."tenant"
    ) THEN
    RAISE EXCEPTION 'GitHub operation live connection tenant mismatch';
  END IF;
  RETURN NEW;
END;
$$ LANGUAGE plpgsql;--> statement-breakpoint
CREATE TRIGGER "RunnerGitHubOperation_live_connection_tenant"
  BEFORE INSERT OR UPDATE OF "connectionId", "tenant"
  ON "RunnerGitHubOperation"
  FOR EACH ROW
  EXECUTE FUNCTION "RunnerGitHubOperation_validate_live_connection"();--> statement-breakpoint
CREATE OR REPLACE FUNCTION "RunnerGitHubOperation_reject_request_change"() RETURNS trigger AS $$
BEGIN
  IF NEW."id" IS DISTINCT FROM OLD."id"
    OR NEW."tenant" IS DISTINCT FROM OLD."tenant"
    OR NEW."teamStepId" IS DISTINCT FROM OLD."teamStepId"
    OR NEW."capabilityId" IS DISTINCT FROM OLD."capabilityId"
    OR NEW."operationId" IS DISTINCT FROM OLD."operationId"
    OR NEW."kind" IS DISTINCT FROM OLD."kind"
    OR NEW."requestHash" IS DISTINCT FROM OLD."requestHash"
    OR NEW."target" IS DISTINCT FROM OLD."target"
    OR NEW."repository" IS DISTINCT FROM OLD."repository"
    OR NEW."requiredCapability" IS DISTINCT FROM OLD."requiredCapability"
    OR NEW."connectionGeneration" IS DISTINCT FROM OLD."connectionGeneration"
    OR NOT (
      NEW."connectionId" IS NOT DISTINCT FROM OLD."connectionId"
      OR (
        OLD."connectionId" IS NOT NULL
        AND NEW."connectionId" IS NULL
      )
    )
    OR NEW."operationMarker" IS DISTINCT FROM OLD."operationMarker"
    OR NEW."accountId" IS DISTINCT FROM OLD."accountId"
    OR NEW."accountLogin" IS DISTINCT FROM OLD."accountLogin"
    OR NEW."accountType" IS DISTINCT FROM OLD."accountType"
    OR NEW."installationId" IS DISTINCT FROM OLD."installationId"
    OR NEW."repositoryId" IS DISTINCT FROM OLD."repositoryId"
    OR NEW."repositoryName" IS DISTINCT FROM OLD."repositoryName"
    OR NEW."repositoryNodeId" IS DISTINCT FROM OLD."repositoryNodeId"
    OR NEW."repositoryOwner" IS DISTINCT FROM OLD."repositoryOwner"
    OR NEW."createdAt" IS DISTINCT FROM OLD."createdAt" THEN
    RAISE EXCEPTION 'GitHub operation request authority is immutable';
  END IF;
  RETURN NEW;
END;
$$ LANGUAGE plpgsql;--> statement-breakpoint
CREATE OR REPLACE FUNCTION "RunnerGitHubOperation_enforce_terminal_state"() RETURNS trigger AS $$
BEGIN
  IF OLD."status" IN ('completed', 'failed')
    AND (
      (to_jsonb(NEW) - 'connectionId') IS DISTINCT FROM
        (to_jsonb(OLD) - 'connectionId')
      OR NOT (
        NEW."connectionId" IS NOT DISTINCT FROM OLD."connectionId"
        OR (
          OLD."connectionId" IS NOT NULL
          AND NEW."connectionId" IS NULL
        )
      )
    ) THEN
    RAISE EXCEPTION 'Terminal GitHub operation is immutable';
  END IF;
  IF OLD."status" = 'running'
    AND NEW."status" NOT IN ('running', 'completed', 'failed') THEN
    RAISE EXCEPTION 'GitHub operation status transition is invalid';
  END IF;
  RETURN NEW;
END;
$$ LANGUAGE plpgsql;--> statement-breakpoint
CREATE TRIGGER "RunnerGitHubOperation_terminal_immutable"
  BEFORE UPDATE ON "RunnerGitHubOperation"
  FOR EACH ROW
  EXECUTE FUNCTION "RunnerGitHubOperation_enforce_terminal_state"();
--> statement-breakpoint
ALTER TABLE "RunnerGitHubOperation" DROP CONSTRAINT "RGHOp_timestamps_valid";--> statement-breakpoint
DROP INDEX "RGHOp_step_write_intent_uq";--> statement-breakpoint
ALTER TABLE "RunnerGitHubOperation" ADD COLUMN "providerDispatchPhase" varchar(16) DEFAULT 'not_applicable' NOT NULL;--> statement-breakpoint
ALTER TABLE "RunnerGitHubOperation" ADD COLUMN "providerSentAt" timestamp;--> statement-breakpoint
ALTER TABLE "RunnerGitHubOperation" ADD COLUMN "writeIntentActive" boolean DEFAULT false NOT NULL;--> statement-breakpoint
UPDATE "RunnerGitHubOperation"
SET "providerDispatchPhase" = 'sent',
    "providerSentAt" = COALESCE("startedAt", "createdAt"),
    "writeIntentActive" = true
WHERE "kind" NOT IN ('issue.get', 'issue.search', 'pull.get');--> statement-breakpoint
CREATE UNIQUE INDEX "RGHOp_step_write_intent_uq" ON "RunnerGitHubOperation" USING btree ("tenant","teamStepId","kind","requestHash") WHERE "RunnerGitHubOperation"."writeIntentActive" = true;--> statement-breakpoint
ALTER TABLE "RunnerGitHubOperation" ADD CONSTRAINT "RGHOp_dispatch_phase_valid" CHECK (("RunnerGitHubOperation"."kind" in ('issue.get','issue.search','pull.get') and "RunnerGitHubOperation"."providerDispatchPhase" = 'not_applicable' and "RunnerGitHubOperation"."providerSentAt" is null and "RunnerGitHubOperation"."writeIntentActive" = false) or ("RunnerGitHubOperation"."kind" not in ('issue.get','issue.search','pull.get') and (("RunnerGitHubOperation"."providerDispatchPhase" = 'pre_send' and "RunnerGitHubOperation"."providerSentAt" is null) or ("RunnerGitHubOperation"."providerDispatchPhase" = 'sent' and "RunnerGitHubOperation"."providerSentAt" is not null)) and ("RunnerGitHubOperation"."writeIntentActive" = true or ("RunnerGitHubOperation"."providerDispatchPhase" = 'pre_send' and "RunnerGitHubOperation"."status" = 'pending' and ("RunnerGitHubOperation"."error"->>'retryable')::boolean = true))));--> statement-breakpoint
ALTER TABLE "RunnerGitHubOperation" ADD CONSTRAINT "RGHOp_timestamps_valid" CHECK (("RunnerGitHubOperation"."startedAt" is null or "RunnerGitHubOperation"."startedAt" >= "RunnerGitHubOperation"."createdAt") and ("RunnerGitHubOperation"."providerSentAt" is null or ("RunnerGitHubOperation"."providerSentAt" >= "RunnerGitHubOperation"."createdAt" and ("RunnerGitHubOperation"."startedAt" is null or "RunnerGitHubOperation"."providerSentAt" >= "RunnerGitHubOperation"."startedAt"))) and ("RunnerGitHubOperation"."completedAt" is null or ("RunnerGitHubOperation"."completedAt" >= "RunnerGitHubOperation"."createdAt" and ("RunnerGitHubOperation"."startedAt" is null or "RunnerGitHubOperation"."completedAt" >= "RunnerGitHubOperation"."startedAt"))));
--> statement-breakpoint
CREATE OR REPLACE FUNCTION "RunnerGitHubOperation_enforce_dispatch_state"() RETURNS trigger AS $$
BEGIN
  IF OLD."providerDispatchPhase" = 'not_applicable'
    AND (
      NEW."providerDispatchPhase" IS DISTINCT FROM OLD."providerDispatchPhase"
      OR NEW."providerSentAt" IS DISTINCT FROM OLD."providerSentAt"
      OR NEW."writeIntentActive" IS DISTINCT FROM OLD."writeIntentActive"
    ) THEN
    RAISE EXCEPTION 'Read-only GitHub operation dispatch state is immutable';
  END IF;

  IF OLD."providerDispatchPhase" = 'sent'
    AND (
      NEW."providerDispatchPhase" IS DISTINCT FROM OLD."providerDispatchPhase"
      OR NEW."providerSentAt" IS DISTINCT FROM OLD."providerSentAt"
      OR NEW."writeIntentActive" IS DISTINCT FROM OLD."writeIntentActive"
    ) THEN
    RAISE EXCEPTION 'Sent GitHub operation dispatch state is immutable';
  END IF;

  IF OLD."providerDispatchPhase" = 'pre_send'
    AND NEW."providerDispatchPhase" = 'sent'
    AND NOT (
      OLD."status" = 'running'
      AND NEW."status" = 'running'
      AND OLD."providerSentAt" IS NULL
      AND NEW."providerSentAt" IS NOT NULL
      AND OLD."writeIntentActive" = true
      AND NEW."writeIntentActive" = true
    ) THEN
    RAISE EXCEPTION 'GitHub provider dispatch transition is invalid';
  END IF;

  IF OLD."providerDispatchPhase" = 'pre_send'
    AND NEW."providerDispatchPhase" = 'pre_send'
    AND NEW."providerSentAt" IS DISTINCT FROM OLD."providerSentAt" THEN
    RAISE EXCEPTION 'GitHub provider sent timestamp is immutable';
  END IF;

  IF OLD."providerDispatchPhase" = 'pre_send'
    AND NEW."providerDispatchPhase" NOT IN ('pre_send', 'sent') THEN
    RAISE EXCEPTION 'GitHub provider dispatch transition is invalid';
  END IF;

  IF OLD."writeIntentActive" = true
    AND NEW."writeIntentActive" = false
    AND NOT (
      OLD."providerDispatchPhase" = 'pre_send'
      AND NEW."providerDispatchPhase" = 'pre_send'
      AND OLD."status" = 'running'
      AND NEW."status" = 'pending'
      AND NEW."providerSentAt" IS NULL
      AND NEW."completedAt" IS NULL
      AND NEW."error" IS NOT NULL
      AND (NEW."error"->>'retryable')::boolean = true
    ) THEN
    RAISE EXCEPTION 'GitHub write intent release is invalid';
  END IF;

  IF OLD."writeIntentActive" = false
    AND NEW."writeIntentActive" = true
    AND NOT (
      OLD."providerDispatchPhase" = 'pre_send'
      AND NEW."providerDispatchPhase" = 'pre_send'
      AND OLD."status" = 'pending'
      AND NEW."status" = 'running'
      AND (OLD."error"->>'retryable')::boolean = true
      AND NEW."error" IS NULL
      AND NEW."providerSentAt" IS NULL
      AND NEW."completedAt" IS NULL
    ) THEN
    RAISE EXCEPTION 'GitHub write intent retry is invalid';
  END IF;

  RETURN NEW;
END;
$$ LANGUAGE plpgsql;--> statement-breakpoint
CREATE TRIGGER "RunnerGitHubOperation_dispatch_state"
  BEFORE UPDATE ON "RunnerGitHubOperation"
  FOR EACH ROW
  EXECUTE FUNCTION "RunnerGitHubOperation_enforce_dispatch_state"();--> statement-breakpoint
CREATE OR REPLACE FUNCTION "RunnerGitHubOperation_enforce_terminal_state"() RETURNS trigger AS $$
BEGIN
  IF OLD."status" IN ('completed', 'failed')
    AND (
      (to_jsonb(NEW) - 'connectionId') IS DISTINCT FROM
        (to_jsonb(OLD) - 'connectionId')
      OR NOT (
        NEW."connectionId" IS NOT DISTINCT FROM OLD."connectionId"
        OR (
          OLD."connectionId" IS NOT NULL
          AND NEW."connectionId" IS NULL
        )
      )
    ) THEN
    RAISE EXCEPTION 'Terminal GitHub operation is immutable';
  END IF;
  IF OLD."status" = 'running'
    AND NEW."status" = 'pending'
    AND NOT (
      OLD."providerDispatchPhase" = 'pre_send'
      AND NEW."providerDispatchPhase" = 'pre_send'
      AND OLD."writeIntentActive" = true
      AND NEW."writeIntentActive" = false
      AND NEW."error" IS NOT NULL
      AND (NEW."error"->>'retryable')::boolean = true
    ) THEN
    RAISE EXCEPTION 'GitHub operation pre-send retry transition is invalid';
  END IF;
  IF OLD."status" = 'running'
    AND NEW."status" NOT IN ('pending', 'running', 'completed', 'failed') THEN
    RAISE EXCEPTION 'GitHub operation status transition is invalid';
  END IF;
  RETURN NEW;
END;
$$ LANGUAGE plpgsql;
--> statement-breakpoint
DO $migration$
DECLARE
  "currentDefinition" text;
  "orderedDefinition" text;
BEGIN
  SELECT pg_get_functiondef(
    '"RunnerRun_enforce_team_execution_permission"()'::regprocedure
  )
  INTO "currentDefinition";

  "orderedDefinition" := replace(
    "currentDefinition",
    'ORDER BY lower("connection"."repositoryOwner"), lower("connection"."repositoryName")',
    'ORDER BY lower("connection"."repositoryOwner") COLLATE "C", lower("connection"."repositoryName") COLLATE "C"'
  );

  IF "orderedDefinition" = "currentDefinition" THEN
    RAISE EXCEPTION '0032 could not locate the repository ordering expression';
  END IF;

  EXECUTE "orderedDefinition";
END
$migration$;
--> statement-breakpoint
-- Existing rows predate authenticated per-repository user authority. They
-- cannot be safely backfilled from app installation visibility, so revoke
-- every live capability, advance the durable generation, and require users to
-- reconnect before any GitHub operation can execute.
UPDATE "RunnerGitHubCapability"
SET "revokedAt" = COALESCE("revokedAt", clock_timestamp()),
    "updatedAt" = clock_timestamp(),
    "version" = "version" + 1
WHERE "revokedAt" IS NULL;--> statement-breakpoint
UPDATE "RunnerGitHubConnectionFence"
SET "generation" = "generation" + 1,
    "updatedAt" = clock_timestamp();--> statement-breakpoint
DELETE FROM "RunnerGitHubConnection";--> statement-breakpoint
ALTER TABLE "RunnerGitHubConnection" DROP CONSTRAINT "RGHConn_decimal_ids";--> statement-breakpoint
ALTER TABLE "RunnerGitHubConnection" ADD COLUMN "appIssuesPermission" varchar(8) NOT NULL;--> statement-breakpoint
ALTER TABLE "RunnerGitHubConnection" ADD COLUMN "appOrganizationProjectsPermission" varchar(8) NOT NULL;--> statement-breakpoint
ALTER TABLE "RunnerGitHubConnection" ADD COLUMN "appPullRequestsPermission" varchar(8) NOT NULL;--> statement-breakpoint
ALTER TABLE "RunnerGitHubConnection" ADD COLUMN "githubUserId" varchar(20) NOT NULL;--> statement-breakpoint
ALTER TABLE "RunnerGitHubConnection" ADD COLUMN "githubUserLogin" varchar(100) NOT NULL;--> statement-breakpoint
ALTER TABLE "RunnerGitHubConnection" ADD COLUMN "userPermissionCeiling" varchar(16) NOT NULL;--> statement-breakpoint
ALTER TABLE "RunnerGitHubConnection" ADD COLUMN "userPermissionCurrent" varchar(16) NOT NULL;--> statement-breakpoint
ALTER TABLE "RunnerGitHubConnection" ADD COLUMN "userProjectManagementCeiling" boolean NOT NULL;--> statement-breakpoint
ALTER TABLE "RunnerGitHubConnection" ADD COLUMN "userProjectManagementCurrent" boolean NOT NULL;--> statement-breakpoint
ALTER TABLE "RunnerGitHubConnection" ADD CONSTRAINT "RGHConn_authority_valid" CHECK ("RunnerGitHubConnection"."appIssuesPermission" in ('none','read','write') and "RunnerGitHubConnection"."appPullRequestsPermission" in ('none','read','write') and "RunnerGitHubConnection"."appOrganizationProjectsPermission" in ('none','read','write') and "RunnerGitHubConnection"."userPermissionCeiling" in ('read','triage','write','maintain','admin') and "RunnerGitHubConnection"."userPermissionCurrent" in ('read','triage','write','maintain','admin') and CASE "RunnerGitHubConnection"."userPermissionCurrent" WHEN 'read' THEN 1 WHEN 'triage' THEN 2 WHEN 'write' THEN 3 WHEN 'maintain' THEN 4 WHEN 'admin' THEN 5 ELSE 0 END <= CASE "RunnerGitHubConnection"."userPermissionCeiling" WHEN 'read' THEN 1 WHEN 'triage' THEN 2 WHEN 'write' THEN 3 WHEN 'maintain' THEN 4 WHEN 'admin' THEN 5 ELSE 0 END and (not "RunnerGitHubConnection"."userProjectManagementCurrent" or "RunnerGitHubConnection"."userProjectManagementCeiling") and char_length("RunnerGitHubConnection"."githubUserLogin") between 1 and 100 and "RunnerGitHubConnection"."githubUserLogin" ~ '^[A-Za-z0-9_.-]+$');--> statement-breakpoint
ALTER TABLE "RunnerGitHubConnection" ADD CONSTRAINT "RGHConn_decimal_ids" CHECK ("RunnerGitHubConnection"."installationId" ~ '^(0|[1-9][0-9]{0,19})$' and "RunnerGitHubConnection"."accountId" ~ '^(0|[1-9][0-9]{0,19})$' and "RunnerGitHubConnection"."repositoryId" ~ '^(0|[1-9][0-9]{0,19})$' and "RunnerGitHubConnection"."githubUserId" ~ '^[1-9][0-9]{0,19}$');--> statement-breakpoint
CREATE OR REPLACE FUNCTION "RunnerRun_enforce_team_execution_permission"() RETURNS trigger AS $$
DECLARE
  "agentTrust" varchar(16);
  "declaredGitHub" jsonb;
  "expectedAllowed" jsonb;
  "expectedApproved" jsonb;
  "expectedRepositories" jsonb;
  "stepAuthVersion" integer;
  "stepId" uuid;
  "stepRunId" uuid;
  "teamPermission" varchar(32);
BEGIN
  SELECT
    "step"."id",
    "step"."teamRunId",
    "teamRun"."authVersion",
    CASE
      WHEN EXISTS (
        SELECT 1
        FROM jsonb_array_elements("step"."skillSnapshots") AS "skill"("snapshot")
        WHERE ("skill"."snapshot"->'requiredCapabilities') ? 'workspace.write'
      ) THEN 'workspace_write'
      WHEN EXISTS (
        SELECT 1
        FROM jsonb_array_elements("step"."skillSnapshots") AS "skill"("snapshot")
        WHERE ("skill"."snapshot"->'requiredCapabilities') ? 'workspace.read'
      ) THEN 'workspace_read'
      WHEN EXISTS (
        SELECT 1
        FROM jsonb_array_elements("step"."skillSnapshots") AS "skill"("snapshot"),
          jsonb_array_elements_text("skill"."snapshot"->'requiredCapabilities') AS "capability"("value")
        WHERE "capability"."value" LIKE 'github.%'
      ) THEN 'github_only'
      ELSE NULL
    END,
    COALESCE((
      SELECT jsonb_agg("capability" ORDER BY "capability")
      FROM (
        SELECT DISTINCT "capability"."value" AS "capability"
        FROM jsonb_array_elements("step"."skillSnapshots") AS "skill"("snapshot"),
          jsonb_array_elements_text("skill"."snapshot"->'requiredCapabilities') AS "capability"("value")
        WHERE "capability"."value" LIKE 'github.%'
      ) AS "declared"
    ), '[]'::jsonb)
  INTO
    "stepId",
    "stepRunId",
    "stepAuthVersion",
    "teamPermission",
    "declaredGitHub"
  FROM "RunnerTeamStep" AS "step"
  JOIN "RunnerTeamRun" AS "teamRun"
    ON "teamRun"."id" = "step"."teamRunId"
    AND "teamRun"."tenant" = "step"."tenant"
  WHERE "step"."plannedRunnerRunId" = NEW."id"
    AND "step"."plannedOperationId" = NEW."operationId"
    AND "step"."tenant" = NEW."tenant"
  LIMIT 1;

  IF FOUND THEN
    IF NEW."teamStepId" IS NULL OR NEW."teamStepId" <> "stepId" THEN
      RAISE EXCEPTION 'Team child insert requires its exact team step';
    END IF;
    IF NEW."agentRuntime" <> 'copilot' THEN
      RAISE EXCEPTION 'Team child runtime cannot enforce workspace permissions';
    END IF;
    IF "teamPermission" IN ('workspace_read', 'workspace_write')
      AND (NEW."agentWorkspace" IS NULL OR btrim(NEW."agentWorkspace") = '') THEN
      RAISE EXCEPTION 'Team child requires an explicit workspace';
    END IF;
    IF "teamPermission" IS NULL THEN
      RAISE EXCEPTION 'Team child requires declared execution permission';
    END IF;
    IF NEW."executionPermission" IS NULL
      OR NEW."executionPermission" = 'unrestricted' THEN
      RAISE EXCEPTION 'Team child insert requires explicit execution permission';
    END IF;
    IF NEW."executionPermission" <> "teamPermission" THEN
      RAISE EXCEPTION 'Team child execution permission conflicts with its immutable snapshot';
    END IF;

    IF jsonb_array_length("declaredGitHub") = 0 THEN
      IF NEW."githubBrokerPolicy" IS NOT NULL THEN
        RAISE EXCEPTION 'Non-GitHub team child cannot persist broker authority';
      END IF;
    ELSE
      SELECT COALESCE(jsonb_agg("capability" ORDER BY "capability"), '[]'::jsonb)
      INTO "expectedApproved"
      FROM (
        SELECT DISTINCT "approved"."value" AS "capability"
        FROM jsonb_array_elements_text(
          COALESCE((
            SELECT "approvedCapabilities"
            FROM "RunnerTeamStep"
            WHERE "id" = "stepId"
              AND "tenant" = NEW."tenant"
          ), '[]'::jsonb)
        ) AS "approved"("value")
        WHERE "approved"."value" LIKE 'github.%.write'
          AND "declaredGitHub" ? "approved"."value"
      ) AS "approvedSet";

      SELECT COALESCE(jsonb_agg("capability" ORDER BY "capability"), '[]'::jsonb)
      INTO "expectedAllowed"
      FROM (
        SELECT "declared"."value" AS "capability"
        FROM jsonb_array_elements_text("declaredGitHub") AS "declared"("value")
        WHERE (
          "declared"."value" LIKE '%.read'
          OR "expectedApproved" ? "declared"."value"
        )
        AND EXISTS (
          SELECT 1
          FROM "RunnerGitHubConnection" AS "authority"
          WHERE "authority"."tenant" = NEW."tenant"
            AND (
              (
                "declared"."value" LIKE 'github.issues.%'
                AND (
                  ("declared"."value" LIKE '%.read'
                    AND "authority"."appIssuesPermission" IN ('read', 'write'))
                  OR ("declared"."value" LIKE '%.write'
                    AND "authority"."appIssuesPermission" = 'write')
                )
                AND (
                  "declared"."value" LIKE '%.read'
                  OR (
                    "authority"."userPermissionCeiling" IN ('write', 'maintain', 'admin')
                    AND "authority"."userPermissionCurrent" IN ('write', 'maintain', 'admin')
                  )
                )
              )
              OR (
                "declared"."value" LIKE 'github.pull_requests.%'
                AND (
                  ("declared"."value" LIKE '%.read'
                    AND "authority"."appPullRequestsPermission" IN ('read', 'write'))
                  OR ("declared"."value" LIKE '%.write'
                    AND "authority"."appPullRequestsPermission" = 'write')
                )
                AND (
                  "declared"."value" LIKE '%.read'
                  OR (
                    "authority"."userPermissionCeiling" IN ('write', 'maintain', 'admin')
                    AND "authority"."userPermissionCurrent" IN ('write', 'maintain', 'admin')
                  )
                )
              )
              OR (
                "declared"."value" LIKE 'github.projects.%'
                AND "authority"."accountType" = 'Organization'
                AND "authority"."userProjectManagementCeiling" = true
                AND "authority"."userProjectManagementCurrent" = true
                AND (
                  ("declared"."value" LIKE '%.read'
                    AND "authority"."appOrganizationProjectsPermission" IN ('read', 'write'))
                  OR ("declared"."value" LIKE '%.write'
                    AND "authority"."appOrganizationProjectsPermission" = 'write')
                )
              )
            )
        )
      ) AS "allowedSet";

      SELECT COALESCE(jsonb_agg(
        jsonb_build_object(
          'accountId', "connection"."accountId",
          'accountLogin', "connection"."accountLogin",
          'accountType', "connection"."accountType",
          'appIssuesPermission', "connection"."appIssuesPermission",
          'appOrganizationProjectsPermission', "connection"."appOrganizationProjectsPermission",
          'appPullRequestsPermission', "connection"."appPullRequestsPermission",
          'connectionId', "connection"."id",
          'githubUserId', "connection"."githubUserId",
          'githubUserLogin', "connection"."githubUserLogin",
          'installationId', "connection"."installationId",
          'repository', lower("connection"."repositoryOwner") || '/' || lower("connection"."repositoryName"),
          'repositoryId', "connection"."repositoryId",
          'repositoryName', "connection"."repositoryName",
          'repositoryNodeId', "connection"."repositoryNodeId",
          'repositoryOwner', "connection"."repositoryOwner",
          'userPermissionCeiling', "connection"."userPermissionCeiling",
          'userPermissionCurrent', "connection"."userPermissionCurrent",
          'userProjectManagementCeiling', "connection"."userProjectManagementCeiling",
          'userProjectManagementCurrent', "connection"."userProjectManagementCurrent"
        )
        ORDER BY (
          lower("connection"."repositoryOwner") || '/' ||
          lower("connection"."repositoryName")
        ) COLLATE "C"
      ), '[]'::jsonb)
      INTO "expectedRepositories"
      FROM "RunnerGitHubConnection" AS "connection"
      WHERE "connection"."tenant" = NEW."tenant";

      IF NEW."githubBrokerPolicy" IS NULL
        OR (NEW."githubBrokerPolicy" - ARRAY[
          'actorUserId',
          'allowedCapabilities',
          'approvedCapabilities',
          'authVersion',
          'connectionGeneration',
          'declaredCapabilities',
          'maxCallCount',
          'repositories',
          'teamRunId',
          'teamStepId',
          'version'
        ]) <> '{}'::jsonb
        OR NEW."githubBrokerPolicy"->>'version' <> '1'
        OR NEW."githubBrokerPolicy"->>'teamStepId' <> "stepId"::text
        OR NEW."githubBrokerPolicy"->>'teamRunId' <> "stepRunId"::text
        OR NEW."githubBrokerPolicy"->>'actorUserId' <> COALESCE((
          SELECT "createdByUserId"::text
          FROM "RunnerTeamRun"
          WHERE "id" = "stepRunId"
            AND "tenant" = NEW."tenant"
        ), '')
        OR NEW."githubBrokerPolicy"->>'authVersion' <> "stepAuthVersion"::text
        OR NEW."githubBrokerPolicy"->'declaredCapabilities' <> "declaredGitHub"
        OR NEW."githubBrokerPolicy"->'approvedCapabilities' <> "expectedApproved"
        OR NEW."githubBrokerPolicy"->'allowedCapabilities' <> "expectedAllowed"
        OR NEW."githubBrokerPolicy"->'repositories' <> "expectedRepositories"
        OR NEW."githubBrokerPolicy"->>'maxCallCount' <> '32'
        OR NEW."githubBrokerPolicy"->>'connectionGeneration' <> COALESCE((
          SELECT "generation"::text
          FROM "RunnerGitHubConnectionFence"
          WHERE "tenant" = NEW."tenant"
        ), '-1') THEN
        RAISE EXCEPTION 'Team child GitHub broker policy conflicts with durable authority';
      END IF;
    END IF;
  ELSE
    IF NEW."teamStepId" IS NOT NULL OR NEW."githubBrokerPolicy" IS NOT NULL THEN
      RAISE EXCEPTION 'Ordinary runner run cannot persist team broker authority';
    END IF;
  END IF;

  IF NEW."executionPermission" <> 'unrestricted' THEN
    SELECT "sandboxTrust"
    INTO "agentTrust"
    FROM "RunnerAgent"
    WHERE "id" = NEW."agentId"
      AND "tenant" = NEW."tenant"
    FOR UPDATE;

    IF "agentTrust" = 'unrestricted'
      OR EXISTS (
        SELECT 1
        FROM "RunnerRun"
        WHERE "agentId" = NEW."agentId"
          AND "tenant" = NEW."tenant"
          AND "status" IN ('queued', 'running')
          AND "cancellationRequestedAt" IS NULL
          AND "executionPermission" = 'unrestricted'
      ) THEN
      RAISE EXCEPTION 'Restricted execution requires a clean sandbox trust profile';
    END IF;
    UPDATE "RunnerAgent"
    SET "sandboxTrust" = 'restricted',
        "updatedAt" = clock_timestamp(),
        "version" = "version" + 1
    WHERE "id" = NEW."agentId"
      AND "tenant" = NEW."tenant"
      AND "sandboxTrust" <> 'unrestricted';
  END IF;
  RETURN NEW;
END;
$$ LANGUAGE plpgsql;
--> statement-breakpoint
