DO $$
BEGIN
  IF EXISTS (
    SELECT 1
    FROM "Integration"
    WHERE "credentials" IS NOT NULL
  ) THEN
    RAISE EXCEPTION 'Integration credentials contain plaintext values. Export and encrypt them before applying this migration.';
  END IF;
END $$;

ALTER TABLE "Integration"
  DROP COLUMN "credentials",
  ADD COLUMN "credentialsEncrypted" TEXT;
