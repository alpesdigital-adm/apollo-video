CREATE TABLE "perception_timelines" (
  "id" VARCHAR(128) NOT NULL,
  "workspaceId" VARCHAR(128) NOT NULL,
  "projectId" VARCHAR(128) NOT NULL,
  "projectVersionId" VARCHAR(128) NOT NULL,
  "baseRevision" CHAR(64),
  "durationMs" INTEGER NOT NULL,
  "timelineJson" TEXT NOT NULL,
  "timelineHash" CHAR(64) NOT NULL,
  "requestFingerprint" CHAR(64) NOT NULL,
  "idempotencyKey" VARCHAR(128) NOT NULL,
  "recordHash" CHAR(64) NOT NULL,
  "createdByClientId" VARCHAR(80) NOT NULL,
  "actorCredentialId" VARCHAR(128) NOT NULL,
  "actorEnvironment" VARCHAR(16) NOT NULL,
  "actorAuthenticationKind" VARCHAR(16) NOT NULL,
  "actorContextHash" CHAR(64) NOT NULL,
  "delegatedUserId" VARCHAR(128),
  "delegatedIdentityId" VARCHAR(128),
  "workspaceRole" VARCHAR(32),
  "createdAt" TIMESTAMPTZ(3) NOT NULL,
  CONSTRAINT "perception_timelines_pkey" PRIMARY KEY ("id"),
  CONSTRAINT "perception_timelines_duration_check" CHECK ("durationMs" > 0)
);

CREATE UNIQUE INDEX "perception_timelines_id_workspaceId_key"
  ON "perception_timelines"("id", "workspaceId");
CREATE UNIQUE INDEX "perception_timelines_workspaceId_projectId_idempotencyKey_key"
  ON "perception_timelines"("workspaceId", "projectId", "idempotencyKey");
CREATE INDEX "perception_timelines_workspaceId_projectId_createdAt_id_idx"
  ON "perception_timelines"("workspaceId", "projectId", "createdAt" DESC, "id");
CREATE INDEX "perception_timelines_workspaceId_projectVersionId_idx"
  ON "perception_timelines"("workspaceId", "projectVersionId");

ALTER TABLE "perception_timelines" ADD CONSTRAINT "perception_timelines_workspaceId_fkey"
  FOREIGN KEY ("workspaceId") REFERENCES "workspaces"("id") ON DELETE RESTRICT ON UPDATE CASCADE;
ALTER TABLE "perception_timelines" ADD CONSTRAINT "perception_timelines_projectId_workspaceId_fkey"
  FOREIGN KEY ("projectId", "workspaceId") REFERENCES "projects"("id", "workspaceId") ON DELETE RESTRICT ON UPDATE CASCADE;
ALTER TABLE "perception_timelines" ADD CONSTRAINT "perception_timelines_projectVersionId_projectId_workspaceI_fkey"
  FOREIGN KEY ("projectVersionId", "projectId", "workspaceId") REFERENCES "project_versions"("id", "projectId", "workspaceId") ON DELETE RESTRICT ON UPDATE CASCADE;
ALTER TABLE "perception_timelines" ADD CONSTRAINT "perception_timelines_createdByClientId_workspaceId_fkey"
  FOREIGN KEY ("createdByClientId", "workspaceId") REFERENCES "api_clients"("id", "workspaceId") ON DELETE RESTRICT ON UPDATE CASCADE;
