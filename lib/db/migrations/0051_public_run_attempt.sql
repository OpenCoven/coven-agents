ALTER TABLE "RunnerRun" ADD COLUMN "attemptRef" uuid;
--> statement-breakpoint
UPDATE "RunnerRun" SET "attemptRef" = gen_random_uuid()
WHERE "daytonaAttemptId" IS NOT NULL OR "startedAt" IS NOT NULL;
