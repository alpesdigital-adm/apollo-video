CREATE TABLE "contiguous_moment_evaluations" (
  "id" VARCHAR(128) NOT NULL,
  "workspaceId" VARCHAR(128) NOT NULL,
  "projectId" VARCHAR(128) NOT NULL,
  "indexRunId" VARCHAR(128) NOT NULL,
  "momentId" VARCHAR(128) NOT NULL,
  "policyVersion" VARCHAR(64) NOT NULL,
  "objectiveTagsJson" TEXT NOT NULL,
  "semanticStartMs" INTEGER NOT NULL,
  "semanticEndMs" INTEGER NOT NULL,
  "selfContainedScore" DOUBLE PRECISION NOT NULL,
  "densityScore" DOUBLE PRECISION NOT NULL,
  "integrityScore" DOUBLE PRECISION NOT NULL,
  "audioScore" DOUBLE PRECISION NOT NULL,
  "visualScore" DOUBLE PRECISION NOT NULL,
  "selfContainedEvidenceJson" TEXT NOT NULL,
  "densityEvidenceJson" TEXT NOT NULL,
  "integrityEvidenceJson" TEXT NOT NULL,
  "audioEvidenceJson" TEXT NOT NULL,
  "visualEvidenceJson" TEXT NOT NULL,
  "evaluationHash" CHAR(64) NOT NULL,
  "active" BOOLEAN NOT NULL DEFAULT true,
  "createdAt" TIMESTAMPTZ(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

  CONSTRAINT "contiguous_moment_evaluations_pkey" PRIMARY KEY ("id"),
  CONSTRAINT "contiguous_moment_evaluations_range_check"
    CHECK ("semanticStartMs" >= 0 AND "semanticEndMs" > "semanticStartMs"),
  CONSTRAINT "contiguous_moment_evaluations_scores_check"
    CHECK (
      "selfContainedScore" BETWEEN 0 AND 1 AND
      "densityScore" BETWEEN 0 AND 1 AND
      "integrityScore" BETWEEN 0 AND 1 AND
      "audioScore" BETWEEN 0 AND 1 AND
      "visualScore" BETWEEN 0 AND 1
    ),
  CONSTRAINT "contiguous_moment_evaluations_policy_check"
    CHECK ("policyVersion" = 'contiguous-extraction/v1'),
  CONSTRAINT "contiguous_moment_evaluations_hash_check"
    CHECK ("evaluationHash" ~ '^[a-f0-9]{64}$')
);

CREATE TABLE "contiguous_extractions" (
  "id" VARCHAR(128) NOT NULL,
  "workspaceId" VARCHAR(128) NOT NULL,
  "projectId" VARCHAR(128) NOT NULL,
  "sourceIndexRunId" VARCHAR(128) NOT NULL,
  "selectedMomentId" VARCHAR(128) NOT NULL,
  "policyVersion" VARCHAR(64) NOT NULL,
  "objective" VARCHAR(240) NOT NULL,
  "topic" VARCHAR(500) NOT NULL,
  "targetDurationMs" INTEGER NOT NULL,
  "toleranceMs" INTEGER NOT NULL,
  "selectedStartMs" INTEGER NOT NULL,
  "selectedEndMs" INTEGER NOT NULL,
  "selectedCandidateHash" CHAR(64) NOT NULL,
  "storyPlanJson" TEXT NOT NULL,
  "editPlanJson" TEXT NOT NULL,
  "resultJson" TEXT NOT NULL,
  "resultHash" CHAR(64) NOT NULL,
  "requestFingerprint" CHAR(64) NOT NULL,
  "idempotencyKey" VARCHAR(128) NOT NULL,
  "createdByClientId" VARCHAR(80) NOT NULL,
  "createdAt" TIMESTAMPTZ(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

  CONSTRAINT "contiguous_extractions_pkey" PRIMARY KEY ("id"),
  CONSTRAINT "contiguous_extractions_range_check"
    CHECK ("selectedStartMs" >= 0 AND "selectedEndMs" > "selectedStartMs"),
  CONSTRAINT "contiguous_extractions_duration_check"
    CHECK (
      "targetDurationMs" >= 1000 AND
      "toleranceMs" >= 0 AND
      "toleranceMs" <= "targetDurationMs"
    ),
  CONSTRAINT "contiguous_extractions_policy_check"
    CHECK ("policyVersion" = 'contiguous-extraction/v1'),
  CONSTRAINT "contiguous_extractions_hashes_check"
    CHECK (
      "selectedCandidateHash" ~ '^[a-f0-9]{64}$' AND
      "resultHash" ~ '^[a-f0-9]{64}$' AND
      "requestFingerprint" ~ '^[a-f0-9]{64}$'
    )
);

CREATE UNIQUE INDEX "contiguous_moment_evaluations_id_workspaceId_key"
  ON "contiguous_moment_evaluations"("id", "workspaceId");
CREATE UNIQUE INDEX "contiguous_moment_evaluations_workspaceId_momentId_policyVe_key"
  ON "contiguous_moment_evaluations"(
    "workspaceId", "momentId", "policyVersion", "evaluationHash"
  );
CREATE INDEX "contiguous_moment_evaluations_workspaceId_projectId_active__idx"
  ON "contiguous_moment_evaluations"(
    "workspaceId", "projectId", "active", "createdAt" DESC
  );
CREATE INDEX "contiguous_moment_evaluations_workspaceId_momentId_active_idx"
  ON "contiguous_moment_evaluations"("workspaceId", "momentId", "active");
CREATE INDEX "contiguous_moment_evaluations_workspaceId_indexRunId_active_idx"
  ON "contiguous_moment_evaluations"("workspaceId", "indexRunId", "active");

CREATE UNIQUE INDEX "contiguous_extractions_id_workspaceId_key"
  ON "contiguous_extractions"("id", "workspaceId");
CREATE UNIQUE INDEX "contiguous_extractions_workspaceId_projectId_createdByClien_key"
  ON "contiguous_extractions"(
    "workspaceId", "projectId", "createdByClientId", "idempotencyKey"
  );
CREATE INDEX "contiguous_extractions_workspaceId_projectId_createdAt_id_idx"
  ON "contiguous_extractions"(
    "workspaceId", "projectId", "createdAt" DESC, "id" DESC
  );
CREATE INDEX "contiguous_extractions_workspaceId_sourceIndexRunId_created_idx"
  ON "contiguous_extractions"(
    "workspaceId", "sourceIndexRunId", "createdAt" DESC
  );
CREATE INDEX "contiguous_extractions_workspaceId_selectedMomentId_idx"
  ON "contiguous_extractions"("workspaceId", "selectedMomentId");

ALTER TABLE "contiguous_moment_evaluations"
  ADD CONSTRAINT "contiguous_moment_evaluations_workspaceId_fkey"
    FOREIGN KEY ("workspaceId") REFERENCES "workspaces"("id")
    ON DELETE RESTRICT ON UPDATE CASCADE,
  ADD CONSTRAINT "contiguous_moment_evaluations_projectId_workspaceId_fkey"
    FOREIGN KEY ("projectId", "workspaceId")
    REFERENCES "projects"("id", "workspaceId")
    ON DELETE CASCADE ON UPDATE CASCADE,
  ADD CONSTRAINT "contiguous_moment_evaluations_indexRunId_workspaceId_fkey"
    FOREIGN KEY ("indexRunId", "workspaceId")
    REFERENCES "long_form_index_runs"("id", "workspaceId")
    ON DELETE CASCADE ON UPDATE CASCADE,
  ADD CONSTRAINT "contiguous_moment_evaluations_momentId_workspaceId_fkey"
    FOREIGN KEY ("momentId", "workspaceId")
    REFERENCES "long_form_moments"("id", "workspaceId")
    ON DELETE CASCADE ON UPDATE CASCADE;

ALTER TABLE "contiguous_extractions"
  ADD CONSTRAINT "contiguous_extractions_workspaceId_fkey"
    FOREIGN KEY ("workspaceId") REFERENCES "workspaces"("id")
    ON DELETE RESTRICT ON UPDATE CASCADE,
  ADD CONSTRAINT "contiguous_extractions_projectId_workspaceId_fkey"
    FOREIGN KEY ("projectId", "workspaceId")
    REFERENCES "projects"("id", "workspaceId")
    ON DELETE CASCADE ON UPDATE CASCADE,
  ADD CONSTRAINT "contiguous_extractions_sourceIndexRunId_workspaceId_fkey"
    FOREIGN KEY ("sourceIndexRunId", "workspaceId")
    REFERENCES "long_form_index_runs"("id", "workspaceId")
    ON DELETE RESTRICT ON UPDATE CASCADE,
  ADD CONSTRAINT "contiguous_extractions_selectedMomentId_workspaceId_fkey"
    FOREIGN KEY ("selectedMomentId", "workspaceId")
    REFERENCES "long_form_moments"("id", "workspaceId")
    ON DELETE RESTRICT ON UPDATE CASCADE,
  ADD CONSTRAINT "contiguous_extractions_createdByClientId_workspaceId_fkey"
    FOREIGN KEY ("createdByClientId", "workspaceId")
    REFERENCES "api_clients"("id", "workspaceId")
    ON DELETE RESTRICT ON UPDATE CASCADE;
