CREATE TABLE "SubscriptionOverrideAudit" (
	"action" varchar(6) NOT NULL,
	"createdAt" timestamp DEFAULT now() NOT NULL,
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"newAuthVersion" integer NOT NULL,
	"newSubscribedUntil" timestamp,
	"previousAuthVersion" integer NOT NULL,
	"previousSubscribedUntil" timestamp,
	"referenceDigest" varchar(64) NOT NULL,
	"userId" uuid NOT NULL,
	CONSTRAINT "SubscriptionOverrideAudit_action_check" CHECK ("SubscriptionOverrideAudit"."action" in ('grant', 'revoke')),
	CONSTRAINT "SubscriptionOverrideAudit_referenceDigest_check" CHECK ("SubscriptionOverrideAudit"."referenceDigest" ~ '^[0-9a-f]{64}$'),
	CONSTRAINT "SubscriptionOverrideAudit_authVersion_check" CHECK ("SubscriptionOverrideAudit"."previousAuthVersion" >= 0 and "SubscriptionOverrideAudit"."newAuthVersion" = "SubscriptionOverrideAudit"."previousAuthVersion" + 1),
	CONSTRAINT "SubscriptionOverrideAudit_paidThrough_check" CHECK (("SubscriptionOverrideAudit"."action" = 'grant' and "SubscriptionOverrideAudit"."newSubscribedUntil" is not null) or ("SubscriptionOverrideAudit"."action" = 'revoke' and "SubscriptionOverrideAudit"."newSubscribedUntil" is null))
);
--> statement-breakpoint
ALTER TABLE "SubscriptionOverrideAudit" ADD CONSTRAINT "SubscriptionOverrideAudit_userId_User_id_fk" FOREIGN KEY ("userId") REFERENCES "public"."User"("id") ON DELETE restrict ON UPDATE no action;--> statement-breakpoint
CREATE INDEX "SubscriptionOverrideAudit_user_createdAt_idx" ON "SubscriptionOverrideAudit" USING btree ("userId","createdAt");