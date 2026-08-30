CREATE TABLE "synthetic_block_generations" (
  "id" VARCHAR(128) NOT NULL,
  "workspaceId" VARCHAR(128) NOT NULL,
  "projectId" VARCHAR(128) NOT NULL,
  "planId" VARCHAR(128) NOT NULL,
  "blockId" VARCHAR(128) NOT NULL,
  "attempt" INTEGER NOT NULL,
  "schemaVersion" VARCHAR(64) NOT NULL,
  "status" VARCHAR(16) NOT NULL,
  "cacheKey" CHAR(64) NOT NULL,
  "cacheDecision" VARCHAR(32) NOT NULL,
  "decisionReason" VARCHAR(500) NOT NULL,
  "providerJobId" VARCHAR(128),
  "sourceGenerationId" VARCHAR(128),
  "profileSnapshotId" VARCHAR(128) NOT NULL,
  "voiceAdapterId" VARCHAR(128) NOT NULL,
  "voiceAdapterVersion" VARCHAR(128) NOT NULL,
  "voiceId" VARCHAR(128) NOT NULL,
  "voiceVersion" INTEGER NOT NULL,
  "voiceModelRef" VARCHAR(128),
  "outputFormat" VARCHAR(8) NOT NULL,
  "synthesisConfigHash" CHAR(64) NOT NULL,
  "scriptHash" CHAR(64) NOT NULL,
  "audioArtifactId" VARCHAR(128),
  "alignmentArtifactId" VARCHAR(128),
  "supersededByGenerationId" VARCHAR(128),
  "failureReason" VARCHAR(500),
  "attemptBudget" INTEGER NOT NULL,
  "deadlineAt" TIMESTAMPTZ(3) NOT NULL,
  "createdAt" TIMESTAMPTZ(3) NOT NULL,
  "updatedAt" TIMESTAMPTZ(3) NOT NULL,
  CONSTRAINT "synthetic_block_generations_pkey" PRIMARY KEY ("id"),
  CONSTRAINT "synthetic_block_generations_schema_check" CHECK ("schemaVersion" = 'synthetic-block-generation/v1'),
  CONSTRAINT "synthetic_block_generations_status_check" CHECK ("status" IN ('pending', 'approved', 'failed', 'superseded')),
  CONSTRAINT "synthetic_block_generations_decision_check" CHECK ("cacheDecision" IN ('miss-generate', 'hit-reuse', 'forced-regenerate')),
  CONSTRAINT "synthetic_block_generations_attempt_check" CHECK ("attempt" >= 1),
  CONSTRAINT "synthetic_block_generations_budget_check" CHECK ("attemptBudget" >= 1 AND "attemptBudget" <= 10),
  CONSTRAINT "synthetic_block_generations_format_check" CHECK ("outputFormat" IN ('mp3', 'wav')),
  CONSTRAINT "synthetic_block_generations_source_check" CHECK (
    ("cacheDecision" = 'hit-reuse' AND "sourceGenerationId" IS NOT NULL AND "providerJobId" IS NULL) OR
    ("cacheDecision" IN ('miss-generate', 'forced-regenerate') AND "providerJobId" IS NOT NULL AND "sourceGenerationId" IS NULL)
  ),
  CONSTRAINT "synthetic_block_generations_approved_check" CHECK (
    "status" <> 'approved' OR ("audioArtifactId" IS NOT NULL AND "alignmentArtifactId" IS NOT NULL)
  ),
  CONSTRAINT "synthetic_block_generations_hash_check" CHECK (
    "cacheKey" ~ '^[a-f0-9]{64}$' AND "scriptHash" ~ '^[a-f0-9]{64}$' AND "synthesisConfigHash" ~ '^[a-f0-9]{64}$'
  )
);

CREATE UNIQUE INDEX "synthetic_block_generations_id_workspaceId_key"
  ON "synthetic_block_generations"("id", "workspaceId");
