ALTER TABLE "IdempotencyRecord" DROP CONSTRAINT "IdempotencyRecord_response_state_check";--> statement-breakpoint
DELETE FROM "IdempotencyRecord"
WHERE "operation" = 'credential_device_start';--> statement-breakpoint
DELETE FROM "IdempotencyRecord"
WHERE "state" = 'completed'
AND ("responseJson" IS NULL OR "responseStatus" IS NULL);--> statement-breakpoint
UPDATE "IdempotencyRecord"
SET "responseJson" = jsonb_build_object('kind', 'plain_json', 'body', "responseJson")
WHERE "state" = 'completed';--> statement-breakpoint
ALTER TABLE "IdempotencyRecord" ADD CONSTRAINT "IdempotencyRecord_response_state_check" CHECK (("IdempotencyRecord"."state" = 'in_progress' and "IdempotencyRecord"."responseJson" is null and "IdempotencyRecord"."responseStatus" is null) or ("IdempotencyRecord"."state" = 'completed' and "IdempotencyRecord"."responseJson" is not null and jsonb_typeof("IdempotencyRecord"."responseJson") = 'object' and "IdempotencyRecord"."responseJson"->>'kind' in ('plain_json', 'encrypted_json') and "IdempotencyRecord"."responseStatus" is not null and "IdempotencyRecord"."responseStatus" between 200 and 299));