ALTER TABLE "TenantCredential"
ADD COLUMN IF NOT EXISTS "envelopeRevision" uuid DEFAULT gen_random_uuid();
--> statement-breakpoint
UPDATE "TenantCredential"
SET "envelopeRevision" = gen_random_uuid()
WHERE "envelopeRevision" IS NULL;
--> statement-breakpoint
ALTER TABLE "TenantCredential"
ALTER COLUMN "envelopeRevision" SET DEFAULT gen_random_uuid();
--> statement-breakpoint
ALTER TABLE "TenantCredential"
ALTER COLUMN "envelopeRevision" SET NOT NULL;
--> statement-breakpoint
ALTER TABLE "TenantCredential"
ALTER COLUMN "kekVersion" SET DEFAULT 'v1';
--> statement-breakpoint
CREATE OR REPLACE FUNCTION "tenant_credential_envelope_revision_guard"()
RETURNS trigger
LANGUAGE plpgsql
AS $$
BEGIN
  IF TG_OP = 'UPDATE'
    AND (
      NEW."ciphertext" IS DISTINCT FROM OLD."ciphertext"
      OR NEW."iv" IS DISTINCT FROM OLD."iv"
      OR NEW."wrappedKey" IS DISTINCT FROM OLD."wrappedKey"
      OR NEW."kekVersion" IS DISTINCT FROM OLD."kekVersion"
      OR NEW."aadVersion" IS DISTINCT FROM OLD."aadVersion"
    )
    AND NEW."envelopeRevision" IS NOT DISTINCT FROM OLD."envelopeRevision"
  THEN
    RAISE EXCEPTION
      'TenantCredential envelope fields require a new envelopeRevision';
  END IF;

  RETURN NEW;
END;
$$;
--> statement-breakpoint
DROP TRIGGER IF EXISTS "TenantCredential_envelope_revision_guard"
ON "TenantCredential";
--> statement-breakpoint
CREATE TRIGGER "TenantCredential_envelope_revision_guard"
BEFORE UPDATE OF "ciphertext", "iv", "wrappedKey", "kekVersion", "aadVersion"
ON "TenantCredential"
FOR EACH ROW
EXECUTE FUNCTION "tenant_credential_envelope_revision_guard"();
--> statement-breakpoint
-- Rollback: DROP TRIGGER IF EXISTS "TenantCredential_envelope_revision_guard" ON "TenantCredential";
-- Rollback: DROP FUNCTION IF EXISTS "tenant_credential_envelope_revision_guard"();
-- Rollback: ALTER TABLE "TenantCredential" DROP COLUMN IF EXISTS "envelopeRevision";
