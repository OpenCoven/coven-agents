UPDATE "User" AS "user"
SET "subscriptionOverrideAction" = "audit"."action",
    "subscriptionOverrideAt" = "audit"."createdAt"
FROM (
  SELECT DISTINCT ON ("userId")
    "userId", "action", "createdAt", "newAuthVersion", "newSubscribedUntil"
  FROM "SubscriptionOverrideAudit"
  ORDER BY "userId", "newAuthVersion" DESC, "createdAt" DESC, "id" DESC
) AS "audit"
WHERE "user"."id" = "audit"."userId"
  AND "user"."authVersion" >= "audit"."newAuthVersion"
  AND "user"."subscribedUntil" IS NOT DISTINCT FROM "audit"."newSubscribedUntil";
