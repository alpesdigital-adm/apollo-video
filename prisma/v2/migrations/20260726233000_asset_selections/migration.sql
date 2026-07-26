CREATE TABLE "asset_selections" (
  "id" VARCHAR(128) NOT NULL,
  "workspaceId" VARCHAR(128) NOT NULL,
  "projectId" VARCHAR(128) NOT NULL,
  "projectVersionId" VARCHAR(128) NOT NULL,
  "projectVersionHash" CHAR(64) NOT NULL,
  "briefJson" TEXT NOT NULL,
  "briefHash" CHAR(64) NOT NULL,
  "candidatesJson" TEXT NOT NULL,
  "candidatesHash" CHAR(64) NOT NULL,
  "rightsEvidenceJson" TEXT NOT NULL,
  "evaluationsJson" TEXT NOT NULL,
  "decision" VARCHAR(16) NOT NULL,
  "selectedArtifactId" VARCHAR(128),
  "selectedSource" VARCHAR(16),
  "searchStoppedBeforeJson" TEXT NOT NULL,
  "auditId" VARCHAR(96) NOT NULL,
  "selectionHash" CHAR(64) NOT NULL,
  "idempotencyKey" VARCHAR(128) NOT NULL,
  "requestFingerprint" CHAR(64) NOT NULL,
  "createdByType" VARCHAR(32) NOT NULL,
  "createdById" VARCHAR(128) NOT NULL,
  "createdAt" TIMESTAMPTZ(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

  CONSTRAINT "asset_selections_pkey" PRIMARY KEY ("id"),
  CONSTRAINT "asset_selections_hashes_check" CHECK (
    "projectVersionHash" ~ '^[a-f0-9]{64}$'
    AND "briefHash" ~ '^[a-f0-9]{64}$'
    AND "candidatesHash" ~ '^[a-f0-9]{64}$'
    AND "selectionHash" ~ '^[a-f0-9]{64}$'
    AND "requestFingerprint" ~ '^[a-f0-9]{64}$'
    AND "auditId" ~ '^asset_selection_[a-f0-9]{64}$'
  ),
  CONSTRAINT "asset_selections_json_bounds_check" CHECK (
    length("briefJson") BETWEEN 2 AND 20000
    AND length("candidatesJson") BETWEEN 2 AND 100000
    AND length("rightsEvidenceJson") BETWEEN 2 AND 100000
    AND length("evaluationsJson") BETWEEN 2 AND 100000
    AND length("searchStoppedBeforeJson") BETWEEN 2 AND 64
  ),
  CONSTRAINT "asset_selections_decision_check" CHECK (
    (
      "decision" = 'use_asset'
      AND "selectedArtifactId" IS NOT NULL
      AND "selectedSource" IN ('library', 'stock', 'generated')
    )
    OR
    (
      "decision" = 'no_insert'
      AND "selectedArtifactId" IS NULL
      AND "selectedSource" IS NULL
    )
  ),
  CONSTRAINT "asset_selections_creator_check" CHECK ("createdByType" = 'api-client'),
  CONSTRAINT "asset_selections_idempotency_check" CHECK (
    length("idempotencyKey") BETWEEN 8 AND 128
  )
);

CREATE UNIQUE INDEX "asset_selections_id_workspaceId_key"
  ON "asset_selections"("id", "workspaceId");

CREATE UNIQUE INDEX "asset_selections_workspaceId_projectId_idempotencyKey_key"
  ON "asset_selections"("workspaceId", "projectId", "idempotencyKey");

CREATE INDEX "asset_selections_workspaceId_projectId_createdAt_idx"
  ON "asset_selections"("workspaceId", "projectId", "createdAt" DESC);

CREATE INDEX "asset_selections_workspaceId_projectVersionId_createdAt_idx"
  ON "asset_selections"("workspaceId", "projectVersionId", "createdAt" DESC);

CREATE INDEX "asset_selections_workspaceId_auditId_idx"
  ON "asset_selections"("workspaceId", "auditId");

CREATE INDEX "asset_selections_workspaceId_selectedArtifactId_idx"
  ON "asset_selections"("workspaceId", "selectedArtifactId");

ALTER TABLE "asset_selections" ADD CONSTRAINT "asset_selections_workspaceId_fkey" FOREIGN KEY ("workspaceId") REFERENCES "workspaces"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

ALTER TABLE "asset_selections" ADD CONSTRAINT "asset_selections_projectId_workspaceId_fkey" FOREIGN KEY ("projectId", "workspaceId") REFERENCES "projects"("id", "workspaceId") ON DELETE CASCADE ON UPDATE CASCADE;

ALTER TABLE "asset_selections" ADD CONSTRAINT "asset_selections_projectVersionId_workspaceId_fkey" FOREIGN KEY ("projectVersionId", "workspaceId") REFERENCES "project_versions"("id", "workspaceId") ON DELETE RESTRICT ON UPDATE CASCADE;

ALTER TABLE "asset_selections" ADD CONSTRAINT "asset_selections_selectedArtifactId_workspaceId_fkey" FOREIGN KEY ("selectedArtifactId", "workspaceId") REFERENCES "media_artifacts"("id", "workspaceId") ON DELETE RESTRICT ON UPDATE CASCADE;
