ALTER TABLE "RunnerRun" ADD COLUMN "entitlementMinutes" integer;--> statement-breakpoint
ALTER TABLE "User" ADD COLUMN "campaignExpiresAt" timestamp;--> statement-breakpoint
ALTER TABLE "User" ADD COLUMN "campaignGrantedAt" timestamp;--> statement-breakpoint
CREATE INDEX "User_campaignGrantedAt_idx" ON "User" USING btree ("campaignGrantedAt") WHERE "User"."campaignGrantedAt" is not null;--> statement-breakpoint
ALTER TABLE "User" ADD CONSTRAINT "User_campaignGrant_shape" CHECK (("User"."campaignGrantedAt" is null and "User"."campaignExpiresAt" is null) or ("User"."campaignGrantedAt" is not null and "User"."campaignExpiresAt" is not null and isfinite("User"."campaignGrantedAt") and isfinite("User"."campaignExpiresAt") and "User"."campaignExpiresAt" > "User"."campaignGrantedAt"));