-- F1.048 deliberately retires pre-binding final-export jobs. They cannot be
-- proven to reference an exact post-render ProxyReview and must never resume.
DELETE FROM "public_operations"
WHERE "type" = 'project-final-export';

UPDATE "projects"
SET "status" = 'reviewing-proxy',
    "updatedAt" = CURRENT_TIMESTAMP
WHERE "status" = 'rendering-final';

ALTER TABLE "project_final_export_operations"
  ADD COLUMN "proxyReviewId" VARCHAR(128) NOT NULL,
  ADD COLUMN "proxyReviewHash" CHAR(64) NOT NULL,
  ADD COLUMN "proxyArtifactId" VARCHAR(128) NOT NULL,
  ADD COLUMN "outputCodec" VARCHAR(16) NOT NULL,
  ADD COLUMN "outputAudioCodec" VARCHAR(16) NOT NULL,
  ADD COLUMN "outputContainer" VARCHAR(16) NOT NULL,
  ADD COLUMN "outputQuality" VARCHAR(16) NOT NULL;

ALTER TABLE "project_final_export_operations"
  ADD CONSTRAINT "project_final_export_operations_proxyReviewId_workspaceId_fkey" FOREIGN KEY ("proxyReviewId", "workspaceId")
  REFERENCES "proxy_reviews"("id", "workspaceId")
  ON DELETE RESTRICT
  ON UPDATE CASCADE;

ALTER TABLE "project_final_export_operations"
  ADD CONSTRAINT "project_final_export_profile_check"
  CHECK (
    "outputCodec" = 'h264'
    AND "outputAudioCodec" = 'aac'
    AND "outputContainer" = 'mp4'
    AND "outputQuality" = 'final'
  );

CREATE INDEX "project_final_export_operations_workspaceId_proxyReviewId_idx"
  ON "project_final_export_operations"("workspaceId", "proxyReviewId");

CREATE TABLE "project_final_export_attempts" (
  "operationId" VARCHAR(128) NOT NULL,
  "workspaceId" VARCHAR(128) NOT NULL,
  "attempt" INTEGER NOT NULL,
  "status" VARCHAR(16) NOT NULL,
  "validatorsJson" TEXT NOT NULL,
  "outputArtifactId" VARCHAR(128),
  "outputManifestId" VARCHAR(128),
  "outputSha256" CHAR(64),
  "outputByteSize" BIGINT,
  "errorCode" VARCHAR(64),
  "errorMessage" VARCHAR(500),
  "startedAt" TIMESTAMPTZ(3) NOT NULL,
  "completedAt" TIMESTAMPTZ(3) NOT NULL,

  CONSTRAINT "project_final_export_attempts_pkey"
    PRIMARY KEY ("operationId", "attempt"),
  CONSTRAINT "project_final_export_attempts_attempt_check"
    CHECK ("attempt" >= 1),
  CONSTRAINT "project_final_export_attempts_time_check"
    CHECK ("completedAt" >= "startedAt"),
  CONSTRAINT "project_final_export_attempts_validators_check"
    CHECK (length("validatorsJson") BETWEEN 2 AND 20000),
  CONSTRAINT "project_final_export_attempts_state_check"
    CHECK (
      (
        "status" = 'failed'
        AND "outputArtifactId" IS NULL
        AND "outputManifestId" IS NULL
        AND "outputSha256" IS NULL
        AND "outputByteSize" IS NULL
        AND "errorCode" IS NOT NULL
        AND "errorMessage" IS NOT NULL
      )
      OR
      (
        "status" = 'promoted'
        AND "outputArtifactId" IS NOT NULL
        AND "outputManifestId" IS NOT NULL
        AND "outputSha256" ~ '^[a-f0-9]{64}$'
        AND "outputByteSize" > 0
        AND "errorCode" IS NULL
        AND "errorMessage" IS NULL
      )
    )
);

CREATE UNIQUE INDEX "project_final_export_attempts_operationId_workspaceId_attem_key"
  ON "project_final_export_attempts"("operationId", "workspaceId", "attempt");

ALTER TABLE "project_final_export_attempts"
  ADD CONSTRAINT "project_final_export_attempts_workspaceId_fkey" FOREIGN KEY ("workspaceId")
  REFERENCES "workspaces"("id")
  ON DELETE RESTRICT
  ON UPDATE CASCADE;

ALTER TABLE "project_final_export_attempts"
  ADD CONSTRAINT "project_final_export_attempts_operationId_workspaceId_fkey" FOREIGN KEY ("operationId", "workspaceId")
  REFERENCES "project_final_export_operations"("operationId", "workspaceId")
  ON DELETE CASCADE
  ON UPDATE CASCADE;

CREATE INDEX "project_final_export_attempts_workspaceId_completedAt_idx"
  ON "project_final_export_attempts"("workspaceId", "completedAt" DESC);

CREATE INDEX "project_final_export_attempts_workspaceId_status_completedA_idx"
  ON "project_final_export_attempts"("workspaceId", "status", "completedAt" DESC);
