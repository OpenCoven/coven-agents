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