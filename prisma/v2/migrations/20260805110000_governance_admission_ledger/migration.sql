CREATE TABLE "governance_policies" (
  "id" VARCHAR(128) NOT NULL,
  "workspaceId" VARCHAR(128) NOT NULL,
  "scopeType" VARCHAR(16) NOT NULL,
  "scopeId" VARCHAR(128) NOT NULL,
  "environment" VARCHAR(16) NOT NULL,
  "requestsPerMinute" INTEGER NOT NULL,
  "maxConcurrency" INTEGER NOT NULL,
  "quotaUnits" INTEGER NOT NULL,
  "spendBudgetMinorUnits" INTEGER NOT NULL,
  "revision" CHAR(64) NOT NULL,
  "updatedByClientId" VARCHAR(80) NOT NULL,
  "createdAt" TIMESTAMPTZ(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
  "updatedAt" TIMESTAMPTZ(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
  CONSTRAINT "governance_policies_pkey" PRIMARY KEY ("id"),
  CONSTRAINT "governance_policies_scope_check" CHECK (
    ("scopeType" = 'workspace' AND "scopeId" = "workspaceId") OR
    "scopeType" = 'client'
  ),
  CONSTRAINT "governance_policies_environment_check" CHECK (
    "environment" IN ('sandbox', 'production')
  ),
  CONSTRAINT "governance_policies_limits_check" CHECK (
    "requestsPerMinute" >= 1 AND "maxConcurrency" >= 1 AND
    "quotaUnits" >= 0 AND "spendBudgetMinorUnits" >= 0 AND
    "requestsPerMinute" <= 2000000000 AND
    "maxConcurrency" <= 2000000000 AND
    "quotaUnits" <= 2000000000 AND
    "spendBudgetMinorUnits" <= 2000000000
  ),
  CONSTRAINT "governance_policies_revision_check" CHECK (
    "revision" ~ '^[a-f0-9]{64}$'
  )
);

CREATE UNIQUE INDEX "governance_policies_scope_key"
  ON "governance_policies"(
    "workspaceId", "scopeType", "scopeId", "environment"
  );
CREATE INDEX "governance_policies_lookup_idx"
  ON "governance_policies"("workspaceId", "environment", "scopeType");
ALTER TABLE "governance_policies"
  ADD CONSTRAINT "governance_policies_workspace_fkey"
  FOREIGN KEY ("workspaceId") REFERENCES "workspaces"("id")
  ON DELETE CASCADE ON UPDATE CASCADE;

CREATE TABLE "governance_admissions" (
  "id" VARCHAR(128) NOT NULL,
  "workspaceId" VARCHAR(128) NOT NULL,
  "clientId" VARCHAR(80) NOT NULL,
  "capabilityId" VARCHAR(128) NOT NULL,
  "environment" VARCHAR(16) NOT NULL,
  "operationKind" VARCHAR(16) NOT NULL,
  "costClass" VARCHAR(16) NOT NULL,
  "allowed" BOOLEAN NOT NULL,
  "reasonsJson" TEXT NOT NULL,
  "workspaceDecisionJson" TEXT NOT NULL,
  "clientDecisionJson" TEXT NOT NULL,
  "requestedRequests" INTEGER NOT NULL,
  "requestedConcurrency" INTEGER NOT NULL,
  "requestedQuotaUnits" INTEGER NOT NULL,
  "requestedSpendMinorUnits" INTEGER NOT NULL,
  "admissionHash" CHAR(64) NOT NULL,
  "createdAt" TIMESTAMPTZ(3) NOT NULL,
  CONSTRAINT "governance_admissions_pkey" PRIMARY KEY ("id"),
  CONSTRAINT "governance_admissions_classification_check" CHECK (
    "environment" IN ('sandbox', 'production') AND
    "operationKind" IN ('query', 'command', 'preflight', 'job') AND
    "costClass" IN ('free', 'low', 'medium', 'high', 'variable') AND
    "capabilityId" ~ '^apollo\.[a-z0-9_.-]{2,120}$'
  ),
  CONSTRAINT "governance_admissions_decision_check" CHECK (
    jsonb_typeof("reasonsJson"::jsonb) = 'array' AND
    jsonb_typeof("workspaceDecisionJson"::jsonb) = 'object' AND
    jsonb_typeof("clientDecisionJson"::jsonb) = 'object' AND
    ("allowed" = (jsonb_array_length("reasonsJson"::jsonb) = 0))
  ),
  CONSTRAINT "governance_admissions_counters_check" CHECK (
    "requestedRequests" >= 0 AND "requestedConcurrency" >= 0 AND
    "requestedQuotaUnits" >= 0 AND "requestedSpendMinorUnits" >= 0 AND
    "requestedRequests" <= 2000000000 AND
    "requestedConcurrency" <= 2000000000 AND
    "requestedQuotaUnits" <= 2000000000 AND
    "requestedSpendMinorUnits" <= 2000000000
  ),
  CONSTRAINT "governance_admissions_hash_check" CHECK (
    "admissionHash" ~ '^[a-f0-9]{64}$'
  )
);

CREATE UNIQUE INDEX "governance_admissions_hash_key"
  ON "governance_admissions"("admissionHash");
CREATE INDEX "governance_admissions_page_idx"
  ON "governance_admissions"(
    "workspaceId", "createdAt" DESC, "id" DESC
  );
CREATE INDEX "governance_admissions_client_idx"
  ON "governance_admissions"(
    "workspaceId", "clientId", "createdAt" DESC
  );
CREATE INDEX "governance_admissions_window_idx"
  ON "governance_admissions"(
    "workspaceId", "clientId", "environment", "createdAt" DESC
  );
ALTER TABLE "governance_admissions"
  ADD CONSTRAINT "governance_admissions_workspace_fkey"
  FOREIGN KEY ("workspaceId") REFERENCES "workspaces"("id")
  ON DELETE CASCADE ON UPDATE CASCADE;

CREATE TABLE "governance_alerts" (
  "alertHash" CHAR(64) NOT NULL,
  "workspaceId" VARCHAR(128) NOT NULL,
  "clientId" VARCHAR(80) NOT NULL,
  "admissionId" VARCHAR(128) NOT NULL,
  "scopeType" VARCHAR(16) NOT NULL,
  "reasonCode" VARCHAR(32) NOT NULL,
  "observed" INTEGER NOT NULL,
  "threshold" INTEGER NOT NULL,
  "createdAt" TIMESTAMPTZ(3) NOT NULL,
  CONSTRAINT "governance_alerts_pkey" PRIMARY KEY ("alertHash"),
  CONSTRAINT "governance_alerts_reason_check" CHECK (
    "scopeType" IN ('workspace', 'client') AND
    "reasonCode" IN (
      'RATE_LIMIT', 'CONCURRENCY_LIMIT',
      'QUOTA_EXCEEDED', 'SPEND_BUDGET_EXCEEDED'
    )
  ),
  CONSTRAINT "governance_alerts_values_check" CHECK (
    "observed" >= 0 AND "threshold" >= 0 AND
    "observed" <= 2000000000 AND "threshold" <= 2000000000
  )
);

CREATE INDEX "governance_alerts_workspace_idx"
  ON "governance_alerts"("workspaceId", "createdAt" DESC);
CREATE INDEX "governance_alerts_client_scope_reason_idx"
  ON "governance_alerts"(
    "workspaceId", "clientId", "scopeType", "reasonCode", "createdAt" DESC
  );
ALTER TABLE "governance_alerts"
  ADD CONSTRAINT "governance_alerts_workspace_fkey"
  FOREIGN KEY ("workspaceId") REFERENCES "workspaces"("id")
  ON DELETE CASCADE ON UPDATE CASCADE;
ALTER TABLE "governance_alerts"
  ADD CONSTRAINT "governance_alerts_admission_fkey"
  FOREIGN KEY ("admissionId") REFERENCES "governance_admissions"("id")
  ON DELETE CASCADE ON UPDATE CASCADE;
