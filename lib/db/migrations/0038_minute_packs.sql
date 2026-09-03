CREATE TABLE "MinutePack" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"minutes" integer NOT NULL,
	"priceId" varchar(64) NOT NULL,
	"purchasedAt" timestamp DEFAULT now() NOT NULL,
	"stripeCheckoutSessionId" varchar(128) NOT NULL,
	"stripePaymentIntentId" varchar(64),
	"userId" uuid NOT NULL,
	CONSTRAINT "MinutePack_minutes_positive" CHECK ("MinutePack"."minutes" > 0)
);
--> statement-breakpoint
ALTER TABLE "MinutePack" ADD CONSTRAINT "MinutePack_userId_User_id_fk" FOREIGN KEY ("userId") REFERENCES "public"."User"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
CREATE UNIQUE INDEX "MinutePack_session_idx" ON "MinutePack" USING btree ("stripeCheckoutSessionId");--> statement-breakpoint
CREATE INDEX "MinutePack_user_idx" ON "MinutePack" USING btree ("userId");