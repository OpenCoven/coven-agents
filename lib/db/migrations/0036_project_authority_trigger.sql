DO $migration$
DECLARE
  "currentDefinition" text;
  "projectDefinition" text;
  "repositoryDefinition" text;
  "keyDefinition" text;
  "tenantDefinition" text;
BEGIN
  SELECT pg_get_functiondef(
    '"RunnerRun_enforce_team_execution_permission"()'::regprocedure
  )
  INTO "currentDefinition";

  "projectDefinition" := replace(
    "currentDefinition",
    $needle$              OR (
                "declared"."value" LIKE 'github.projects.%'
                AND "authority"."accountType" = 'Organization'
                AND "authority"."userProjectManagementCeiling" = true
                AND "authority"."userProjectManagementCurrent" = true
                AND ($needle$,
    $replacement$              OR (
                "declared"."value" LIKE 'github.projects.%'
                AND "authority"."accountType" = 'Organization'
                AND "authority"."userProjectManagementCeiling" = true
                AND "authority"."userProjectManagementCurrent" = true
                AND "authority"."userProjectAuthorityAuthVersion" = "stepAuthVersion"
                AND "authority"."userProjectAuthorityConnectionGeneration" = COALESCE((
                  SELECT "generation"
                  FROM "RunnerGitHubConnectionFence"
                  WHERE "tenant" = NEW."tenant"
                ), -1)
                AND "authority"."userProjectAuthorityIssuedAt" <= clock_timestamp()
                AND "authority"."userProjectAuthorityExpiresAt" > clock_timestamp()
                AND jsonb_array_length("authority"."userProjectIds") > 0
                AND ($replacement$
  );

  IF "projectDefinition" = "currentDefinition" THEN
    RAISE EXCEPTION '0036 could not locate the current Project authority branch';
  END IF;

  "repositoryDefinition" := replace(
    "projectDefinition",
    $needle$          'accountType', "connection"."accountType",
          'appContentsPermission', "connection"."appContentsPermission",
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
          'userProjectManagementCurrent', "connection"."userProjectManagementCurrent"$needle$,
    $replacement$          'accountType', "connection"."accountType",
          'appContentsPermission', "connection"."appContentsPermission",
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
          'tenant', "connection"."tenant",
          'userPermissionCeiling', "connection"."userPermissionCeiling",
          'userPermissionCurrent', "connection"."userPermissionCurrent",
          'userProjectAuthorityAuthVersion', "connection"."userProjectAuthorityAuthVersion",
          'userProjectAuthorityConnectionGeneration', "connection"."userProjectAuthorityConnectionGeneration",
          'userProjectAuthorityExpiresAt', CASE
            WHEN "connection"."userProjectAuthorityExpiresAt" IS NULL THEN NULL
            ELSE to_char(
              "connection"."userProjectAuthorityExpiresAt" AT TIME ZONE 'UTC',
              'YYYY-MM-DD"T"HH24:MI:SS.MS"Z"'
            )
          END,
          'userProjectAuthorityIssuedAt', CASE
            WHEN "connection"."userProjectAuthorityIssuedAt" IS NULL THEN NULL
            ELSE to_char(
              "connection"."userProjectAuthorityIssuedAt" AT TIME ZONE 'UTC',
              'YYYY-MM-DD"T"HH24:MI:SS.MS"Z"'
            )
          END,
          'userProjectIds', "connection"."userProjectIds",
          'userProjectManagementCeiling', "connection"."userProjectManagementCeiling",
          'userProjectManagementCurrent', "connection"."userProjectManagementCurrent"$replacement$
  );

  IF "repositoryDefinition" = "projectDefinition" THEN
    RAISE EXCEPTION '0036 could not locate the broker repository projection';
  END IF;

  "keyDefinition" := replace(
    "repositoryDefinition",
    $needle$          'teamRunId',
          'teamStepId',
          'version'$needle$,
    $replacement$          'teamRunId',
          'teamStepId',
          'tenant',
          'version'$replacement$
  );

  IF "keyDefinition" = "repositoryDefinition" THEN
    RAISE EXCEPTION '0036 could not locate the broker policy key allowlist';
  END IF;

  "tenantDefinition" := replace(
    "keyDefinition",
    $needle$        OR NEW."githubBrokerPolicy"->>'authVersion' <> "stepAuthVersion"::text
        OR NEW."githubBrokerPolicy"->'declaredCapabilities' <> "declaredGitHub"$needle$,
    $replacement$        OR NEW."githubBrokerPolicy"->>'authVersion' <> "stepAuthVersion"::text
        OR NEW."githubBrokerPolicy"->>'tenant' IS DISTINCT FROM NEW."tenant"
        OR NEW."githubBrokerPolicy"->'declaredCapabilities' <> "declaredGitHub"$replacement$
  );

  IF "tenantDefinition" = "keyDefinition" THEN
    RAISE EXCEPTION '0036 could not locate the broker policy tenant check';
  END IF;

  EXECUTE "tenantDefinition";
END
$migration$;