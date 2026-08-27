CREATE TABLE "CredentialLease" (
	"consumedAt" timestamp,
	"expiresAt" timestamp NOT NULL,
	"harnessId" varchar(64) NOT NULL,
	"issuedAt" timestamp DEFAULT now() NOT NULL,
	"operationIdHash" varchar(64) NOT NULL,
	"requestIdHash" varchar(64) PRIMARY KEY NOT NULL,
	"runId" varchar(64) NOT NULL,
	"tenantHash" varchar(64) NOT NULL,
	CONSTRAINT "CredentialLease_operationIdHash_unique" UNIQUE("operationIdHash"),
	CONSTRAINT "CredentialLease_expiry_valid" CHECK ("CredentialLease"."expiresAt" > "CredentialLease"."issuedAt"),
	CONSTRAINT "CredentialLease_consumption_valid" CHECK ("CredentialLease"."consumedAt" is null or ("CredentialLease"."consumedAt" >= "CredentialLease"."issuedAt" and "CredentialLease"."consumedAt" < "CredentialLease"."expiresAt"))
);
--> statement-breakpoint
CREATE UNIQUE INDEX "CredentialLease_run_idx" ON "CredentialLease" USING btree ("runId");--> statement-breakpoint
CREATE INDEX "CredentialLease_expiry_idx" ON "CredentialLease" USING btree ("expiresAt");