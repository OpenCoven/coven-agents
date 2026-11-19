-- Historical caps and pre-rotation account associations were never recorded.
-- Refuse a cutover that would guess a purchased balance. This is intentionally
-- conservative: reconciliation and a quiesced writer window are owner gates.
DO $$
BEGIN
  IF EXISTS (SELECT 1 FROM "MinutePack") AND (
    EXISTS (SELECT 1 FROM "RunReservation" WHERE state IN ('reserved', 'consumed'))
    OR EXISTS (SELECT 1 FROM "RunUsage")
  ) THEN
    RAISE EXCEPTION '0049 Pack ledger migration requires owner reconciliation of existing paid usage before cutover';
  END IF;
END $$;
--> statement-breakpoint
CREATE TABLE "RunPackDraw" (
	"runId" varchar(64) PRIMARY KEY NOT NULL,
	"userId" uuid NOT NULL,
	"reservedMinutes" integer NOT NULL,
	"minutes" integer NOT NULL,
	CONSTRAINT "RunPackDraw_minutes_valid" CHECK ("RunPackDraw"."minutes" >= 0 and "RunPackDraw"."minutes" <= "RunPackDraw"."reservedMinutes"),
	CONSTRAINT "RunPackDraw_reservedMinutes_valid" CHECK ("RunPackDraw"."reservedMinutes" >= 0)
);
--> statement-breakpoint
ALTER TABLE "RunPackDraw" ADD CONSTRAINT "RunPackDraw_runId_RunReservation_runId_fk" FOREIGN KEY ("runId") REFERENCES "public"."RunReservation"("runId") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "RunPackDraw" ADD CONSTRAINT "RunPackDraw_userId_User_id_fk" FOREIGN KEY ("userId") REFERENCES "public"."User"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
CREATE INDEX "RunPackDraw_user_idx" ON "RunPackDraw" USING btree ("userId");