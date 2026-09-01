DO $$
BEGIN
  IF EXISTS (SELECT 1 FROM "RunnerGitHubCapability")
    OR EXISTS (SELECT 1 FROM "RunnerGitHubOperation") THEN
    RAISE EXCEPTION '0026 cannot migrate pre-gateway GitHub authority';
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