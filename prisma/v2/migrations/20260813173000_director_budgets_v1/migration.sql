CREATE TABLE "director_budgets" (
  "id" VARCHAR(128) NOT NULL,
  "workspaceId" VARCHAR(128) NOT NULL,
  "projectId" VARCHAR(128) NOT NULL,
  "runId" VARCHAR(128) NOT NULL,
  "revision" INTEGER NOT NULL,
  "status" VARCHAR(32) NOT NULL,
  "limitsJson" TEXT NOT NULL,
  "reservedJson" TEXT NOT NULL,
  "actualJson" TEXT NOT NULL,
  "bestResultJson" TEXT,
  "exhaustedDimension" VARCHAR(32),
  "createdAt" TIMESTAMPTZ(3) NOT NULL,
  "updatedAt" TIMESTAMPTZ(3) NOT NULL,
  CONSTRAINT "director_budgets_pkey" PRIMARY KEY ("id"),
  CONSTRAINT "director_budgets_state_check" CHECK (
    "revision" >= 0 AND
    "status" IN ('active', 'budget_exhausted', 'cancelled', 'completed') AND
    "updatedAt" >= "createdAt" AND
    jsonb_typeof("limitsJson"::jsonb) = 'object' AND
    jsonb_typeof("reservedJson"::jsonb) = 'object' AND
    jsonb_typeof("actualJson"::jsonb) = 'object' AND
    ("bestResultJson" IS NULL OR jsonb_typeof("bestResultJson"::jsonb) = 'object') AND
    ("exhaustedDimension" IS NULL OR "exhaustedDimension" IN (
      'spendMinorUnits', 'elapsedMs', 'tokens', 'generations', 'candidates', 'criticRounds'
    )) AND
    ("status" <> 'budget_exhausted' OR "exhaustedDimension" IS NOT NULL)
  )
);

CREATE TABLE "director_budget_reservations" (
  "id" VARCHAR(128) NOT NULL,
  "budgetId" VARCHAR(128) NOT NULL,
  "workspaceId" VARCHAR(128) NOT NULL,
  "projectId" VARCHAR(128) NOT NULL,
  "operationKind" VARCHAR(128) NOT NULL,
  "status" VARCHAR(16) NOT NULL,
  "estimateJson" TEXT NOT NULL,
  "actualJson" TEXT,
  "overrunJson" TEXT,
  "candidateJson" TEXT,
  "createdAt" TIMESTAMPTZ(3) NOT NULL,
  "settledAt" TIMESTAMPTZ(3),
  CONSTRAINT "director_budget_reservations_pkey" PRIMARY KEY ("id"),
  CONSTRAINT "director_budget_reservations_state_check" CHECK (
    "status" IN ('reserved', 'settled', 'cancelled') AND
    jsonb_typeof("estimateJson"::jsonb) = 'object' AND
    ("actualJson" IS NULL OR jsonb_typeof("actualJson"::jsonb) = 'object') AND
    ("overrunJson" IS NULL OR jsonb_typeof("overrunJson"::jsonb) = 'object') AND
    ("candidateJson" IS NULL OR jsonb_typeof("candidateJson"::jsonb) = 'object') AND
    (("status" = 'reserved') = ("settledAt" IS NULL)) AND
    (("status" = 'reserved') = ("actualJson" IS NULL)) AND
    ("settledAt" IS NULL OR "settledAt" >= "createdAt")
  )
);

CREATE TABLE "director_budget_events" (
  "id" VARCHAR(128) NOT NULL,
  "budgetId" VARCHAR(128) NOT NULL,
  "reservationId" VARCHAR(128),
  "workspaceId" VARCHAR(128) NOT NULL,
  "projectId" VARCHAR(128) NOT NULL,
  "action" VARCHAR(32) NOT NULL,
  "baseRevision" INTEGER NOT NULL,
  "resultRevision" INTEGER NOT NULL,
  "idempotencyKey" VARCHAR(128) NOT NULL,
  "requestFingerprint" CHAR(64) NOT NULL,
  "actorClientId" VARCHAR(80) NOT NULL,
  "actorCredentialId" VARCHAR(128) NOT NULL,
  "actorEnvironment" VARCHAR(16) NOT NULL,
  "actorAuthenticationKind" VARCHAR(16) NOT NULL,
  "actorContextHash" CHAR(64) NOT NULL,
  "delegatedUserId" VARCHAR(128),
  "delegatedIdentityId" VARCHAR(128),
  "workspaceRole" VARCHAR(32),
  "estimateJson" TEXT,
  "actualJson" TEXT,
  "outcome" VARCHAR(64) NOT NULL,
  "resultJson" TEXT NOT NULL,
  "resultHash" CHAR(64) NOT NULL,
  "occurredAt" TIMESTAMPTZ(3) NOT NULL,
  CONSTRAINT "director_budget_events_pkey" PRIMARY KEY ("id"),
  CONSTRAINT "director_budget_events_state_check" CHECK (
    "action" IN ('create', 'reserve', 'settle', 'cancel-reservation', 'cancel-run', 'conclude') AND
    "baseRevision" >= 0 AND "resultRevision" = "baseRevision" + 1 AND
    "requestFingerprint" ~ '^[0-9a-f]{64}$' AND
    "actorContextHash" ~ '^[0-9a-f]{64}$' AND
    ("estimateJson" IS NULL OR jsonb_typeof("estimateJson"::jsonb) = 'object') AND
    ("actualJson" IS NULL OR jsonb_typeof("actualJson"::jsonb) = 'object') AND
    jsonb_typeof("resultJson"::jsonb) = 'object' AND
    "resultHash" ~ '^[0-9a-f]{64}$'
  )
);

