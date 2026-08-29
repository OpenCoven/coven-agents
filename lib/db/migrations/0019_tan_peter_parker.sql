-- Existing agents remain durable and become runnable through the supported
-- Copilot harness. Daytona sandbox ownership is already stored independently,
-- so no agent, run, or provider lifecycle state needs to be deleted or reset.
-- Preserve selections accepted by the application-owned harness registry and
-- fall back to harness-managed selection for values that cannot be dispatched.
UPDATE "RunnerAgent" SET "runtime" = 'copilot', "model" = CASE WHEN "model" IN ('auto', 'claude-sonnet-4.5', 'gpt-5', 'gpt-5-mini') THEN "model" ELSE 'auto' END WHERE "runtime" = 'cloud';--> statement-breakpoint
ALTER TABLE "RunnerAgent" DROP CONSTRAINT "RunnerAgent_runtime_valid";--> statement-breakpoint
ALTER TABLE "RunnerAgent" ADD CONSTRAINT "RunnerAgent_runtime_valid" CHECK ("RunnerAgent"."runtime" in ('codex', 'claude', 'copilot'));