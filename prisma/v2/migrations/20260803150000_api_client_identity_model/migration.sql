ALTER TABLE "api_clients"
  ADD COLUMN "type" VARCHAR(32) NOT NULL DEFAULT 'service-account',
  ADD COLUMN "allowedEnvironmentsJson" TEXT,
  ADD COLUMN "scopeGrantsJson" TEXT,
  ADD COLUMN "createdBy" VARCHAR(128);

UPDATE "api_clients"
SET
  "allowedEnvironmentsJson" = json_build_array("environment")::text,
  "scopeGrantsJson" = "scopesJson",
  "createdBy" = 'system:migration';

ALTER TABLE "api_clients"
  ALTER COLUMN "allowedEnvironmentsJson" SET NOT NULL,
  ALTER COLUMN "scopeGrantsJson" SET NOT NULL,
  ALTER COLUMN "createdBy" SET NOT NULL,
  DROP COLUMN "environment",
  DROP COLUMN "scopesJson";

ALTER TABLE "api_clients"
  ADD CONSTRAINT "api_clients_type_check"
    CHECK ("type" IN ('service-account', 'oauth-application', 'personal-development')),
  ADD CONSTRAINT "api_clients_allowed_environments_json_check"
    CHECK (
      "allowedEnvironmentsJson"::jsonb IN (
        '["sandbox"]'::jsonb,
        '["production"]'::jsonb,
        '["production", "sandbox"]'::jsonb
      )
    ),
  ADD CONSTRAINT "api_clients_scope_grants_json_check"
    CHECK (jsonb_typeof("scopeGrantsJson"::jsonb) = 'array'),
  ADD CONSTRAINT "api_clients_created_by_check"
    CHECK ("createdBy" ~ '^[A-Za-z0-9:_-]{3,128}$');
