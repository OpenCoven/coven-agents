ALTER TABLE "RunnerGitHubCapability" DROP CONSTRAINT "RGHCap_caps_valid";--> statement-breakpoint
ALTER TABLE "RunnerGitHubConnection" DROP CONSTRAINT "RGHConn_authority_valid";--> statement-breakpoint
ALTER TABLE "RunnerGitHubOperation" DROP CONSTRAINT "RGHOp_binding_valid";--> statement-breakpoint
ALTER TABLE "RunnerGitHubOperation" DROP CONSTRAINT "RGHOp_capability_mapping_valid";--> statement-breakpoint
ALTER TABLE "RunnerGitHubOperation" DROP CONSTRAINT "RGHOp_kind_valid";--> statement-breakpoint
ALTER TABLE "RunnerSkill" DROP CONSTRAINT "RSkill_caps_valid";--> statement-breakpoint
ALTER TABLE "RunnerTeamStep" DROP CONSTRAINT "RTStep_approvedCapabilities_valid";--> statement-breakpoint
ALTER TABLE "RunnerGitHubConnection" ADD COLUMN "appContentsPermission" varchar(8) DEFAULT 'none' NOT NULL;--> statement-breakpoint
ALTER TABLE "RunnerGitHubConnection" ALTER COLUMN "appContentsPermission" DROP DEFAULT;--> statement-breakpoint
ALTER TABLE "RunnerGitHubCapability" ADD CONSTRAINT "RGHCap_caps_valid" CHECK (jsonb_typeof("RunnerGitHubCapability"."declaredCapabilities") = 'array' and jsonb_array_length("RunnerGitHubCapability"."declaredCapabilities") between 1 and 8 and "RunnerGitHubCapability"."declaredCapabilities" <@ '["github.contents.write","github.issues.read","github.issues.write","github.pull_requests.read","github.pull_requests.write","github.projects.read","github.projects.write"]'::jsonb and jsonb_typeof("RunnerGitHubCapability"."approvedCapabilities") = 'array' and jsonb_array_length("RunnerGitHubCapability"."approvedCapabilities") <= 8 and "RunnerGitHubCapability"."approvedCapabilities" <@ "RunnerGitHubCapability"."declaredCapabilities" and jsonb_typeof("RunnerGitHubCapability"."allowedCapabilities") = 'array' and jsonb_array_length("RunnerGitHubCapability"."allowedCapabilities") between 1 and 8 and "RunnerGitHubCapability"."allowedCapabilities" <@ "RunnerGitHubCapability"."declaredCapabilities" and "RunnerGitHubCapability"."allowedCapabilities" <@ (jsonb_path_query_array("RunnerGitHubCapability"."declaredCapabilities", '$[*] ? (@ like_regex "read$")') || "RunnerGitHubCapability"."approvedCapabilities"));--> statement-breakpoint
ALTER TABLE "RunnerGitHubConnection" ADD CONSTRAINT "RGHConn_authority_valid" CHECK ("RunnerGitHubConnection"."appContentsPermission" in ('none','read','write') and "RunnerGitHubConnection"."appIssuesPermission" in ('none','read','write') and "RunnerGitHubConnection"."appPullRequestsPermission" in ('none','read','write') and "RunnerGitHubConnection"."appOrganizationProjectsPermission" in ('none','read','write') and "RunnerGitHubConnection"."userPermissionCeiling" in ('read','triage','write','maintain','admin') and "RunnerGitHubConnection"."userPermissionCurrent" in ('read','triage','write','maintain','admin') and CASE "RunnerGitHubConnection"."userPermissionCurrent" WHEN 'read' THEN 1 WHEN 'triage' THEN 2 WHEN 'write' THEN 3 WHEN 'maintain' THEN 4 WHEN 'admin' THEN 5 ELSE 0 END <= CASE "RunnerGitHubConnection"."userPermissionCeiling" WHEN 'read' THEN 1 WHEN 'triage' THEN 2 WHEN 'write' THEN 3 WHEN 'maintain' THEN 4 WHEN 'admin' THEN 5 ELSE 0 END and (not "RunnerGitHubConnection"."userProjectManagementCurrent" or "RunnerGitHubConnection"."userProjectManagementCeiling") and char_length("RunnerGitHubConnection"."githubUserLogin") between 1 and 100 and "RunnerGitHubConnection"."githubUserLogin" ~ '^[A-Za-z0-9_.-]+$');--> statement-breakpoint
ALTER TABLE "RunnerGitHubOperation" ADD CONSTRAINT "RGHOp_binding_valid" CHECK ("RunnerGitHubOperation"."connectionGeneration" >= 0 and "RunnerGitHubOperation"."repository" ~ '^[a-z0-9_.-]{1,100}/[a-z0-9_.-]{1,100}$' and "RunnerGitHubOperation"."requiredCapability" in ('github.contents.write','github.issues.read','github.issues.write','github.pull_requests.read','github.pull_requests.write','github.projects.read','github.projects.write'));--> statement-breakpoint
ALTER TABLE "RunnerGitHubOperation" ADD CONSTRAINT "RGHOp_capability_mapping_valid" CHECK ("RunnerGitHubOperation"."requiredCapability" = CASE WHEN "RunnerGitHubOperation"."kind" = 'repository.commit' THEN 'github.contents.write' WHEN "RunnerGitHubOperation"."kind" in ('issue.get','issue.search') THEN 'github.issues.read' WHEN "RunnerGitHubOperation"."kind" in ('issue.create','issue.comment') THEN 'github.issues.write' WHEN "RunnerGitHubOperation"."kind" = 'pull.get' THEN 'github.pull_requests.read' WHEN "RunnerGitHubOperation"."kind" in ('pull.create','pull.comment','pull.review') THEN 'github.pull_requests.write' WHEN "RunnerGitHubOperation"."kind" in ('project.item.add','project.item.field.update') THEN 'github.projects.write' ELSE '' END);--> statement-breakpoint
ALTER TABLE "RunnerGitHubOperation" ADD CONSTRAINT "RGHOp_kind_valid" CHECK ("RunnerGitHubOperation"."kind" in ('repository.commit', 'issue.get', 'issue.search', 'issue.create', 'issue.comment', 'pull.get', 'pull.create', 'pull.comment', 'pull.review', 'project.item.add', 'project.item.field.update'));--> statement-breakpoint
ALTER TABLE "RunnerSkill" ADD CONSTRAINT "RSkill_caps_valid" CHECK (jsonb_typeof("RunnerSkill"."requiredCapabilities") = 'array' and jsonb_array_length("RunnerSkill"."requiredCapabilities") <= 8 and "RunnerSkill"."requiredCapabilities" <@ '["workspace.read","workspace.write","github.contents.write","github.issues.read","github.issues.write","github.pull_requests.read","github.pull_requests.write","github.projects.read","github.projects.write"]'::jsonb);--> statement-breakpoint
ALTER TABLE "RunnerTeamStep" ADD CONSTRAINT "RTStep_approvedCapabilities_valid" CHECK (jsonb_typeof("RunnerTeamStep"."approvedCapabilities") = 'array' and jsonb_array_length("RunnerTeamStep"."approvedCapabilities") <= 8 and "RunnerTeamStep"."approvedCapabilities" <@ '["github.contents.write","github.issues.read","github.issues.write","github.pull_requests.read","github.pull_requests.write","github.projects.read","github.projects.write"]'::jsonb);--> statement-breakpoint
DO $migration$
DECLARE
  "currentDefinition" text;
  "contentsDefinition" text;
  "repositoryDefinition" text;
