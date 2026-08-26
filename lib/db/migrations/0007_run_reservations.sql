CREATE TABLE "RunReservation" (
	"consumedAt" timestamp,
	"costUnits" integer NOT NULL,
	"expiresAt" timestamp NOT NULL,
	"periodDay" date NOT NULL,
	"periodMonth" timestamp NOT NULL,
	"releasedAt" timestamp,
	"reservedAt" timestamp DEFAULT now() NOT NULL,
	"runId" varchar(64) PRIMARY KEY NOT NULL,
	"state" varchar(16) DEFAULT 'reserved' NOT NULL,
	"tenantHash" varchar(64) NOT NULL,
	CONSTRAINT "RunReservation_costUnits_positive" CHECK ("RunReservation"."costUnits" > 0),
	CONSTRAINT "RunReservation_state_valid" CHECK ("RunReservation"."state" in ('reserved', 'consumed', 'released')),
	CONSTRAINT "RunReservation_state_timestamps_valid" CHECK (("RunReservation"."state" = 'reserved' and "RunReservation"."consumedAt" is null and "RunReservation"."releasedAt" is null) or ("RunReservation"."state" = 'consumed' and "RunReservation"."consumedAt" is not null and "RunReservation"."releasedAt" is null) or ("RunReservation"."state" = 'released' and "RunReservation"."consumedAt" is null and "RunReservation"."releasedAt" is not null)),
	CONSTRAINT "RunReservation_expiry_valid" CHECK ("RunReservation"."expiresAt" > "RunReservation"."reservedAt")
);
--> statement-breakpoint
CREATE INDEX "RunReservation_tenant_day_state_idx" ON "RunReservation" USING btree ("tenantHash","periodDay","state");--> statement-breakpoint
CREATE INDEX "RunReservation_day_state_idx" ON "RunReservation" USING btree ("periodDay","state");--> statement-breakpoint
CREATE INDEX "RunReservation_tenant_period_state_idx" ON "RunReservation" USING btree ("tenantHash","periodMonth","state");