CREATE TABLE "PilotAdmissionWindow" (
	"admitted" integer DEFAULT 0 NOT NULL,
	"endsAt" timestamp with time zone PRIMARY KEY NOT NULL,
	CONSTRAINT "PilotAdmissionWindow_count" CHECK ("PilotAdmissionWindow"."admitted" BETWEEN 0 AND 4)
);
