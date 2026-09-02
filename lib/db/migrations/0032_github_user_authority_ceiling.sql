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