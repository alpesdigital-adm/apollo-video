CREATE TABLE "music_analysis_authorizations" (
  "id" VARCHAR(160) NOT NULL, "workspaceId" VARCHAR(128) NOT NULL, "analysisId" VARCHAR(128) NOT NULL,
  "projectVersionId" VARCHAR(128) NOT NULL, "rightsSnapshotId" VARCHAR(128) NOT NULL, "authorizedAt" TIMESTAMPTZ(6) NOT NULL,
  CONSTRAINT "music_analysis_authorizations_pkey" PRIMARY KEY ("id")
);
CREATE UNIQUE INDEX "music_analysis_authorizations_identity_key" ON "music_analysis_authorizations"("workspaceId", "analysisId", "projectVersionId", "rightsSnapshotId");
CREATE INDEX "music_analysis_authorizations_workspaceId_analysisId_rights_idx" ON "music_analysis_authorizations"("workspaceId", "analysisId", "rightsSnapshotId");

INSERT INTO "music_analysis_authorizations" ("id", "workspaceId", "analysisId", "projectVersionId", "rightsSnapshotId", "authorizedAt")
SELECT 'music-analysis-authorization-' || md5("workspaceId" || ':' || "id" || ':' || "projectVersionId" || ':' || "rightsSnapshotId"), "workspaceId", "id", "projectVersionId", "rightsSnapshotId", "createdAt" FROM "music_analyses";

CREATE TABLE "music_analysis_run_actions" (
  "id" VARCHAR(160) NOT NULL, "workspaceId" VARCHAR(128) NOT NULL, "runId" VARCHAR(128) NOT NULL,
  "action" VARCHAR(16) NOT NULL, "previousStatus" VARCHAR(16) NOT NULL, "resultStatus" VARCHAR(16) NOT NULL, "attempt" INTEGER NOT NULL,
  "actorClientId" VARCHAR(128) NOT NULL, "actorCredentialId" VARCHAR(128) NOT NULL, "actorEnvironment" VARCHAR(32) NOT NULL,
  "actorAuthenticationKind" VARCHAR(32) NOT NULL, "actorContextHash" CHAR(64) NOT NULL, "delegatedUserId" VARCHAR(128),
  "delegatedIdentityId" VARCHAR(128), "workspaceRole" VARCHAR(32), "createdAt" TIMESTAMPTZ(6) NOT NULL,
  CONSTRAINT "music_analysis_run_actions_pkey" PRIMARY KEY ("id"),
  CONSTRAINT "music_analysis_run_actions_action_check" CHECK ("action" IN ('cancel','retry'))
);
CREATE UNIQUE INDEX "music_analysis_run_actions_transition_key" ON "music_analysis_run_actions"("workspaceId", "runId", "action", "attempt", "previousStatus");
CREATE INDEX "music_analysis_run_actions_workspaceId_runId_createdAt_idx" ON "music_analysis_run_actions"("workspaceId", "runId", "createdAt");
