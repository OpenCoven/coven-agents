ALTER TABLE "RunReservation" ADD COLUMN "monthlyCap" integer;--> statement-breakpoint
ALTER TABLE "RunReservation" ADD COLUMN "userId" uuid;--> statement-breakpoint
ALTER TABLE "RunReservation" ADD CONSTRAINT "RunReservation_userId_User_id_fk" FOREIGN KEY ("userId") REFERENCES "public"."User"("id") ON DELETE set null ON UPDATE no action;--> statement-breakpoint
CREATE INDEX "RunReservation_user_period_state_idx" ON "RunReservation" USING btree ("userId","periodMonth","state");--> statement-breakpoint
ALTER TABLE "RunReservation" ADD CONSTRAINT "RunReservation_monthlyCap_positive" CHECK ("RunReservation"."monthlyCap" is null or "RunReservation"."monthlyCap" > 0);