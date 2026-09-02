ALTER TABLE "RunReservation" ADD COLUMN "durationSeconds" integer;--> statement-breakpoint
ALTER TABLE "RunReservation" ADD COLUMN "reservedUnits" integer;--> statement-breakpoint
ALTER TABLE "RunReservation" ADD COLUMN "settledAt" timestamp;--> statement-breakpoint
UPDATE "RunReservation" SET "reservedUnits" = "costUnits" WHERE "reservedUnits" IS NULL;--> statement-breakpoint
ALTER TABLE "RunReservation" ALTER COLUMN "reservedUnits" SET NOT NULL;--> statement-breakpoint
ALTER TABLE "RunReservation" ADD CONSTRAINT "RunReservation_costUnits_within_reserved" CHECK ("RunReservation"."costUnits" <= "RunReservation"."reservedUnits");--> statement-breakpoint
ALTER TABLE "RunReservation" ADD CONSTRAINT "RunReservation_settlement_valid" CHECK (("RunReservation"."settledAt" is null and "RunReservation"."durationSeconds" is null) or ("RunReservation"."settledAt" is not null and "RunReservation"."durationSeconds" is not null and "RunReservation"."durationSeconds" >= 0));
