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
    RAISE EXCEPTION '0031 could not locate the repository ordering expression';
  END IF;

  EXECUTE "orderedDefinition";
END
$migration$;