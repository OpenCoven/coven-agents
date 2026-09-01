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