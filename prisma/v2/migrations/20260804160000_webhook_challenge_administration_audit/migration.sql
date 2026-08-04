ALTER TABLE "webhook_administration_commands"
DROP CONSTRAINT "webhook_admin_commands_action_check",
DROP CONSTRAINT "webhook_admin_commands_replay_check";

ALTER TABLE "webhook_administration_commands"
ADD CONSTRAINT "webhook_admin_commands_action_check" CHECK (
  "action" IN (
    'webhook-endpoint.create',
    'webhook-endpoint.status.set',
    'webhook-endpoint.challenge',
    'webhook-subscription.create',
    'webhook-subscription.status.set',
    'webhook-signing-secret.provision',
    'webhook-signing-secret-rotation.stage',
    'webhook-signing-secret-rotation.activate',
    'webhook-signing-secret-rotation.cancel',
    'webhook-delivery.replay',
    'webhook-event.replay'
  )
),
ADD CONSTRAINT "webhook_admin_commands_replay_check" CHECK (
  ("action" LIKE '%.create' AND "targetStatus" IS NULL AND "idempotencyKey" IS NOT NULL AND "baseRevision" IS NULL) OR
  ("action" IN ('webhook-delivery.replay', 'webhook-event.replay') AND "targetStatus" IS NULL AND "idempotencyKey" IS NOT NULL AND "baseRevision" IS NULL) OR
  ("action" = 'webhook-endpoint.challenge' AND "targetStatus" = 'active' AND "idempotencyKey" IS NULL AND "baseRevision" IS NULL) OR
  ("action" IN ('webhook-signing-secret.provision', 'webhook-signing-secret-rotation.stage') AND "targetStatus" IS NULL AND "idempotencyKey" IS NOT NULL AND "baseRevision" ~ '^[a-f0-9]{64}$') OR
  ("action" IN ('webhook-signing-secret-rotation.activate', 'webhook-signing-secret-rotation.cancel') AND "targetStatus" IS NULL AND "idempotencyKey" IS NULL AND "baseRevision" ~ '^[a-f0-9]{64}$') OR
  ("action" = 'webhook-endpoint.status.set' AND "targetStatus" IN ('active', 'suspended', 'revoked') AND "idempotencyKey" IS NULL AND "baseRevision" ~ '^[a-f0-9]{64}$') OR
  ("action" = 'webhook-subscription.status.set' AND "targetStatus" IN ('active', 'paused', 'revoked') AND "idempotencyKey" IS NULL AND "baseRevision" ~ '^[a-f0-9]{64}$')
);
