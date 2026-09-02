ALTER TABLE "RunnerGitHubConnection" DROP CONSTRAINT "RGHConn_authority_valid";--> statement-breakpoint
ALTER TABLE "RunnerGitHubOperation" DROP CONSTRAINT "RGHOp_connectionSnapshot_valid";--> statement-breakpoint
ALTER TABLE "RunnerGitHubConnection" ADD COLUMN "userProjectAuthorityAuthVersion" integer;--> statement-breakpoint
ALTER TABLE "RunnerGitHubConnection" ADD COLUMN "userProjectAuthorityConnectionGeneration" bigint;--> statement-breakpoint
ALTER TABLE "RunnerGitHubConnection" ADD COLUMN "userProjectAuthorityExpiresAt" timestamp with time zone;--> statement-breakpoint
ALTER TABLE "RunnerGitHubConnection" ADD COLUMN "userProjectAuthorityIssuedAt" timestamp with time zone;--> statement-breakpoint
ALTER TABLE "RunnerGitHubConnection" ADD COLUMN "userProjectIds" jsonb DEFAULT '[]'::jsonb NOT NULL;--> statement-breakpoint
ALTER TABLE "RunnerGitHubOperation" ADD COLUMN "projectAuthorityBound" boolean DEFAULT false NOT NULL;--> statement-breakpoint
ALTER TABLE "RunnerGitHubOperation" ADD COLUMN "projectId" varchar(256);--> statement-breakpoint
CREATE FUNCTION "RGHConn_normalize_project_authority_fn"()
RETURNS trigger
LANGUAGE plpgsql
AS $$
BEGIN
  IF NOT NEW."userProjectManagementCurrent" OR NOT COALESCE((
      NEW."userProjectManagementCeiling"
      AND jsonb_typeof(NEW."userProjectIds") = 'array'
      AND jsonb_array_length(NEW."userProjectIds") > 0
      AND NEW."userProjectAuthorityAuthVersion" >= 0
      AND NEW."userProjectAuthorityConnectionGeneration" >= 0
      AND NEW."userProjectAuthorityIssuedAt" IS NOT NULL
      AND NEW."userProjectAuthorityExpiresAt" >
        NEW."userProjectAuthorityIssuedAt"
      AND NEW."userProjectAuthorityExpiresAt" <=
        NEW."userProjectAuthorityIssuedAt" + interval '15 minutes'
    ), false) THEN
    NEW."userProjectManagementCurrent" := false;
    NEW."userProjectIds" := '[]'::jsonb;
    NEW."userProjectAuthorityAuthVersion" := NULL;
    NEW."userProjectAuthorityConnectionGeneration" := NULL;
    NEW."userProjectAuthorityIssuedAt" := NULL;
    NEW."userProjectAuthorityExpiresAt" := NULL;
  END IF;
  RETURN NEW;
END;
$$;--> statement-breakpoint
CREATE TRIGGER "RGHConn_normalize_project_authority"
BEFORE INSERT OR UPDATE ON "RunnerGitHubConnection"
FOR EACH ROW
EXECUTE FUNCTION "RGHConn_normalize_project_authority_fn"();--> statement-breakpoint
CREATE FUNCTION "RGHOp_require_current_project_authority_fn"()
RETURNS trigger
LANGUAGE plpgsql
AS $$
BEGIN
  IF NEW."kind" IN ('project.item.add', 'project.item.field.update')
    AND (
      NEW."projectAuthorityBound" = false
      OR NEW."projectId" IS NULL
    )
  THEN
    RAISE EXCEPTION 'Project operation requires exact current authority'
      USING ERRCODE = '23514';
  END IF;
  RETURN NEW;
END;
$$;--> statement-breakpoint
CREATE TRIGGER "RGHOp_require_current_project_authority"
BEFORE INSERT ON "RunnerGitHubOperation"
FOR EACH ROW
EXECUTE FUNCTION "RGHOp_require_current_project_authority_fn"();--> statement-breakpoint
UPDATE "RunnerGitHubConnection"
SET "userProjectManagementCurrent" = false,
    "userProjectIds" = '[]'::jsonb,
    "userProjectAuthorityAuthVersion" = NULL,
    "userProjectAuthorityConnectionGeneration" = NULL,
    "userProjectAuthorityIssuedAt" = NULL,
    "userProjectAuthorityExpiresAt" = NULL,
    "updatedAt" = clock_timestamp(),
    "version" = "version" + 1
WHERE "userProjectManagementCurrent" = true;--> statement-breakpoint
UPDATE "RunnerGitHubConnectionFence" AS "fence"
SET "generation" = "generation" + 1,
    "updatedAt" = clock_timestamp()
WHERE EXISTS (
  SELECT 1
  FROM "RunnerGitHubConnection" AS "connection"
  WHERE "connection"."tenant" = "fence"."tenant"
);--> statement-breakpoint
UPDATE "RunnerGitHubCapability"
SET "revokedAt" = COALESCE("revokedAt", clock_timestamp()),
    "updatedAt" = clock_timestamp(),
    "version" = "version" + 1
