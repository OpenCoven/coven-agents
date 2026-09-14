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
    OR NEW."projectId" IS DISTINCT FROM OLD."projectId"
    OR NEW."projectAuthorityBound" IS DISTINCT FROM OLD."projectAuthorityBound"
    OR NEW."createdAt" IS DISTINCT FROM OLD."createdAt" THEN
    RAISE EXCEPTION 'GitHub operation request authority is immutable';
  END IF;
  RETURN NEW;
END;
$$ LANGUAGE plpgsql;