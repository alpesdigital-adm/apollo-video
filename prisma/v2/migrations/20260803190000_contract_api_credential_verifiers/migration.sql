-- Contract the completed ApiCredential split: identity rows never duplicate
-- credential verifiers, and each credential owns one exact scrypt verifier.

ALTER TABLE "api_credentials"
  ALTER COLUMN "secretSalt" TYPE VARCHAR(22),
  ALTER COLUMN "secretHash" TYPE VARCHAR(64),
  ADD CONSTRAINT "api_credentials_salt_check"
    CHECK ("secretSalt" ~ '^[A-Za-z0-9_-]{22}$');

ALTER TABLE "api_clients"
  DROP COLUMN "secretSalt",
  DROP COLUMN "secretHash";
