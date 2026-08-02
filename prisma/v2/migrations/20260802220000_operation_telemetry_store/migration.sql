CREATE TABLE "operation_telemetry_events" (
  "eventHash" CHAR(64) PRIMARY KEY,
  "workspaceId" VARCHAR(128) NOT NULL,
  "schemaVersion" VARCHAR(64) NOT NULL,
  "event" VARCHAR(64) NOT NULL,
  "occurredAt" TIMESTAMPTZ(3) NOT NULL,
  "traceId" VARCHAR(100) NOT NULL,
  "jobId" VARCHAR(128) NOT NULL,
  "projectId" VARCHAR(128),
  "operationType" VARCHAR(64) NOT NULL,
  "status" VARCHAR(32),
  "phase" VARCHAR(64),
  "attempt" INTEGER NOT NULL,
  "spanId" VARCHAR(128),
  "spanKind" VARCHAR(32),
  "spanName" VARCHAR(80),
  "queueWaitMs" BIGINT,
  "runDurationMs" BIGINT,
  "durationMs" BIGINT,
  "inputBytes" BIGINT,
  "outputBytes" BIGINT,
  "inputTokens" BIGINT,
  "outputTokens" BIGINT,
  "costMinorUnits" BIGINT,
  "createdAt" TIMESTAMPTZ(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
  CONSTRAINT "operation_telemetry_events_attempt_check" CHECK ("attempt" >= 0),
  CONSTRAINT "operation_telemetry_events_shape_check" CHECK (
    ("schemaVersion" = 'public-operation-telemetry/v1' AND "event" IN ('operation.created', 'operation.replayed', 'operation.claimed', 'operation.heartbeat', 'operation.phase-advanced', 'operation.waiting', 'operation.resumed', 'operation.succeeded', 'operation.retrying', 'operation.failed', 'operation.canceled', 'operation.retry-requested') AND "status" IS NOT NULL AND "phase" IS NOT NULL AND "spanId" IS NULL AND "spanKind" IS NULL AND "spanName" IS NULL AND "durationMs" IS NULL AND "inputBytes" IS NULL AND "outputBytes" IS NULL AND "inputTokens" IS NULL AND "outputTokens" IS NULL AND "costMinorUnits" IS NULL)
    OR
    ("schemaVersion" = 'public-operation-span-telemetry/v1' AND "event" IN ('operation.span-started', 'operation.span-succeeded', 'operation.span-failed') AND "status" IS NULL AND "phase" IS NULL AND "queueWaitMs" IS NULL AND "runDurationMs" IS NULL AND "spanId" IS NOT NULL AND "spanKind" IN ('provider', 'renderer') AND "spanName" IS NOT NULL)
  ),
  CONSTRAINT "operation_telemetry_events_metrics_check" CHECK (
    COALESCE("queueWaitMs", 0) >= 0 AND COALESCE("runDurationMs", 0) >= 0 AND COALESCE("durationMs", 0) >= 0 AND
    COALESCE("inputBytes", 0) >= 0 AND COALESCE("outputBytes", 0) >= 0 AND COALESCE("inputTokens", 0) >= 0 AND
    COALESCE("outputTokens", 0) >= 0 AND COALESCE("costMinorUnits", 0) >= 0
  )
);

ALTER TABLE "operation_telemetry_events"
  ADD CONSTRAINT "operation_telemetry_events_workspaceId_fkey"
  FOREIGN KEY ("workspaceId") REFERENCES "workspaces"("id") ON DELETE CASCADE ON UPDATE CASCADE;

CREATE INDEX "operation_telemetry_events_workspaceId_occurredAt_idx" ON "operation_telemetry_events"("workspaceId", "occurredAt" DESC);
CREATE INDEX "operation_telemetry_events_workspaceId_event_occurredAt_idx" ON "operation_telemetry_events"("workspaceId", "event", "occurredAt" DESC);

CREATE TABLE "operation_telemetry_alerts" (
  "alertHash" CHAR(64) PRIMARY KEY,
  "workspaceId" VARCHAR(128) NOT NULL,
  "schemaVersion" VARCHAR(64) NOT NULL,
  "occurredAt" TIMESTAMPTZ(3) NOT NULL,
  "alertKind" VARCHAR(64) NOT NULL,
  "severity" VARCHAR(16) NOT NULL,
  "traceId" VARCHAR(100) NOT NULL,
  "jobId" VARCHAR(128) NOT NULL,
  "projectId" VARCHAR(128),
  "operationType" VARCHAR(64) NOT NULL,
  "observed" BIGINT NOT NULL,
  "threshold" BIGINT NOT NULL,
  "createdAt" TIMESTAMPTZ(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
  CONSTRAINT "operation_telemetry_alerts_values_check" CHECK ("observed" >= 0 AND "threshold" >= 1),
  CONSTRAINT "operation_telemetry_alerts_shape_check" CHECK (
    "schemaVersion" = 'public-operation-alert/v1' AND
    "alertKind" IN ('operation-failed', 'queue-wait-high', 'run-duration-high', 'span-duration-high', 'cost-high') AND
    "severity" IN ('warning', 'critical')
  )
);

ALTER TABLE "operation_telemetry_alerts"
  ADD CONSTRAINT "operation_telemetry_alerts_workspaceId_fkey"
  FOREIGN KEY ("workspaceId") REFERENCES "workspaces"("id") ON DELETE CASCADE ON UPDATE CASCADE;

CREATE INDEX "operation_telemetry_alerts_workspaceId_occurredAt_idx" ON "operation_telemetry_alerts"("workspaceId", "occurredAt" DESC);
CREATE INDEX "operation_telemetry_alerts_workspaceId_severity_occurredAt_idx" ON "operation_telemetry_alerts"("workspaceId", "severity", "occurredAt" DESC);
CREATE INDEX "operation_telemetry_alerts_workspaceId_alertKind_occurredAt_idx" ON "operation_telemetry_alerts"("workspaceId", "alertKind", "occurredAt" DESC);
