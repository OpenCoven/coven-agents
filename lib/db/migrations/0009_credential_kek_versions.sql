ALTER TABLE "TenantCredential"
ADD COLUMN IF NOT EXISTS "kekVersion" varchar(32) DEFAULT 'v1';
--> statement-breakpoint
UPDATE "TenantCredential"
SET "kekVersion" = 'v1'
WHERE "kekVersion" IS NULL;
--> statement-breakpoint
ALTER TABLE "TenantCredential"
ALTER COLUMN "kekVersion" SET NOT NULL;
--> statement-breakpoint
ALTER TABLE "TenantCredential"
ALTER COLUMN "kekVersion" DROP DEFAULT;
--> statement-breakpoint
ALTER TABLE "TenantCredential" ADD CONSTRAINT "TenantCredential_kekVersion_valid" CHECK ("TenantCredential"."kekVersion" ~ '^[A-Za-z0-9_-]{1,32}$');