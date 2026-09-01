ALTER TABLE "RunnerGitHubOperation" DROP CONSTRAINT "RGHOp_timestamps_valid";--> statement-breakpoint
DROP INDEX "RGHOp_step_write_intent_uq";--> statement-breakpoint
ALTER TABLE "RunnerGitHubOperation" ADD COLUMN "providerDispatchPhase" varchar(16) DEFAULT 'not_applicable' NOT NULL;--> statement-breakpoint
ALTER TABLE "RunnerGitHubOperation" ADD COLUMN "providerSentAt" timestamp;--> statement-breakpoint
ALTER TABLE "RunnerGitHubOperation" ADD COLUMN "writeIntentActive" boolean DEFAULT false NOT NULL;--> statement-breakpoint
UPDATE "RunnerGitHubOperation"
SET "providerDispatchPhase" = 'sent',
    "providerSentAt" = COALESCE("startedAt", "createdAt"),
    "writeIntentActive" = true
WHERE "kind" NOT IN ('issue.get', 'issue.search', 'pull.get');--> statement-breakpoint
CREATE UNIQUE INDEX "RGHOp_step_write_intent_uq" ON "RunnerGitHubOperation" USING btree ("tenant","teamStepId","kind","requestHash") WHERE "RunnerGitHubOperation"."writeIntentActive" = true;--> statement-breakpoint
ALTER TABLE "RunnerGitHubOperation" ADD CONSTRAINT "RGHOp_dispatch_phase_valid" CHECK (("RunnerGitHubOperation"."kind" in ('issue.get','issue.search','pull.get') and "RunnerGitHubOperation"."providerDispatchPhase" = 'not_applicable' and "RunnerGitHubOperation"."providerSentAt" is null and "RunnerGitHubOperation"."writeIntentActive" = false) or ("RunnerGitHubOperation"."kind" not in ('issue.get','issue.search','pull.get') and (("RunnerGitHubOperation"."providerDispatchPhase" = 'pre_send' and "RunnerGitHubOperation"."providerSentAt" is null) or ("RunnerGitHubOperation"."providerDispatchPhase" = 'sent' and "RunnerGitHubOperation"."providerSentAt" is not null)) and ("RunnerGitHubOperation"."writeIntentActive" = true or ("RunnerGitHubOperation"."providerDispatchPhase" = 'pre_send' and "RunnerGitHubOperation"."status" = 'pending' and ("RunnerGitHubOperation"."error"->>'retryable')::boolean = true))));--> statement-breakpoint
ALTER TABLE "RunnerGitHubOperation" ADD CONSTRAINT "RGHOp_timestamps_valid" CHECK (("RunnerGitHubOperation"."startedAt" is null or "RunnerGitHubOperation"."startedAt" >= "RunnerGitHubOperation"."createdAt") and ("RunnerGitHubOperation"."providerSentAt" is null or ("RunnerGitHubOperation"."providerSentAt" >= "RunnerGitHubOperation"."createdAt" and ("RunnerGitHubOperation"."startedAt" is null or "RunnerGitHubOperation"."providerSentAt" >= "RunnerGitHubOperation"."startedAt"))) and ("RunnerGitHubOperation"."completedAt" is null or ("RunnerGitHubOperation"."completedAt" >= "RunnerGitHubOperation"."createdAt" and ("RunnerGitHubOperation"."startedAt" is null or "RunnerGitHubOperation"."completedAt" >= "RunnerGitHubOperation"."startedAt"))));
--> statement-breakpoint
CREATE OR REPLACE FUNCTION "RunnerGitHubOperation_enforce_dispatch_state"() RETURNS trigger AS $$
BEGIN
  IF OLD."providerDispatchPhase" = 'not_applicable'
    AND (
      NEW."providerDispatchPhase" IS DISTINCT FROM OLD."providerDispatchPhase"
      OR NEW."providerSentAt" IS DISTINCT FROM OLD."providerSentAt"
      OR NEW."writeIntentActive" IS DISTINCT FROM OLD."writeIntentActive"
    ) THEN
    RAISE EXCEPTION 'Read-only GitHub operation dispatch state is immutable';
  END IF;

  IF OLD."providerDispatchPhase" = 'sent'
    AND (
      NEW."providerDispatchPhase" IS DISTINCT FROM OLD."providerDispatchPhase"
      OR NEW."providerSentAt" IS DISTINCT FROM OLD."providerSentAt"
      OR NEW."writeIntentActive" IS DISTINCT FROM OLD."writeIntentActive"
    ) THEN
    RAISE EXCEPTION 'Sent GitHub operation dispatch state is immutable';
  END IF;

  IF OLD."providerDispatchPhase" = 'pre_send'
    AND NEW."providerDispatchPhase" = 'sent'
    AND NOT (
      OLD."status" = 'running'
      AND NEW."status" = 'running'
      AND OLD."providerSentAt" IS NULL
      AND NEW."providerSentAt" IS NOT NULL
      AND OLD."writeIntentActive" = true
      AND NEW."writeIntentActive" = true
    ) THEN
    RAISE EXCEPTION 'GitHub provider dispatch transition is invalid';
  END IF;

  IF OLD."providerDispatchPhase" = 'pre_send'
    AND NEW."providerDispatchPhase" = 'pre_send'
    AND NEW."providerSentAt" IS DISTINCT FROM OLD."providerSentAt" THEN
    RAISE EXCEPTION 'GitHub provider sent timestamp is immutable';
  END IF;

  IF OLD."providerDispatchPhase" = 'pre_send'
    AND NEW."providerDispatchPhase" NOT IN ('pre_send', 'sent') THEN
    RAISE EXCEPTION 'GitHub provider dispatch transition is invalid';
  END IF;

  IF OLD."writeIntentActive" = true
    AND NEW."writeIntentActive" = false
    AND NOT (
      OLD."providerDispatchPhase" = 'pre_send'
      AND NEW."providerDispatchPhase" = 'pre_send'
      AND OLD."status" = 'running'
      AND NEW."status" = 'pending'
      AND NEW."providerSentAt" IS NULL
      AND NEW."completedAt" IS NULL
      AND NEW."error" IS NOT NULL
      AND (NEW."error"->>'retryable')::boolean = true
    ) THEN
    RAISE EXCEPTION 'GitHub write intent release is invalid';
  END IF;

  IF OLD."writeIntentActive" = false
    AND NEW."writeIntentActive" = true
    AND NOT (
      OLD."providerDispatchPhase" = 'pre_send'
      AND NEW."providerDispatchPhase" = 'pre_send'
      AND OLD."status" = 'pending'
      AND NEW."status" = 'running'
      AND (OLD."error"->>'retryable')::boolean = true
      AND NEW."error" IS NULL
      AND NEW."providerSentAt" IS NULL
      AND NEW."completedAt" IS NULL
    ) THEN
    RAISE EXCEPTION 'GitHub write intent retry is invalid';
  END IF;

  RETURN NEW;
END;
$$ LANGUAGE plpgsql;--> statement-breakpoint
CREATE TRIGGER "RunnerGitHubOperation_dispatch_state"
  BEFORE UPDATE ON "RunnerGitHubOperation"
  FOR EACH ROW
  EXECUTE FUNCTION "RunnerGitHubOperation_enforce_dispatch_state"();--> statement-breakpoint
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
    AND NEW."status" = 'pending'
    AND NOT (
      OLD."providerDispatchPhase" = 'pre_send'
      AND NEW."providerDispatchPhase" = 'pre_send'
      AND OLD."writeIntentActive" = true
      AND NEW."writeIntentActive" = false
      AND NEW."error" IS NOT NULL
      AND (NEW."error"->>'retryable')::boolean = true
    ) THEN
    RAISE EXCEPTION 'GitHub operation pre-send retry transition is invalid';
  END IF;
  IF OLD."status" = 'running'
    AND NEW."status" NOT IN ('pending', 'running', 'completed', 'failed') THEN
    RAISE EXCEPTION 'GitHub operation status transition is invalid';
  END IF;
  RETURN NEW;
END;
$$ LANGUAGE plpgsql;