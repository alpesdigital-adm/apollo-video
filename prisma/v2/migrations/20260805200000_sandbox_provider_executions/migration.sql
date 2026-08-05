CREATE TABLE "sandbox_provider_executions" (
  "receiptHash" CHAR(64) NOT NULL,
  "schemaVersion" VARCHAR(64) NOT NULL,
  "workspaceId" VARCHAR(128) NOT NULL,
  "clientId" VARCHAR(80) NOT NULL,
  "environment" VARCHAR(16) NOT NULL,
  "provider" VARCHAR(64) NOT NULL,
  "operation" VARCHAR(64) NOT NULL,
  "inputHash" CHAR(64) NOT NULL,
  "outputHash" CHAR(64) NOT NULL,
  "units" INTEGER NOT NULL,
  "currency" CHAR(3) NOT NULL,
  "costMinorUnits" INTEGER NOT NULL,
  "externalCalls" INTEGER NOT NULL,
  "createdAt" TIMESTAMPTZ(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

  CONSTRAINT "sandbox_provider_executions_pkey" PRIMARY KEY ("receiptHash"),
  CONSTRAINT "sandbox_provider_executions_schema_check"
    CHECK ("schemaVersion" = 'sandbox-provider-receipt/v1'),
  CONSTRAINT "sandbox_provider_executions_environment_check"
    CHECK ("environment" = 'sandbox'),
  CONSTRAINT "sandbox_provider_executions_provider_check"
    CHECK ("provider" = 'apollo-sandbox-fake'),
  CONSTRAINT "sandbox_provider_executions_operation_check"
    CHECK ("operation" IN ('semantic-embedding')),
  CONSTRAINT "sandbox_provider_executions_units_check"
    CHECK ("units" BETWEEN 1 AND 100000),
  CONSTRAINT "sandbox_provider_executions_cost_check"
    CHECK ("currency" = 'USD' AND "costMinorUnits" BETWEEN 0 AND 1000000000),
  CONSTRAINT "sandbox_provider_executions_external_calls_check"
    CHECK ("externalCalls" = 0)
);

CREATE INDEX "sandbox_provider_executions_page_idx"
  ON "sandbox_provider_executions"("workspaceId", "createdAt" DESC, "receiptHash" DESC);

CREATE INDEX "sandbox_provider_executions_client_idx"
  ON "sandbox_provider_executions"("workspaceId", "clientId", "createdAt" DESC);

ALTER TABLE "sandbox_provider_executions"
  ADD CONSTRAINT "sandbox_provider_executions_workspace_fkey"
  FOREIGN KEY ("workspaceId") REFERENCES "workspaces"("id")
  ON DELETE CASCADE ON UPDATE CASCADE;

ALTER TABLE "sandbox_provider_executions"
  ADD CONSTRAINT "sandbox_provider_executions_client_fkey"
  FOREIGN KEY ("clientId", "workspaceId")
  REFERENCES "api_clients"("id", "workspaceId")
  ON DELETE RESTRICT ON UPDATE CASCADE;
