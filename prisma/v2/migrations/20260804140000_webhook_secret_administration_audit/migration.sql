ALTER TABLE "webhook_administration_commands"
ADD COLUMN "endpointId" UUID;

ALTER TABLE "webhook_administration_commands"
DROP CONSTRAINT "webhook_admin_commands_action_check",
DROP CONSTRAINT "webhook_admin_commands_target_check",
DROP CONSTRAINT "webhook_admin_commands_replay_check";

ALTER TABLE "webhook_administration_commands"
ADD CONSTRAINT "webhook_admin_commands_action_check" CHECK (
  "action" IN (
    'webhook-endpoint.create',
    'webhook-endpoint.status.set',
    'webhook-subscription.create',
    'webhook-subscription.status.set',
    'webhook-signing-secret.provision',
    'webhook-signing-secret-rotation.stage',
    'webhook-signing-secret-rotation.activate',
    'webhook-signing-secret-rotation.cancel'
  )
),
ADD CONSTRAINT "webhook_admin_commands_target_check" CHECK (
  ("targetType" = 'webhook-endpoint' AND "action" LIKE 'webhook-endpoint.%' AND "endpointId" IS NULL) OR
  ("targetType" = 'webhook-subscription' AND "action" LIKE 'webhook-subscription.%' AND "endpointId" IS NULL) OR
  ("targetType" = 'webhook-signing-secret' AND "action" = 'webhook-signing-secret.provision' AND "endpointId" IS NOT NULL) OR
  ("targetType" = 'webhook-signing-secret-rotation' AND "action" LIKE 'webhook-signing-secret-rotation.%' AND "endpointId" IS NOT NULL)
),
ADD CONSTRAINT "webhook_admin_commands_replay_check" CHECK (
  ("action" LIKE '%.create' AND "targetStatus" IS NULL AND "idempotencyKey" IS NOT NULL AND "baseRevision" IS NULL) OR
  ("action" IN ('webhook-signing-secret.provision', 'webhook-signing-secret-rotation.stage') AND "targetStatus" IS NULL AND "idempotencyKey" IS NOT NULL AND "baseRevision" ~ '^[a-f0-9]{64}$') OR
  ("action" IN ('webhook-signing-secret-rotation.activate', 'webhook-signing-secret-rotation.cancel') AND "targetStatus" IS NULL AND "idempotencyKey" IS NULL AND "baseRevision" ~ '^[a-f0-9]{64}$') OR
  ("action" = 'webhook-endpoint.status.set' AND "targetStatus" IN ('active', 'suspended', 'revoked') AND "idempotencyKey" IS NULL AND "baseRevision" ~ '^[a-f0-9]{64}$') OR
  ("action" = 'webhook-subscription.status.set' AND "targetStatus" IN ('active', 'paused', 'revoked') AND "idempotencyKey" IS NULL AND "baseRevision" ~ '^[a-f0-9]{64}$')
);