CREATE UNIQUE INDEX "synthetic_block_generations_block_attempt_key"
  ON "synthetic_block_generations"("workspaceId", "blockId", "attempt");
CREATE INDEX "synthetic_block_generations_cache_idx"
  ON "synthetic_block_generations"("workspaceId", "cacheKey", "status");
CREATE INDEX "synthetic_block_generations_plan_status_idx"
  ON "synthetic_block_generations"("workspaceId", "planId", "status");
CREATE INDEX "synthetic_block_generations_job_idx"
  ON "synthetic_block_generations"("workspaceId", "providerJobId");

ALTER TABLE "synthetic_block_generations" ADD CONSTRAINT "synthetic_block_generations_workspaceId_fkey"
  FOREIGN KEY ("workspaceId") REFERENCES "workspaces"("id") ON DELETE RESTRICT ON UPDATE CASCADE;
ALTER TABLE "synthetic_block_generations" ADD CONSTRAINT "synthetic_block_generations_projectId_workspaceId_fkey"
  FOREIGN KEY ("projectId", "workspaceId") REFERENCES "projects"("id", "workspaceId") ON DELETE CASCADE ON UPDATE CASCADE;
ALTER TABLE "synthetic_block_generations" ADD CONSTRAINT "synthetic_block_generations_planId_workspaceId_fkey"
  FOREIGN KEY ("planId", "workspaceId") REFERENCES "synthetic_script_plans"("id", "workspaceId") ON DELETE CASCADE ON UPDATE CASCADE;
ALTER TABLE "synthetic_block_generations" ADD CONSTRAINT "synthetic_block_generations_blockId_workspaceId_fkey"
  FOREIGN KEY ("blockId", "workspaceId") REFERENCES "synthetic_script_blocks"("id", "workspaceId") ON DELETE CASCADE ON UPDATE CASCADE;
ALTER TABLE "synthetic_block_generations" ADD CONSTRAINT "synthetic_block_generations_providerJobId_workspaceId_fkey"
  FOREIGN KEY ("providerJobId", "workspaceId") REFERENCES "provider_jobs"("id", "workspaceId") ON DELETE RESTRICT ON UPDATE CASCADE;
ALTER TABLE "synthetic_block_generations" ADD CONSTRAINT "synthetic_block_generations_sourceGenerationId_workspaceId_fkey"
  FOREIGN KEY ("sourceGenerationId", "workspaceId") REFERENCES "synthetic_block_generations"("id", "workspaceId") ON DELETE RESTRICT ON UPDATE CASCADE;
ALTER TABLE "synthetic_block_generations" ADD CONSTRAINT "synthetic_block_generations_supersededByGenerationId_works_fkey"
  FOREIGN KEY ("supersededByGenerationId", "workspaceId") REFERENCES "synthetic_block_generations"("id", "workspaceId") ON DELETE RESTRICT ON UPDATE CASCADE;
ALTER TABLE "synthetic_block_generations" ADD CONSTRAINT "synthetic_block_generations_profileSnapshotId_workspaceId_fkey"
  FOREIGN KEY ("profileSnapshotId", "workspaceId") REFERENCES "synthetic_presenter_profiles"("id", "workspaceId") ON DELETE RESTRICT ON UPDATE CASCADE;
ALTER TABLE "synthetic_block_generations" ADD CONSTRAINT "synthetic_block_generations_audioArtifactId_workspaceId_fkey"
  FOREIGN KEY ("audioArtifactId", "workspaceId") REFERENCES "media_artifacts"("id", "workspaceId") ON DELETE RESTRICT ON UPDATE CASCADE;
ALTER TABLE "synthetic_block_generations" ADD CONSTRAINT "synthetic_block_generations_alignmentArtifactId_workspaceI_fkey"
  FOREIGN KEY ("alignmentArtifactId", "workspaceId") REFERENCES "media_artifacts"("id", "workspaceId") ON DELETE RESTRICT ON UPDATE CASCADE;