WHERE "revokedAt" IS NULL
  AND EXISTS (
    SELECT 1
    FROM "RunnerGitHubConnection" AS "connection"
    WHERE "connection"."tenant" = "RunnerGitHubCapability"."tenant"
  );--> statement-breakpoint
ALTER TABLE "RunnerGitHubConnection" ADD CONSTRAINT "RGHConn_authority_valid" CHECK ("RunnerGitHubConnection"."appContentsPermission" in ('none','read','write') and "RunnerGitHubConnection"."appIssuesPermission" in ('none','read','write') and "RunnerGitHubConnection"."appPullRequestsPermission" in ('none','read','write') and "RunnerGitHubConnection"."appOrganizationProjectsPermission" in ('none','read','write') and "RunnerGitHubConnection"."userPermissionCeiling" in ('read','triage','write','maintain','admin') and "RunnerGitHubConnection"."userPermissionCurrent" in ('read','triage','write','maintain','admin') and CASE "RunnerGitHubConnection"."userPermissionCurrent" WHEN 'read' THEN 1 WHEN 'triage' THEN 2 WHEN 'write' THEN 3 WHEN 'maintain' THEN 4 WHEN 'admin' THEN 5 ELSE 0 END <= CASE "RunnerGitHubConnection"."userPermissionCeiling" WHEN 'read' THEN 1 WHEN 'triage' THEN 2 WHEN 'write' THEN 3 WHEN 'maintain' THEN 4 WHEN 'admin' THEN 5 ELSE 0 END and jsonb_typeof("RunnerGitHubConnection"."userProjectIds") = 'array' and jsonb_array_length("RunnerGitHubConnection"."userProjectIds") <= 100 and not jsonb_path_exists("RunnerGitHubConnection"."userProjectIds", 'strict $[*] ? (@.type() != "string" || !(@ like_regex "^[A-Za-z0-9_=-]{1,255}[A-Za-z0-9_=-]?$"))', '{}'::jsonb, true) and (coalesce(("RunnerGitHubConnection"."userProjectManagementCurrent" and "RunnerGitHubConnection"."userProjectManagementCeiling" and jsonb_array_length("RunnerGitHubConnection"."userProjectIds") > 0 and "RunnerGitHubConnection"."userProjectAuthorityAuthVersion" >= 0 and "RunnerGitHubConnection"."userProjectAuthorityConnectionGeneration" >= 0 and "RunnerGitHubConnection"."userProjectAuthorityIssuedAt" is not null and "RunnerGitHubConnection"."userProjectAuthorityExpiresAt" > "RunnerGitHubConnection"."userProjectAuthorityIssuedAt" and "RunnerGitHubConnection"."userProjectAuthorityExpiresAt" <= "RunnerGitHubConnection"."userProjectAuthorityIssuedAt" + interval '15 minutes'), false) or (not "RunnerGitHubConnection"."userProjectManagementCurrent" and jsonb_array_length("RunnerGitHubConnection"."userProjectIds") = 0 and "RunnerGitHubConnection"."userProjectAuthorityAuthVersion" is null and "RunnerGitHubConnection"."userProjectAuthorityConnectionGeneration" is null and "RunnerGitHubConnection"."userProjectAuthorityIssuedAt" is null and "RunnerGitHubConnection"."userProjectAuthorityExpiresAt" is null)) and char_length("RunnerGitHubConnection"."githubUserLogin") between 1 and 100 and "RunnerGitHubConnection"."githubUserLogin" ~ '^[A-Za-z0-9_.-]+$');--> statement-breakpoint
ALTER TABLE "RunnerGitHubOperation" ADD CONSTRAINT "RGHOp_connectionSnapshot_valid" CHECK ("RunnerGitHubOperation"."installationId" ~ '^[1-9][0-9]{0,19}$' and "RunnerGitHubOperation"."accountId" ~ '^[1-9][0-9]{0,19}$' and "RunnerGitHubOperation"."repositoryId" ~ '^[1-9][0-9]{0,19}$' and "RunnerGitHubOperation"."accountType" in ('Organization','User') and char_length("RunnerGitHubOperation"."repositoryNodeId") between 1 and 256 and "RunnerGitHubOperation"."repositoryNodeId" ~ '^[A-Za-z0-9_=-]+$' and (("RunnerGitHubOperation"."kind" in ('project.item.add','project.item.field.update') and (("RunnerGitHubOperation"."projectAuthorityBound" and "RunnerGitHubOperation"."projectId" is not null and char_length("RunnerGitHubOperation"."projectId") between 1 and 256 and "RunnerGitHubOperation"."projectId" ~ '^[A-Za-z0-9_=-]+$') or (not "RunnerGitHubOperation"."projectAuthorityBound" and "RunnerGitHubOperation"."projectId" is null))) or ("RunnerGitHubOperation"."kind" not in ('project.item.add','project.item.field.update') and not "RunnerGitHubOperation"."projectAuthorityBound" and "RunnerGitHubOperation"."projectId" is null)));