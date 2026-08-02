ALTER TABLE "media_artifacts"
ADD COLUMN "lifecycleRevision" INTEGER NOT NULL DEFAULT 1;

ALTER TABLE "media_artifacts"
ADD CONSTRAINT "media_artifacts_lifecycle_revision_check"
CHECK ("lifecycleRevision" >= 1);

ALTER TABLE "media_artifacts"
ADD CONSTRAINT "media_artifacts_lifecycle_status_check"
CHECK ("status" IN ('available', 'quarantined', 'deleted'));

CREATE TABLE "media_artifact_lifecycle_transitions" (
    "id" UUID NOT NULL,
    "workspaceId" VARCHAR(128) NOT NULL,
    "artifactId" VARCHAR(128) NOT NULL,
    "baseRevision" INTEGER NOT NULL,
    "resultRevision" INTEGER NOT NULL,
    "fromStatus" VARCHAR(32) NOT NULL,
    "targetStatus" VARCHAR(32) NOT NULL,
    "changed" BOOLEAN NOT NULL,
    "reason" VARCHAR(500) NOT NULL,
    "actorClientId" VARCHAR(80) NOT NULL,
    "idempotencyKey" VARCHAR(128) NOT NULL,
    "requestFingerprint" CHAR(64) NOT NULL,
    "createdAt" TIMESTAMPTZ(3) NOT NULL,

    CONSTRAINT "media_artifact_lifecycle_transitions_pkey" PRIMARY KEY ("id")
);

CREATE INDEX "media_artifact_lifecycle_transitions_workspaceId_actorClien_idx"
ON "media_artifact_lifecycle_transitions"("workspaceId", "actorClientId", "idempotencyKey");

CREATE INDEX "media_artifact_lifecycle_transitions_workspaceId_artifactId_idx"
ON "media_artifact_lifecycle_transitions"("workspaceId", "artifactId", "createdAt" DESC);

CREATE INDEX "media_artifact_lifecycle_transitions_workspaceId_targetStat_idx"
ON "media_artifact_lifecycle_transitions"("workspaceId", "targetStatus", "createdAt" DESC);

ALTER TABLE "media_artifact_lifecycle_transitions"
ADD CONSTRAINT "media_artifact_lifecycle_transitions_workspaceId_fkey"
FOREIGN KEY ("workspaceId") REFERENCES "workspaces"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

ALTER TABLE "media_artifact_lifecycle_transitions"
ADD CONSTRAINT "media_artifact_lifecycle_transitions_artifactId_workspaceI_fkey"
FOREIGN KEY ("artifactId", "workspaceId") REFERENCES "media_artifacts"("id", "workspaceId") ON DELETE RESTRICT ON UPDATE CASCADE;

ALTER TABLE "media_artifact_lifecycle_transitions"
ADD CONSTRAINT "media_artifact_lifecycle_transitions_revision_check"
CHECK (
    "baseRevision" >= 1 AND
    "resultRevision" >= "baseRevision" AND
    (("changed" = TRUE AND "resultRevision" = "baseRevision" + 1 AND "fromStatus" <> "targetStatus") OR
     ("changed" = FALSE AND "resultRevision" = "baseRevision" AND "fromStatus" = "targetStatus"))
);

ALTER TABLE "media_artifact_lifecycle_transitions"
ADD CONSTRAINT "media_artifact_lifecycle_transitions_status_check"
CHECK (
    "fromStatus" IN ('available', 'quarantined', 'deleted') AND
    "targetStatus" IN ('available', 'quarantined', 'deleted') AND
    NOT ("fromStatus" = 'deleted' AND "targetStatus" <> 'deleted')
);