CREATE UNIQUE INDEX "director_budgets_id_workspaceId_key" ON "director_budgets"("id", "workspaceId");
CREATE UNIQUE INDEX "director_budgets_workspaceId_projectId_runId_key" ON "director_budgets"("workspaceId", "projectId", "runId");
CREATE INDEX "director_budgets_workspaceId_projectId_updatedAt_id_idx" ON "director_budgets"("workspaceId", "projectId", "updatedAt" DESC, "id");
CREATE INDEX "director_budgets_workspaceId_projectId_status_idx" ON "director_budgets"("workspaceId", "projectId", "status");
CREATE UNIQUE INDEX "director_budget_reservations_id_workspaceId_key" ON "director_budget_reservations"("id", "workspaceId");
CREATE INDEX "director_budget_reservations_workspaceId_projectId_budgetId_idx" ON "director_budget_reservations"("workspaceId", "projectId", "budgetId", "status");
CREATE UNIQUE INDEX "director_budget_events_id_workspaceId_key" ON "director_budget_events"("id", "workspaceId");
CREATE UNIQUE INDEX "director_budget_events_workspaceId_budgetId_idempotencyKey_key" ON "director_budget_events"("workspaceId", "budgetId", "idempotencyKey");
CREATE INDEX "director_budget_events_workspaceId_projectId_budgetId_occur_idx" ON "director_budget_events"("workspaceId", "projectId", "budgetId", "occurredAt", "id");
CREATE INDEX "director_budget_events_workspaceId_actorContextHash_occurre_idx" ON "director_budget_events"("workspaceId", "actorContextHash", "occurredAt" DESC);

ALTER TABLE "director_budgets" ADD CONSTRAINT "director_budgets_workspaceId_fkey" FOREIGN KEY ("workspaceId") REFERENCES "workspaces"("id") ON DELETE RESTRICT ON UPDATE CASCADE;
ALTER TABLE "director_budgets" ADD CONSTRAINT "director_budgets_projectId_workspaceId_fkey" FOREIGN KEY ("projectId", "workspaceId") REFERENCES "projects"("id", "workspaceId") ON DELETE CASCADE ON UPDATE CASCADE;
ALTER TABLE "director_budget_reservations" ADD CONSTRAINT "director_budget_reservations_budgetId_workspaceId_fkey" FOREIGN KEY ("budgetId", "workspaceId") REFERENCES "director_budgets"("id", "workspaceId") ON DELETE CASCADE ON UPDATE CASCADE;
ALTER TABLE "director_budget_reservations" ADD CONSTRAINT "director_budget_reservations_workspaceId_fkey" FOREIGN KEY ("workspaceId") REFERENCES "workspaces"("id") ON DELETE RESTRICT ON UPDATE CASCADE;
ALTER TABLE "director_budget_reservations" ADD CONSTRAINT "director_budget_reservations_projectId_workspaceId_fkey" FOREIGN KEY ("projectId", "workspaceId") REFERENCES "projects"("id", "workspaceId") ON DELETE CASCADE ON UPDATE CASCADE;
ALTER TABLE "director_budget_events" ADD CONSTRAINT "director_budget_events_budgetId_workspaceId_fkey" FOREIGN KEY ("budgetId", "workspaceId") REFERENCES "director_budgets"("id", "workspaceId") ON DELETE CASCADE ON UPDATE CASCADE;
ALTER TABLE "director_budget_events" ADD CONSTRAINT "director_budget_events_reservationId_workspaceId_fkey" FOREIGN KEY ("reservationId", "workspaceId") REFERENCES "director_budget_reservations"("id", "workspaceId") ON DELETE RESTRICT ON UPDATE CASCADE;
ALTER TABLE "director_budget_events" ADD CONSTRAINT "director_budget_events_workspaceId_fkey" FOREIGN KEY ("workspaceId") REFERENCES "workspaces"("id") ON DELETE RESTRICT ON UPDATE CASCADE;
ALTER TABLE "director_budget_events" ADD CONSTRAINT "director_budget_events_projectId_workspaceId_fkey" FOREIGN KEY ("projectId", "workspaceId") REFERENCES "projects"("id", "workspaceId") ON DELETE CASCADE ON UPDATE CASCADE;
ALTER TABLE "director_budget_events" ADD CONSTRAINT "director_budget_events_actorClientId_workspaceId_fkey" FOREIGN KEY ("actorClientId", "workspaceId") REFERENCES "api_clients"("id", "workspaceId") ON DELETE RESTRICT ON UPDATE CASCADE;
