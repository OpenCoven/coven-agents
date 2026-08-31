CREATE TABLE "StripeReconciliation" (
	"createdAt" timestamp DEFAULT now() NOT NULL,
	"eventId" varchar(64) PRIMARY KEY NOT NULL,
	"eventType" varchar(32) NOT NULL,
	"reason" varchar(64) NOT NULL,
	"status" varchar(16) DEFAULT 'pending' NOT NULL,
	CONSTRAINT "StripeReconciliation_eventType_check" CHECK ("StripeReconciliation"."eventType" in ('invoice.paid', 'invoice.payment_failed')),
	CONSTRAINT "StripeReconciliation_reason_check" CHECK ("StripeReconciliation"."reason" in ('invoice_ambiguous_entitlement', 'invoice_conflicting_paid_interval', 'invoice_contradictory_subscription', 'invoice_invalid_period', 'invoice_invalid_reference')),
	CONSTRAINT "StripeReconciliation_status_check" CHECK ("StripeReconciliation"."status" in ('pending', 'acknowledged', 'resolved'))
);
--> statement-breakpoint
ALTER TABLE "StripeReconciliation" ADD CONSTRAINT "StripeReconciliation_eventId_StripeEvent_id_fk" FOREIGN KEY ("eventId") REFERENCES "public"."StripeEvent"("id") ON DELETE restrict ON UPDATE no action;