CREATE TABLE "TenantCredential" (
	"ciphertext" text NOT NULL,
	"createdAt" timestamp DEFAULT now() NOT NULL,
	"harnessId" varchar(32) NOT NULL,
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"iv" text NOT NULL,
	"tenant" varchar(64) NOT NULL,
	"updatedAt" timestamp DEFAULT now() NOT NULL,
	"wrappedKey" text NOT NULL
);
--> statement-breakpoint
CREATE UNIQUE INDEX "TenantCredential_tenant_harness_idx" ON "TenantCredential" USING btree ("tenant","harnessId");
