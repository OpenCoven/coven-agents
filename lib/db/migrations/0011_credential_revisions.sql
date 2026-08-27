ALTER TABLE "TenantCredential"
ADD COLUMN IF NOT EXISTS "credentialRevision" uuid DEFAULT gen_random_uuid();
--> statement-breakpoint
UPDATE "TenantCredential"
SET "credentialRevision" = gen_random_uuid()
WHERE "credentialRevision" IS NULL;
--> statement-breakpoint
ALTER TABLE "TenantCredential"
ALTER COLUMN "credentialRevision" SET DEFAULT gen_random_uuid();
--> statement-breakpoint
ALTER TABLE "TenantCredential"
ALTER COLUMN "credentialRevision" SET NOT NULL;
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

  -- A ciphertext/IV rewrite is a logical credential change. Auto-advance the
  -- logical revision for legacy writers that have not learned this column yet;
  -- new writers set it explicitly. The trusted AAD-binding transaction is
  -- deliberately exempt because it re-encrypts legacy ciphertext while
  -- preserving the credential itself.
  IF TG_OP = 'UPDATE'
    AND (
      NEW."ciphertext" IS DISTINCT FROM OLD."ciphertext"
      OR NEW."iv" IS DISTINCT FROM OLD."iv"
    )
    AND NEW."credentialRevision" IS NOT DISTINCT FROM OLD."credentialRevision"
    AND current_setting('coven.credential_aad_migration', true)
      IS DISTINCT FROM 'on'
  THEN
    NEW."credentialRevision" := gen_random_uuid();
  END IF;

  RETURN NEW;
END;
$$;
--> statement-breakpoint
-- Rollback: DROP FUNCTION IF EXISTS "tenant_credential_envelope_revision_guard"();
-- Rollback: ALTER TABLE "TenantCredential" DROP COLUMN IF EXISTS "credentialRevision";