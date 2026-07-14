CREATE TABLE "public_operations" (
  "id" VARCHAR(128) NOT NULL,
  "workspaceId" VARCHAR(128) NOT NULL,
  "clientId" VARCHAR(80) NOT NULL,
  "type" VARCHAR(64) NOT NULL,
  "status" VARCHAR(32) NOT NULL,
  "phase" VARCHAR(64) NOT NULL,
  "targetType" VARCHAR(64) NOT NULL,
  "targetId" VARCHAR(128) NOT NULL,
  "progressCompleted" INTEGER,
  "progressTotal" INTEGER,
  "progressUnit" VARCHAR(64),
  "cancelable" BOOLEAN NOT NULL DEFAULT true,
  "retryable" BOOLEAN NOT NULL DEFAULT false,
  "attempt" INTEGER NOT NULL DEFAULT 0,
  "maxAttempts" INTEGER NOT NULL DEFAULT 3,
  "resultJson" TEXT,
  "errorCode" VARCHAR(64),
  "errorMessage" TEXT,
  "errorRetryable" BOOLEAN,
  "idempotencyKey" VARCHAR(128) NOT NULL,
  "requestFingerprint" CHAR(64) NOT NULL,
  "createdAt" TIMESTAMPTZ(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
  "updatedAt" TIMESTAMPTZ(3) NOT NULL,
  "startedAt" TIMESTAMPTZ(3),
  "completedAt" TIMESTAMPTZ(3),
  CONSTRAINT "public_operations_pkey" PRIMARY KEY ("id"),
  CONSTRAINT "public_operations_type_check" CHECK ("type" = 'artifact-render'),
  CONSTRAINT "public_operations_status_check" CHECK (
    "status" IN ('queued', 'running', 'waiting', 'retrying', 'succeeded', 'failed', 'canceled')
  ),
  CONSTRAINT "public_operations_phase_check" CHECK (
    "phase" IN ('queued', 'materializing', 'rendering', 'verifying', 'persisting', 'waiting', 'retrying', 'completed', 'failed', 'canceled')
  ),
  CONSTRAINT "public_operations_target_check" CHECK ("targetType" = 'media-artifact'),
  CONSTRAINT "public_operations_progress_check" CHECK (
    (
      "progressCompleted" IS NULL
      AND "progressTotal" IS NULL
      AND "progressUnit" IS NULL
    )
    OR (
      "progressCompleted" IS NOT NULL
      AND "progressCompleted" >= 0
      AND ("progressTotal" IS NULL OR ("progressTotal" > 0 AND "progressCompleted" <= "progressTotal"))
      AND ("progressUnit" IS NULL OR "progressUnit" ~ '^[a-z0-9][a-z0-9._-]{0,63}$')
    )
  ),
  CONSTRAINT "public_operations_attempt_check" CHECK (
    "attempt" >= 0 AND "maxAttempts" > 0 AND "attempt" <= "maxAttempts"
  ),
  CONSTRAINT "public_operations_fingerprint_check" CHECK (
    "requestFingerprint" ~ '^[a-f0-9]{64}$'
  ),
  CONSTRAINT "public_operations_result_check" CHECK (
    "resultJson" IS NULL OR jsonb_typeof("resultJson"::jsonb) = 'object'
  ),
  CONSTRAINT "public_operations_error_check" CHECK (
    (
      "errorCode" IS NULL
      AND "errorMessage" IS NULL
      AND "errorRetryable" IS NULL
    )
    OR (
      "errorCode" ~ '^[a-z0-9][a-z0-9._-]{0,63}$'
      AND length("errorMessage") BETWEEN 1 AND 500
      AND "errorRetryable" IS NOT NULL
    )
  ),
  CONSTRAINT "public_operations_state_check" CHECK (
    (
      "status" = 'queued'
      AND "phase" = 'queued'
      AND "attempt" = 0
      AND "startedAt" IS NULL
      AND "completedAt" IS NULL
      AND "resultJson" IS NULL
      AND "errorCode" IS NULL
      AND "cancelable" = true
      AND "retryable" = false
    )
    OR (
      "status" IN ('running', 'waiting', 'retrying')
      AND "attempt" > 0
      AND "startedAt" IS NOT NULL
      AND "completedAt" IS NULL
      AND "resultJson" IS NULL
      AND "errorCode" IS NULL
      AND "cancelable" = true
    )
    OR (
      "status" = 'succeeded'
      AND "phase" = 'completed'
      AND "startedAt" IS NOT NULL
      AND "completedAt" IS NOT NULL
      AND "resultJson" IS NOT NULL
      AND "errorCode" IS NULL
      AND "cancelable" = false
      AND "retryable" = false
    )
    OR (
      "status" = 'failed'
      AND "phase" = 'failed'
      AND "startedAt" IS NOT NULL
      AND "completedAt" IS NOT NULL
      AND "resultJson" IS NULL
      AND "errorCode" IS NOT NULL
      AND "cancelable" = false
      AND "retryable" = "errorRetryable"
    )
    OR (
      "status" = 'canceled'
      AND "phase" = 'canceled'
      AND "completedAt" IS NOT NULL
      AND "resultJson" IS NULL
      AND "errorCode" IS NULL
      AND "cancelable" = false
      AND "retryable" = false
    )
  ),
  CONSTRAINT "public_operations_dates_check" CHECK (
    "updatedAt" >= "createdAt"
    AND ("startedAt" IS NULL OR "startedAt" >= "createdAt")
    AND ("completedAt" IS NULL OR "completedAt" >= COALESCE("startedAt", "createdAt"))
  )
);

CREATE TABLE "artifact_render_operations" (
  "operationId" VARCHAR(128) NOT NULL,
  "workspaceId" VARCHAR(128) NOT NULL,
  "artifactId" VARCHAR(128) NOT NULL,
  "manifestId" VARCHAR(128) NOT NULL,
  "authorizationId" VARCHAR(128) NOT NULL,
  "inputHash" CHAR(64) NOT NULL,
  CONSTRAINT "artifact_render_operations_pkey" PRIMARY KEY ("operationId"),
  CONSTRAINT "artifact_render_operations_hash_check" CHECK (
    "inputHash" ~ '^[a-f0-9]{64}$'
  )
);

CREATE UNIQUE INDEX "public_operations_id_workspaceId_key"
  ON "public_operations"("id", "workspaceId");
CREATE UNIQUE INDEX "public_operations_workspaceId_clientId_idempotencyKey_key"
  ON "public_operations"("workspaceId", "clientId", "idempotencyKey");
CREATE INDEX "public_operations_workspaceId_status_updatedAt_idx"
  ON "public_operations"("workspaceId", "status", "updatedAt" DESC);
CREATE INDEX "public_operations_workspaceId_type_createdAt_idx"
  ON "public_operations"("workspaceId", "type", "createdAt" DESC);
CREATE INDEX "public_operations_workspaceId_targetType_targetId_idx"
  ON "public_operations"("workspaceId", "targetType", "targetId");
CREATE UNIQUE INDEX "artifact_render_operations_operationId_workspaceId_key"
  ON "artifact_render_operations"("operationId", "workspaceId");
CREATE INDEX "artifact_render_operations_workspaceId_artifactId_manifestI_idx"
  ON "artifact_render_operations"("workspaceId", "artifactId", "manifestId");
CREATE INDEX "artifact_render_operations_workspaceId_authorizationId_idx"
  ON "artifact_render_operations"("workspaceId", "authorizationId");

ALTER TABLE "public_operations"
  ADD CONSTRAINT "public_operations_workspaceId_fkey" FOREIGN KEY ("workspaceId") REFERENCES "workspaces"("id")
  ON DELETE RESTRICT ON UPDATE CASCADE,
  ADD CONSTRAINT "public_operations_clientId_workspaceId_fkey" FOREIGN KEY ("clientId", "workspaceId") REFERENCES "api_clients"("id", "workspaceId")
  ON DELETE RESTRICT ON UPDATE CASCADE;

ALTER TABLE "artifact_render_operations"
  ADD CONSTRAINT "artifact_render_operations_workspaceId_fkey" FOREIGN KEY ("workspaceId") REFERENCES "workspaces"("id")
  ON DELETE RESTRICT ON UPDATE CASCADE,
  ADD CONSTRAINT "artifact_render_operations_operationId_workspaceId_fkey" FOREIGN KEY ("operationId", "workspaceId") REFERENCES "public_operations"("id", "workspaceId")
  ON DELETE CASCADE ON UPDATE CASCADE,
  ADD CONSTRAINT "artifact_render_operations_artifactId_workspaceId_fkey" FOREIGN KEY ("artifactId", "workspaceId") REFERENCES "media_artifacts"("id", "workspaceId")
  ON DELETE RESTRICT ON UPDATE CASCADE,
  ADD CONSTRAINT "artifact_render_operations_manifestId_workspaceId_fkey" FOREIGN KEY ("manifestId", "workspaceId") REFERENCES "media_artifact_manifests"("id", "workspaceId")
  ON DELETE RESTRICT ON UPDATE CASCADE,
  ADD CONSTRAINT "artifact_render_operations_authorizationId_workspaceId_fkey" FOREIGN KEY ("authorizationId", "workspaceId") REFERENCES "materialization_authorizations"("id", "workspaceId")
  ON DELETE RESTRICT ON UPDATE CASCADE;
