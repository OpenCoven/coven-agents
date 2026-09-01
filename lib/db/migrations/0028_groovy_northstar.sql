ALTER TABLE "User" ADD COLUMN "subscriptionOverrideAction" varchar(6);--> statement-breakpoint
ALTER TABLE "User" ADD COLUMN "subscriptionOverrideAt" timestamp;--> statement-breakpoint
UPDATE "User" AS "user"
SET "subscriptionOverrideAction" = "audit"."action",
    "subscriptionOverrideAt" = "audit"."createdAt"
FROM (
  SELECT DISTINCT ON ("userId")
    "userId", "action", "createdAt", "newAuthVersion", "newSubscribedUntil"
  FROM "SubscriptionOverrideAudit"
  ORDER BY "userId", "createdAt" DESC, "id" DESC
) AS "audit"
WHERE "user"."id" = "audit"."userId"
  AND "user"."authVersion" = "audit"."newAuthVersion"
  AND "user"."subscribedUntil" IS NOT DISTINCT FROM "audit"."newSubscribedUntil";--> statement-breakpoint
ALTER TABLE "User" ADD CONSTRAINT "User_subscriptionOverride_shape" CHECK (("User"."subscriptionOverrideAction" is null and "User"."subscriptionOverrideAt" is null) or ("User"."subscriptionOverrideAction" in ('grant', 'revoke') and "User"."subscriptionOverrideAt" is not null and isfinite("User"."subscriptionOverrideAt")));