CREATE TABLE "RunnerOwnerCredential" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"digest" varchar(64) NOT NULL,
	"userId" uuid NOT NULL,
	"agentId" uuid NOT NULL,
	"tenant" varchar(64) NOT NULL,
	"authVersion" integer NOT NULL,
	"scopes" text[] NOT NULL,
	"issuedAt" timestamp with time zone NOT NULL,
	"expiresAt" timestamp with time zone NOT NULL,
	"revokedAt" timestamp with time zone,
	CONSTRAINT "RunnerOwnerCredential_digest_unique" UNIQUE("digest"),
	CONSTRAINT "RunnerOwnerCredential_owner" CHECK ("RunnerOwnerCredential"."tenant" = 'u_' || replace("RunnerOwnerCredential"."userId"::text, '-', '')),
	CONSTRAINT "RunnerOwnerCredential_digest" CHECK ("RunnerOwnerCredential"."digest" ~ '^[0-9a-f]{64}$'),
	CONSTRAINT "RunnerOwnerCredential_lifetime" CHECK ("RunnerOwnerCredential"."expiresAt" > "RunnerOwnerCredential"."issuedAt" and "RunnerOwnerCredential"."expiresAt" <= "RunnerOwnerCredential"."issuedAt" + interval '1 hour'),
	CONSTRAINT "RunnerOwnerCredential_scopes" CHECK (cardinality("RunnerOwnerCredential"."scopes") between 1 and 5 and array_position("RunnerOwnerCredential"."scopes", null) is null and "RunnerOwnerCredential"."scopes" <@ array['run:start','run:read','run:events','run:stop','sandbox:inspect']::text[])
);
--> statement-breakpoint
ALTER TABLE "RunnerRun" ADD COLUMN "ownerCredentialId" uuid;--> statement-breakpoint
ALTER TABLE "RunnerOwnerCredential" ADD CONSTRAINT "RunnerOwnerCredential_userId_User_id_fk" FOREIGN KEY ("userId") REFERENCES "public"."User"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "RunnerOwnerCredential" ADD CONSTRAINT "RunnerOwnerCredential_agentId_tenant_RunnerAgent_id_tenant_fk" FOREIGN KEY ("agentId","tenant") REFERENCES "public"."RunnerAgent"("id","tenant") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
CREATE INDEX "RunnerOwnerCredential_owner_agent_idx" ON "RunnerOwnerCredential" USING btree ("userId","agentId");