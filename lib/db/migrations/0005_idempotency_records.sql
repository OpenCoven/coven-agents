CREATE TABLE "IdempotencyRecord" (
	"createdAt" timestamp DEFAULT now() NOT NULL,
	"expiresAt" timestamp NOT NULL,
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"keyHash" text NOT NULL,
	"operation" varchar(64) NOT NULL,
	"ownerId" uuid NOT NULL,
	"requestHash" text NOT NULL,
	"responseJson" jsonb,
	"responseStatus" integer,
	"state" varchar(16) DEFAULT 'in_progress' NOT NULL,
	"updatedAt" timestamp DEFAULT now() NOT NULL,
	CONSTRAINT "IdempotencyRecord_state_check" CHECK ("IdempotencyRecord"."state" in ('in_progress', 'completed')),
	CONSTRAINT "IdempotencyRecord_response_state_check" CHECK (("IdempotencyRecord"."state" = 'in_progress' and "IdempotencyRecord"."responseJson" is null and "IdempotencyRecord"."responseStatus" is null) or ("IdempotencyRecord"."state" = 'completed' and "IdempotencyRecord"."responseJson" is not null and "IdempotencyRecord"."responseStatus" between 200 and 299))
);
--> statement-breakpoint
ALTER TABLE "IdempotencyRecord" ADD CONSTRAINT "IdempotencyRecord_ownerId_User_id_fk" FOREIGN KEY ("ownerId") REFERENCES "public"."User"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
CREATE UNIQUE INDEX "IdempotencyRecord_owner_operation_key_idx" ON "IdempotencyRecord" USING btree ("ownerId","operation","keyHash");--> statement-breakpoint
CREATE INDEX "IdempotencyRecord_expiresAt_idx" ON "IdempotencyRecord" USING btree ("expiresAt");