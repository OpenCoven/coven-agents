CREATE TABLE "RunnerGitHubConnectionFence" (
	"generation" bigint DEFAULT 0 NOT NULL,
	"tenant" varchar(64) PRIMARY KEY NOT NULL,
	"updatedAt" timestamp DEFAULT now() NOT NULL,
	CONSTRAINT "RGHConnFence_tenant_valid" CHECK ("RunnerGitHubConnectionFence"."tenant" ~ '^[A-Za-z0-9_]{1,64}$'),
	CONSTRAINT "RGHConnFence_generation_nonnegative" CHECK ("RunnerGitHubConnectionFence"."generation" >= 0)
);
--> statement-breakpoint
INSERT INTO "RunnerGitHubConnectionFence" ("tenant", "generation", "updatedAt")
SELECT DISTINCT "tenant", 0, now()
FROM "RunnerGitHubConnection"
ON CONFLICT ("tenant") DO NOTHING;
--> statement-breakpoint
CREATE UNIQUE INDEX "RGHConnFence_tenant_generation_uq" ON "RunnerGitHubConnectionFence" USING btree ("tenant","generation");