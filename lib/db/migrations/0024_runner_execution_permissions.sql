ALTER TABLE "RunnerAgent" ADD COLUMN "sandboxTrust" varchar(16);--> statement-breakpoint
ALTER TABLE "RunnerRun" ADD COLUMN "executionPermission" varchar(32);--> statement-breakpoint
CREATE FUNCTION "RunnerRun_enforce_team_execution_permission"() RETURNS trigger AS $$
DECLARE
  "agentTrust" varchar(16);
  "teamPermission" varchar(32);
BEGIN
  SELECT CASE
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
    ELSE NULL
  END
  INTO "teamPermission"
  FROM "RunnerTeamStep" AS "step"
  WHERE "step"."plannedRunnerRunId" = NEW."id"
    AND "step"."plannedOperationId" = NEW."operationId"
    AND "step"."tenant" = NEW."tenant"
  LIMIT 1;

  IF FOUND THEN
    IF NEW."agentRuntime" <> 'copilot' THEN
      RAISE EXCEPTION 'Team child runtime cannot enforce workspace permissions';
    END IF;
    IF NEW."agentWorkspace" IS NULL OR btrim(NEW."agentWorkspace") = '' THEN
      RAISE EXCEPTION 'Team child requires an explicit workspace';
    END IF;
    IF "teamPermission" IS NULL THEN
      RAISE EXCEPTION 'Team child requires declared workspace permission';
    END IF;
    IF NEW."executionPermission" IS NULL
      OR NEW."executionPermission" = 'unrestricted' THEN
      RAISE EXCEPTION 'Team child insert requires explicit execution permission';
    END IF;
    IF NEW."executionPermission" <> "teamPermission" THEN
      RAISE EXCEPTION 'Team child execution permission conflicts with its immutable snapshot';
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
CREATE FUNCTION "RunnerRun_mark_launched_sandbox_trust"() RETURNS trigger AS $$
BEGIN
  IF OLD."daytonaSessionId" IS NULL
    AND NEW."daytonaSessionId" IS NOT NULL
    AND NEW."executionPermission" = 'unrestricted' THEN
    UPDATE "RunnerAgent"
    SET "sandboxTrust" = 'unrestricted',
        "updatedAt" = clock_timestamp(),
        "version" = "version" + 1
    WHERE "id" = NEW."agentId"
      AND "tenant" = NEW."tenant"
      AND "sandboxTrust" <> 'unrestricted';
  END IF;
  RETURN NEW;
END;
$$ LANGUAGE plpgsql;--> statement-breakpoint
CREATE TRIGGER "RunnerRun_launched_sandbox_trust"
  AFTER UPDATE ON "RunnerRun"
  FOR EACH ROW
  EXECUTE FUNCTION "RunnerRun_mark_launched_sandbox_trust"();--> statement-breakpoint
DO $$
BEGIN
  IF EXISTS (
    SELECT 1
    FROM "RunnerRun" AS "run"
    JOIN "RunnerTeamStep" AS "step"
      ON COALESCE("step"."runnerRunId", "step"."plannedRunnerRunId") = "run"."id"
      AND "step"."tenant" = "run"."tenant"
    WHERE "run"."status" IN ('queued', 'running')
    OR "run"."dispatchState" <> 'terminal'
    OR "run"."daytonaAttemptId" IS NOT NULL
    OR "run"."daytonaSessionId" IS NOT NULL
    OR "run"."daytonaCommandId" IS NOT NULL
    OR "run"."dispatchLeaseToken" IS NOT NULL
  ) THEN
    RAISE EXCEPTION '0024 cannot safely migrate live team children';
  END IF;
END $$;--> statement-breakpoint
UPDATE "RunnerRun" AS "run"
SET "executionPermission" = 'unrestricted'
FROM "RunnerTeamStep" AS "step"
WHERE COALESCE("step"."runnerRunId", "step"."plannedRunnerRunId") = "run"."id"
  AND "step"."tenant" = "run"."tenant";--> statement-breakpoint
UPDATE "RunnerRun" SET "executionPermission" = 'unrestricted' WHERE "executionPermission" IS NULL;--> statement-breakpoint
UPDATE "RunnerAgent" AS "agent"
SET "sandboxTrust" = CASE
  WHEN "agent"."daytonaSandboxId" IS NOT NULL
    OR "agent"."sandboxLifecycle" <> 'unprovisioned'
  THEN 'unrestricted'
  ELSE 'clean'
END;--> statement-breakpoint
ALTER TABLE "RunnerAgent" ALTER COLUMN "sandboxTrust" SET DEFAULT 'clean';--> statement-breakpoint
ALTER TABLE "RunnerAgent" ALTER COLUMN "sandboxTrust" SET NOT NULL;--> statement-breakpoint
ALTER TABLE "RunnerRun" ALTER COLUMN "executionPermission" SET DEFAULT 'unrestricted';--> statement-breakpoint
ALTER TABLE "RunnerRun" ALTER COLUMN "executionPermission" SET NOT NULL;--> statement-breakpoint
ALTER TABLE "RunnerAgent" ADD CONSTRAINT "RunnerAgent_sandboxTrust_valid" CHECK ("RunnerAgent"."sandboxTrust" in ('clean', 'restricted', 'unrestricted'));--> statement-breakpoint
ALTER TABLE "RunnerRun" ADD CONSTRAINT "RunnerRun_executionPermission_valid" CHECK ("RunnerRun"."executionPermission" in ('unrestricted', 'workspace_read', 'workspace_write'));
