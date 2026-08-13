CREATE TABLE "treatment_plans" (
  "id" VARCHAR(128) NOT NULL,
  "workspaceId" VARCHAR(128) NOT NULL,
  "projectId" VARCHAR(128) NOT NULL,
  "projectVersionId" VARCHAR(128) NOT NULL,
  "policySnapshotId" VARCHAR(128) NOT NULL,
  "schemaVersion" INTEGER NOT NULL,
  "objective" VARCHAR(64) NOT NULL,
  "mode" VARCHAR(32) NOT NULL,
  "rubricId" VARCHAR(128) NOT NULL,
  "rubricVersion" INTEGER NOT NULL,
  "rubricHash" CHAR(64) NOT NULL,
  "policySchemaVersion" INTEGER NOT NULL,
  "policySnapshotHash" CHAR(64) NOT NULL,
  "perceptionSummaryId" VARCHAR(128) NOT NULL,
  "perceptionSchemaVersion" INTEGER NOT NULL,
  "perceptionSummaryHash" CHAR(64) NOT NULL,
  "treatmentJson" TEXT NOT NULL,
  "treatmentHash" CHAR(64) NOT NULL,
  "requestFingerprint" CHAR(64) NOT NULL,
  "idempotencyKey" VARCHAR(128) NOT NULL,
  "createdByClientId" VARCHAR(80) NOT NULL,
  "actorCredentialId" VARCHAR(128) NOT NULL,
  "actorEnvironment" VARCHAR(16) NOT NULL,
  "actorAuthenticationKind" VARCHAR(16) NOT NULL,
  "actorContextHash" CHAR(64) NOT NULL,
  "delegatedUserId" VARCHAR(128),
  "delegatedIdentityId" VARCHAR(128),
  "workspaceRole" VARCHAR(32),
  "createdAt" TIMESTAMPTZ(3) NOT NULL,
  CONSTRAINT "treatment_plans_pkey" PRIMARY KEY ("id"),
  CONSTRAINT "treatment_plans_schema_version_check" CHECK ("schemaVersion" = 3),
  CONSTRAINT "treatment_plans_input_versions_check" CHECK ("rubricVersion" > 0 AND "policySchemaVersion" > 0 AND "perceptionSchemaVersion" > 0)
);

CREATE UNIQUE INDEX "treatment_plans_id_workspaceId_key" ON "treatment_plans"("id", "workspaceId");
CREATE UNIQUE INDEX "treatment_plans_workspaceId_projectId_createdByClientId_ide_key" ON "treatment_plans"("workspaceId", "projectId", "createdByClientId", "idempotencyKey");
CREATE INDEX "treatment_plans_workspaceId_projectId_treatmentHash_idx" ON "treatment_plans"("workspaceId", "projectId", "treatmentHash");
CREATE INDEX "treatment_plans_workspaceId_projectId_createdAt_id_idx" ON "treatment_plans"("workspaceId", "projectId", "createdAt" DESC, "id");
CREATE INDEX "treatment_plans_workspaceId_projectVersionId_idx" ON "treatment_plans"("workspaceId", "projectVersionId");
CREATE INDEX "treatment_plans_workspaceId_perceptionSummaryId_idx" ON "treatment_plans"("workspaceId", "perceptionSummaryId");

ALTER TABLE "treatment_plans" ADD CONSTRAINT "treatment_plans_workspaceId_fkey" FOREIGN KEY ("workspaceId") REFERENCES "workspaces"("id") ON DELETE RESTRICT ON UPDATE CASCADE;
ALTER TABLE "treatment_plans" ADD CONSTRAINT "treatment_plans_projectId_workspaceId_fkey" FOREIGN KEY ("projectId", "workspaceId") REFERENCES "projects"("id", "workspaceId") ON DELETE RESTRICT ON UPDATE CASCADE;
ALTER TABLE "treatment_plans" ADD CONSTRAINT "treatment_plans_projectVersionId_projectId_workspaceId_fkey" FOREIGN KEY ("projectVersionId", "projectId", "workspaceId") REFERENCES "project_versions"("id", "projectId", "workspaceId") ON DELETE RESTRICT ON UPDATE CASCADE;
ALTER TABLE "treatment_plans" ADD CONSTRAINT "treatment_plans_policySnapshotId_projectId_workspaceId_fkey" FOREIGN KEY ("policySnapshotId", "projectId", "workspaceId") REFERENCES "project_snapshots"("id", "projectId", "workspaceId") ON DELETE RESTRICT ON UPDATE CASCADE;
ALTER TABLE "treatment_plans" ADD CONSTRAINT "treatment_plans_createdByClientId_workspaceId_fkey" FOREIGN KEY ("createdByClientId", "workspaceId") REFERENCES "api_clients"("id", "workspaceId") ON DELETE RESTRICT ON UPDATE CASCADE;
