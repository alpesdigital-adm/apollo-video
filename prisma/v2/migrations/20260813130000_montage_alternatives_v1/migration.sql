CREATE TABLE "montage_alternative_runs" (
  "id" VARCHAR(128) NOT NULL,
  "workspaceId" VARCHAR(128) NOT NULL,
  "projectId" VARCHAR(128) NOT NULL,
  "schemaVersion" VARCHAR(64) NOT NULL,
  "policyVersion" VARCHAR(64) NOT NULL,
  "storyPlanId" VARCHAR(128) NOT NULL,
  "storyPlanHash" CHAR(64) NOT NULL,
  "status" VARCHAR(16) NOT NULL,
  "winnerId" VARCHAR(128),
  "reason" VARCHAR(64) NOT NULL,
  "candidateCount" INTEGER NOT NULL,
  "eligibleCount" INTEGER NOT NULL,
  "diversityOverall" DECIMAL(8,6) NOT NULL,
  "selectionJson" TEXT NOT NULL,
  "selectionHash" CHAR(64) NOT NULL,
  "runJson" TEXT NOT NULL,
  "runHash" CHAR(64) NOT NULL,
  "requestFingerprint" CHAR(64) NOT NULL,
  "idempotencyKey" VARCHAR(128) NOT NULL,
  "createdByClientId" VARCHAR(80) NOT NULL,
  "actorCredentialId" VARCHAR(128),
  "actorEnvironment" VARCHAR(16),
  "actorAuthenticationKind" VARCHAR(16),
  "actorContextHash" CHAR(64),
  "delegatedUserId" VARCHAR(128),
  "delegatedIdentityId" VARCHAR(128),
  "workspaceRole" VARCHAR(32),
  "createdAt" TIMESTAMPTZ(3) NOT NULL,
  CONSTRAINT "montage_alternative_runs_pkey" PRIMARY KEY ("id"),
  CONSTRAINT "montage_alternative_runs_status_check" CHECK ("status" IN ('selected', 'review', 'blocked')),
  CONSTRAINT "montage_alternative_runs_candidate_count_check" CHECK ("candidateCount" >= 1 AND "candidateCount" <= 32),
  CONSTRAINT "montage_alternative_runs_eligible_count_check" CHECK ("eligibleCount" >= 0 AND "eligibleCount" <= "candidateCount"),
  CONSTRAINT "montage_alternative_runs_diversity_check" CHECK ("diversityOverall" >= 0 AND "diversityOverall" <= 1),
  CONSTRAINT "montage_alternative_runs_winner_state_check" CHECK (
    ("status" = 'blocked' AND "winnerId" IS NULL)
    OR ("status" IN ('selected', 'review') AND "winnerId" IS NOT NULL)
  )
);

CREATE UNIQUE INDEX "montage_alternative_runs_id_workspaceId_key" ON "montage_alternative_runs"("id", "workspaceId");
CREATE UNIQUE INDEX "montage_alternative_runs_id_workspaceId_projectId_key" ON "montage_alternative_runs"("id", "workspaceId", "projectId");
CREATE UNIQUE INDEX "montage_alternative_runs_workspaceId_projectId_createdByCli_key" ON "montage_alternative_runs"("workspaceId", "projectId", "createdByClientId", "idempotencyKey");
CREATE INDEX "montage_alternative_runs_workspaceId_projectId_createdAt_id_idx" ON "montage_alternative_runs"("workspaceId", "projectId", "createdAt" DESC, "id" DESC);
CREATE INDEX "montage_alternative_runs_workspaceId_projectId_status_creat_idx" ON "montage_alternative_runs"("workspaceId", "projectId", "status", "createdAt" DESC);
CREATE INDEX "montage_alternative_runs_workspaceId_storyPlanId_storyPlanH_idx" ON "montage_alternative_runs"("workspaceId", "storyPlanId", "storyPlanHash");
CREATE INDEX "montage_alternative_runs_workspaceId_actorContextHash_creat_idx" ON "montage_alternative_runs"("workspaceId", "actorContextHash", "createdAt" DESC);
ALTER TABLE "montage_alternative_runs" ADD CONSTRAINT "montage_alternative_runs_workspaceId_fkey" FOREIGN KEY ("workspaceId") REFERENCES "workspaces"("id") ON DELETE RESTRICT ON UPDATE CASCADE;
ALTER TABLE "montage_alternative_runs" ADD CONSTRAINT "montage_alternative_runs_projectId_workspaceId_fkey" FOREIGN KEY ("projectId", "workspaceId") REFERENCES "projects"("id", "workspaceId") ON DELETE CASCADE ON UPDATE CASCADE;
ALTER TABLE "montage_alternative_runs" ADD CONSTRAINT "montage_alternative_runs_createdByClientId_workspaceId_fkey" FOREIGN KEY ("createdByClientId", "workspaceId") REFERENCES "api_clients"("id", "workspaceId") ON DELETE RESTRICT ON UPDATE CASCADE;
