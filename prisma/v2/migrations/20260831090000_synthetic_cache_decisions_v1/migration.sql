-- Synthetic cache decision ledger: the durable, content-addressed record of
-- every decision the synthetic cache took, including the ones that produced no
-- generation at all (a revoked consent, an in-flight twin) and therefore had
-- nowhere to live before.
--
-- The ledger stores hashes and identifiers only: the script text, the consent
-- evidence and every provider secret stay out of it by construction.

CREATE TABLE "synthetic_cache_decisions" (
  "id" VARCHAR(128) NOT NULL,
  "workspaceId" VARCHAR(128) NOT NULL,
  "projectId" VARCHAR(128) NOT NULL,
  "schemaVersion" VARCHAR(64) NOT NULL,
  "operation" VARCHAR(32) NOT NULL,
  "cacheKey" CHAR(64) NOT NULL,
  "cacheKeyVersion" VARCHAR(64) NOT NULL,
  "outcome" VARCHAR(24) NOT NULL,
  "reasonCode" VARCHAR(48) NOT NULL,
  "reason" VARCHAR(500) NOT NULL,
  "candidateGenerationId" VARCHAR(128),
  "candidateMasterId" VARCHAR(128),
  "policyVersion" VARCHAR(128) NOT NULL,
  "criticReportHash" CHAR(64),
  "estimatedSavingMinorUnits" INTEGER NOT NULL,
  "avoidedCostMinorUnits" INTEGER NOT NULL,
  "currency" CHAR(3) NOT NULL,
  "subjectHash" CHAR(64) NOT NULL,
  "decisionHash" CHAR(64) NOT NULL,
  "decidedAt" TIMESTAMPTZ(3) NOT NULL,
  CONSTRAINT "synthetic_cache_decisions_pkey" PRIMARY KEY ("id"),
  CONSTRAINT "synthetic_cache_decisions_operation_check"
    CHECK ("operation" IN ('tts', 'audio-avatar')),
  CONSTRAINT "synthetic_cache_decisions_outcome_check"
    CHECK ("outcome" IN ('hit', 'miss', 'forced-regenerate', 'blocked')),
  CONSTRAINT "synthetic_cache_decisions_reason_code_check"
    CHECK ("reasonCode" IN (
      'CACHE_HIT_ELIGIBLE', 'CACHE_MISS_NO_CANDIDATE', 'CANDIDATE_BLOB_UNAVAILABLE',
      'CANDIDATE_CRITIC_REJECTED', 'CANDIDATE_RIGHTS_BLOCKED', 'CONSENT_REVOKED',
      'MUST_REGENERATE', 'IN_FLIGHT_TWIN'
    )),
  CONSTRAINT "synthetic_cache_decisions_reason_length_check"
    CHECK (char_length("reason") BETWEEN 3 AND 500),
  CONSTRAINT "synthetic_cache_decisions_amount_check"
    CHECK ("estimatedSavingMinorUnits" >= 0 AND "avoidedCostMinorUnits" >= 0
      AND "estimatedSavingMinorUnits" >= "avoidedCostMinorUnits"),
  -- Only a real reuse avoided money, and it can only have reused a candidate
  -- that exists: the database refuses a hit that names neither.
  CONSTRAINT "synthetic_cache_decisions_hit_check"
    CHECK ("outcome" <> 'hit' OR (
      ("candidateGenerationId" IS NOT NULL OR "candidateMasterId" IS NOT NULL)
      AND "avoidedCostMinorUnits" > 0
    )),
  CONSTRAINT "synthetic_cache_decisions_non_hit_cost_check"
    CHECK ("outcome" = 'hit' OR "avoidedCostMinorUnits" = 0),
  -- A block reused nothing, so it must never point at a reusable candidate.
  CONSTRAINT "synthetic_cache_decisions_blocked_check"
    CHECK ("outcome" <> 'blocked' OR (
      "candidateGenerationId" IS NULL AND "candidateMasterId" IS NULL
    ))
);

CREATE UNIQUE INDEX "synthetic_cache_decisions_id_workspace_key"
  ON "synthetic_cache_decisions"("id", "workspaceId");
-- Content-addressed idempotency: a replayed decision never books its economy
-- a second time.
CREATE UNIQUE INDEX "synthetic_cache_decisions_workspace_hash_key"
  ON "synthetic_cache_decisions"("workspaceId", "decisionHash");

CREATE INDEX "synthetic_cache_decisions_workspace_key_decided_idx"
  ON "synthetic_cache_decisions"("workspaceId", "cacheKey", "decidedAt" DESC);
CREATE INDEX "synthetic_cache_decisions_workspace_project_decided_idx"
  ON "synthetic_cache_decisions"("workspaceId", "projectId", "decidedAt" DESC);
CREATE INDEX "synthetic_cache_decisions_workspace_outcome_idx"
  ON "synthetic_cache_decisions"("workspaceId", "outcome");

ALTER TABLE "synthetic_cache_decisions" ADD CONSTRAINT "synthetic_cache_decisions_workspaceId_fkey"
  FOREIGN KEY ("workspaceId") REFERENCES "workspaces"("id") ON DELETE RESTRICT ON UPDATE CASCADE;
ALTER TABLE "synthetic_cache_decisions" ADD CONSTRAINT "synthetic_cache_decisions_projectId_workspaceId_fkey"
  FOREIGN KEY ("projectId", "workspaceId") REFERENCES "projects"("id", "workspaceId") ON DELETE CASCADE ON UPDATE CASCADE;
-- Truncated to PostgreSQL's 63-byte identifier limit exactly as Prisma names it.
ALTER TABLE "synthetic_cache_decisions" ADD CONSTRAINT "synthetic_cache_decisions_candidateGenerationId_workspaceI_fkey"
  FOREIGN KEY ("candidateGenerationId", "workspaceId") REFERENCES "synthetic_block_generations"("id", "workspaceId") ON DELETE RESTRICT ON UPDATE CASCADE;
ALTER TABLE "synthetic_cache_decisions" ADD CONSTRAINT "synthetic_cache_decisions_candidateMasterId_workspaceId_fkey"
  FOREIGN KEY ("candidateMasterId", "workspaceId") REFERENCES "synthetic_master_assets"("id", "workspaceId") ON DELETE RESTRICT ON UPDATE CASCADE;
