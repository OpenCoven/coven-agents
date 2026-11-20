CREATE TABLE "PilotAdmissionWindow" (
	"endsAt" timestamp with time zone PRIMARY KEY NOT NULL,
	"admitted" integer DEFAULT 0 NOT NULL,
	CONSTRAINT "PilotAdmissionWindow_count" CHECK ("PilotAdmissionWindow"."admitted" BETWEEN 0 AND 4)
);
