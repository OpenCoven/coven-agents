CREATE TABLE "RunUsage" (
	"countedAt" timestamp DEFAULT now() NOT NULL,
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"runId" varchar(64) NOT NULL,
	"tenant" varchar(64) NOT NULL
);
--> statement-breakpoint
CREATE TABLE "StripeEvent" (
	"id" varchar(64) PRIMARY KEY NOT NULL,
	"processedAt" timestamp DEFAULT now() NOT NULL
);
--> statement-breakpoint
ALTER TABLE "User" ADD COLUMN "stripeCustomerId" varchar(64);--> statement-breakpoint
ALTER TABLE "User" ADD COLUMN "stripeSubscriptionId" varchar(64);--> statement-breakpoint
CREATE UNIQUE INDEX "RunUsage_tenant_run_idx" ON "RunUsage" USING btree ("tenant","runId");--> statement-breakpoint
CREATE UNIQUE INDEX "User_stripeCustomerId_idx" ON "User" USING btree ("stripeCustomerId");