BEGIN
  SELECT pg_get_functiondef(
    '"RunnerRun_enforce_team_execution_permission"()'::regprocedure
  )
  INTO "currentDefinition";

  "contentsDefinition" := replace(
    "currentDefinition",
    '              (
                "declared"."value" LIKE ''github.issues.%''',
    '              (
                "declared"."value" LIKE ''github.contents.%''
                AND "declared"."value" LIKE ''%.write''
                AND "authority"."appContentsPermission" = ''write''
                AND "authority"."userPermissionCeiling" IN (''write'', ''maintain'', ''admin'')
                AND "authority"."userPermissionCurrent" IN (''write'', ''maintain'', ''admin'')
              )
              OR (
                "declared"."value" LIKE ''github.issues.%'''
  );

  IF "contentsDefinition" = "currentDefinition" THEN
    RAISE EXCEPTION '0034 could not locate the GitHub issue authority branch';
  END IF;

  "repositoryDefinition" := replace(
    "contentsDefinition",
    '          ''accountType'', "connection"."accountType",
          ''appIssuesPermission'', "connection"."appIssuesPermission",',
    '          ''accountType'', "connection"."accountType",
          ''appContentsPermission'', "connection"."appContentsPermission",
          ''appIssuesPermission'', "connection"."appIssuesPermission",'
  );

  IF "repositoryDefinition" = "contentsDefinition" THEN
    RAISE EXCEPTION '0034 could not locate the broker repository projection';
  END IF;

  EXECUTE "repositoryDefinition";
END
$migration$;