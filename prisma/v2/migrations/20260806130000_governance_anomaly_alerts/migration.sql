ALTER TABLE "governance_admissions"
  ADD COLUMN "schemaVersion" VARCHAR(64) NOT NULL
    DEFAULT 'governance-admission/v1',
  ADD COLUMN "anomalyPolicyHash" CHAR(64),
  ADD COLUMN "anomalyRecoveryBypassed" BOOLEAN NOT NULL DEFAULT FALSE,
  ADD CONSTRAINT "governance_admissions_schema_check" CHECK (
    "schemaVersion" IN (
      'governance-admission/v1', 'governance-admission/v2'
    )
  ),
  ADD CONSTRAINT "governance_admissions_anomaly_check" CHECK (
    ("schemaVersion" = 'governance-admission/v1' AND
      "anomalyPolicyHash" IS NULL AND
      "anomalyRecoveryBypassed" = FALSE) OR
    ("schemaVersion" = 'governance-admission/v2' AND
      "anomalyPolicyHash" ~ '^[a-f0-9]{64}$')
  );

ALTER TABLE "governance_alerts"
  DROP CONSTRAINT "governance_alerts_reason_check",
  ADD COLUMN "schemaVersion" VARCHAR(64) NOT NULL
    DEFAULT 'governance-alert/v1',
  ADD COLUMN "policyHash" CHAR(64),
  ADD COLUMN "anomalyRecoveryBypassed" BOOLEAN NOT NULL DEFAULT FALSE,
  ADD COLUMN "windowStartedAt" TIMESTAMPTZ(3),
  ADD COLUMN "windowEndedAt" TIMESTAMPTZ(3),
  ADD CONSTRAINT "governance_alerts_reason_check" CHECK (
    "scopeType" IN ('workspace', 'client') AND
    "reasonCode" IN (
      'RATE_LIMIT', 'CONCURRENCY_LIMIT',
      'QUOTA_EXCEEDED', 'SPEND_BUDGET_EXCEEDED',
      'REQUEST_RATE_ANOMALY', 'SPEND_RATE_ANOMALY',
      'ERROR_RATE_ANOMALY'
    )
  ),
  ADD CONSTRAINT "governance_alerts_schema_check" CHECK (
    "schemaVersion" IN ('governance-alert/v1', 'governance-alert/v2')
  ),
  ADD CONSTRAINT "governance_alerts_policy_check" CHECK (
    ("schemaVersion" = 'governance-alert/v1' AND
      "policyHash" IS NULL AND "anomalyRecoveryBypassed" = FALSE AND
      "windowStartedAt" IS NULL AND "windowEndedAt" IS NULL) OR
    ("schemaVersion" = 'governance-alert/v2' AND
      "policyHash" ~ '^[a-f0-9]{64}$' AND
      "windowStartedAt" IS NOT NULL AND "windowEndedAt" IS NOT NULL AND
      "windowStartedAt" < "windowEndedAt")
  );

CREATE INDEX "public_operations_governance_anomaly_idx"
  ON "public_operations"(
    "workspaceId", "clientId", "actorEnvironment",
    "completedAt" DESC, "status"
  ) WHERE "completedAt" IS NOT NULL;
