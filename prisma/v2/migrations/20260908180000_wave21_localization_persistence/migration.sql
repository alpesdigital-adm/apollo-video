CREATE TABLE "localization_canonical_scripts" (
  "id" VARCHAR(128) NOT NULL, "workspaceId" VARCHAR(128) NOT NULL, "projectId" VARCHAR(128) NOT NULL,
  "projectVersionId" VARCHAR(128) NOT NULL, "alignmentId" VARCHAR(128) NOT NULL, "alignmentRunHash" CHAR(64) NOT NULL,
  "sourceLocale" VARCHAR(35) NOT NULL, "revision" INTEGER NOT NULL, "snapshotJson" TEXT NOT NULL, "contentHash" CHAR(64) NOT NULL,
  "requestFingerprint" CHAR(64) NOT NULL, "idempotencyKey" VARCHAR(128) NOT NULL, "approvedByClientId" VARCHAR(80) NOT NULL,
  "actorCredentialId" VARCHAR(128) NOT NULL, "actorEnvironment" VARCHAR(16) NOT NULL, "actorAuthenticationKind" VARCHAR(16) NOT NULL,
  "actorContextHash" CHAR(64) NOT NULL, "delegatedUserId" VARCHAR(128), "delegatedIdentityId" VARCHAR(128), "workspaceRole" VARCHAR(32),
  "approvedAt" TIMESTAMPTZ(3) NOT NULL, CONSTRAINT "localization_canonical_scripts_pkey" PRIMARY KEY ("id")
);
CREATE UNIQUE INDEX "localization_canonical_scripts_id_workspaceId_key" ON "localization_canonical_scripts"("id", "workspaceId");
CREATE UNIQUE INDEX "localization_canonical_scripts_id_projectId_workspaceId_key" ON "localization_canonical_scripts"("id", "projectId", "workspaceId");
CREATE UNIQUE INDEX "localization_canonical_scripts_workspaceId_approvedByClient_key" ON "localization_canonical_scripts"("workspaceId", "approvedByClientId", "idempotencyKey");
CREATE UNIQUE INDEX "localization_canonical_scripts_workspaceId_projectId_projec_key" ON "localization_canonical_scripts"("workspaceId", "projectId", "projectVersionId", "revision");
CREATE INDEX "localization_canonical_scripts_workspaceId_alignmentId_alig_idx" ON "localization_canonical_scripts"("workspaceId", "alignmentId", "alignmentRunHash");

CREATE TABLE "localization_profiles" (
  "id" VARCHAR(128) NOT NULL, "workspaceId" VARCHAR(128) NOT NULL, "targetLocale" VARCHAR(35) NOT NULL, "market" VARCHAR(80),
  "allowedModesJson" TEXT NOT NULL, "snapshotJson" TEXT NOT NULL, "profileHash" CHAR(64) NOT NULL,
  "requestFingerprint" CHAR(64) NOT NULL, "idempotencyKey" VARCHAR(128) NOT NULL, "createdByClientId" VARCHAR(80) NOT NULL,
  "actorCredentialId" VARCHAR(128) NOT NULL, "actorEnvironment" VARCHAR(16) NOT NULL, "actorAuthenticationKind" VARCHAR(16) NOT NULL,
  "actorContextHash" CHAR(64) NOT NULL, "delegatedUserId" VARCHAR(128), "delegatedIdentityId" VARCHAR(128), "workspaceRole" VARCHAR(32),
  "createdAt" TIMESTAMPTZ(3) NOT NULL, CONSTRAINT "localization_profiles_pkey" PRIMARY KEY ("id")
);
CREATE UNIQUE INDEX "localization_profiles_id_workspaceId_key" ON "localization_profiles"("id", "workspaceId");
CREATE UNIQUE INDEX "localization_profiles_workspaceId_profileHash_key" ON "localization_profiles"("workspaceId", "profileHash");
CREATE UNIQUE INDEX "localization_profiles_workspaceId_createdByClientId_idempot_key" ON "localization_profiles"("workspaceId", "createdByClientId", "idempotencyKey");

CREATE TABLE "localization_variant_heads" (
  "id" VARCHAR(128) NOT NULL, "workspaceId" VARCHAR(128) NOT NULL, "projectId" VARCHAR(128) NOT NULL,
  "canonicalScriptVersionId" VARCHAR(128) NOT NULL, "profileId" VARCHAR(128) NOT NULL, "sourceArtifactId" VARCHAR(128) NOT NULL,
  "sourceSha256" CHAR(64) NOT NULL, "sourceRightsSnapshotId" VARCHAR(128) NOT NULL, "currentRevision" INTEGER NOT NULL,
  "currentVariantHash" CHAR(64) NOT NULL, "status" VARCHAR(32) NOT NULL, "createdByClientId" VARCHAR(80) NOT NULL,
  "createdAt" TIMESTAMPTZ(3) NOT NULL, "updatedAt" TIMESTAMPTZ(3) NOT NULL, CONSTRAINT "localization_variant_heads_pkey" PRIMARY KEY ("id")
);
CREATE UNIQUE INDEX "localization_variant_heads_id_workspaceId_key" ON "localization_variant_heads"("id", "workspaceId");
CREATE INDEX "localization_variant_heads_workspaceId_projectId_status_upd_idx" ON "localization_variant_heads"("workspaceId", "projectId", "status", "updatedAt" DESC);

CREATE TABLE "localization_variant_revisions" (
  "id" VARCHAR(160) NOT NULL, "workspaceId" VARCHAR(128) NOT NULL, "variantId" VARCHAR(128) NOT NULL,
  "revision" INTEGER NOT NULL, "canonicalScriptVersionId" VARCHAR(128) NOT NULL, "localizedAudioAssetId" VARCHAR(128),
  "status" VARCHAR(32) NOT NULL, "stage" VARCHAR(80) NOT NULL, "variantJson" TEXT NOT NULL, "variantHash" CHAR(64) NOT NULL,
  "createdAt" TIMESTAMPTZ(3) NOT NULL, CONSTRAINT "localization_variant_revisions_pkey" PRIMARY KEY ("id")
);
CREATE UNIQUE INDEX "localization_variant_revisions_variantId_revision_key" ON "localization_variant_revisions"("variantId", "revision");
CREATE UNIQUE INDEX "localization_variant_revisions_variantId_variantHash_key" ON "localization_variant_revisions"("variantId", "variantHash");
CREATE INDEX "localization_variant_revisions_workspaceId_canonicalScriptV_idx" ON "localization_variant_revisions"("workspaceId", "canonicalScriptVersionId");

CREATE TABLE "localization_variant_actions" (
  "id" VARCHAR(160) NOT NULL, "workspaceId" VARCHAR(128) NOT NULL, "variantId" VARCHAR(128) NOT NULL, "action" VARCHAR(32) NOT NULL,
  "expectedRevision" INTEGER NOT NULL, "resultRevision" INTEGER NOT NULL, "resultVariantHash" CHAR(64) NOT NULL,
  "requestFingerprint" CHAR(64) NOT NULL, "idempotencyKey" VARCHAR(128) NOT NULL, "actorClientId" VARCHAR(80) NOT NULL,
  "actorCredentialId" VARCHAR(128) NOT NULL, "actorEnvironment" VARCHAR(16) NOT NULL, "actorAuthenticationKind" VARCHAR(16) NOT NULL,
  "actorContextHash" CHAR(64) NOT NULL, "delegatedUserId" VARCHAR(128), "delegatedIdentityId" VARCHAR(128), "workspaceRole" VARCHAR(32),
  "createdAt" TIMESTAMPTZ(3) NOT NULL, CONSTRAINT "localization_variant_actions_pkey" PRIMARY KEY ("id")
);
CREATE UNIQUE INDEX "localization_variant_actions_workspaceId_actorClientId_idem_key" ON "localization_variant_actions"("workspaceId", "actorClientId", "idempotencyKey");
CREATE UNIQUE INDEX "localization_variant_actions_variantId_resultRevision_key" ON "localization_variant_actions"("variantId", "resultRevision");
CREATE INDEX "localization_variant_actions_workspaceId_variantId_createdA_idx" ON "localization_variant_actions"("workspaceId", "variantId", "createdAt" DESC);

ALTER TABLE "localization_canonical_scripts" ADD CONSTRAINT "localization_canonical_scripts_workspace_fkey" FOREIGN KEY ("workspaceId") REFERENCES "workspaces"("id") ON DELETE RESTRICT;
ALTER TABLE "localization_canonical_scripts" ADD CONSTRAINT "localization_canonical_scripts_project_fkey" FOREIGN KEY ("projectId", "workspaceId") REFERENCES "projects"("id", "workspaceId") ON DELETE RESTRICT;
ALTER TABLE "localization_canonical_scripts" ADD CONSTRAINT "localization_canonical_scripts_version_fkey" FOREIGN KEY ("projectVersionId", "projectId", "workspaceId") REFERENCES "project_versions"("id", "projectId", "workspaceId") ON DELETE RESTRICT;
CREATE UNIQUE INDEX "script_alignment_runs_id_projectId_workspaceId_key" ON "script_alignment_runs"("id", "projectId", "workspaceId");
CREATE UNIQUE INDEX "asset_rights_snapshots_id_artifactId_workspaceId_key" ON "asset_rights_snapshots"("id", "artifactId", "workspaceId");
ALTER TABLE "localization_canonical_scripts" ADD CONSTRAINT "localization_canonical_scripts_alignment_fkey" FOREIGN KEY ("alignmentId", "projectId", "workspaceId") REFERENCES "script_alignment_runs"("id", "projectId", "workspaceId") ON DELETE RESTRICT;
ALTER TABLE "localization_canonical_scripts" ADD CONSTRAINT "localization_canonical_scripts_approver_fkey" FOREIGN KEY ("approvedByClientId", "workspaceId") REFERENCES "api_clients"("id", "workspaceId") ON DELETE RESTRICT;
ALTER TABLE "localization_profiles" ADD CONSTRAINT "localization_profiles_workspace_fkey" FOREIGN KEY ("workspaceId") REFERENCES "workspaces"("id") ON DELETE RESTRICT;
ALTER TABLE "localization_profiles" ADD CONSTRAINT "localization_profiles_creator_fkey" FOREIGN KEY ("createdByClientId", "workspaceId") REFERENCES "api_clients"("id", "workspaceId") ON DELETE RESTRICT;
ALTER TABLE "localization_variant_heads" ADD CONSTRAINT "localization_variant_heads_workspace_fkey" FOREIGN KEY ("workspaceId") REFERENCES "workspaces"("id") ON DELETE RESTRICT;
ALTER TABLE "localization_variant_heads" ADD CONSTRAINT "localization_variant_heads_project_fkey" FOREIGN KEY ("projectId", "workspaceId") REFERENCES "projects"("id", "workspaceId") ON DELETE RESTRICT;
ALTER TABLE "localization_variant_heads" ADD CONSTRAINT "localization_variant_heads_canonical_fkey" FOREIGN KEY ("canonicalScriptVersionId", "projectId", "workspaceId") REFERENCES "localization_canonical_scripts"("id", "projectId", "workspaceId") ON DELETE RESTRICT;
ALTER TABLE "localization_variant_heads" ADD CONSTRAINT "localization_variant_heads_profile_fkey" FOREIGN KEY ("profileId", "workspaceId") REFERENCES "localization_profiles"("id", "workspaceId") ON DELETE RESTRICT;
ALTER TABLE "localization_variant_heads" ADD CONSTRAINT "localization_variant_heads_source_fkey" FOREIGN KEY ("sourceArtifactId", "workspaceId") REFERENCES "media_artifacts"("id", "workspaceId") ON DELETE RESTRICT;
ALTER TABLE "localization_variant_heads" ADD CONSTRAINT "localization_variant_heads_rights_fkey" FOREIGN KEY ("sourceRightsSnapshotId", "sourceArtifactId", "workspaceId") REFERENCES "asset_rights_snapshots"("id", "artifactId", "workspaceId") ON DELETE RESTRICT;
ALTER TABLE "localization_variant_heads" ADD CONSTRAINT "localization_variant_heads_creator_fkey" FOREIGN KEY ("createdByClientId", "workspaceId") REFERENCES "api_clients"("id", "workspaceId") ON DELETE RESTRICT;
ALTER TABLE "localization_variant_revisions" ADD CONSTRAINT "localization_variant_revisions_workspace_fkey" FOREIGN KEY ("workspaceId") REFERENCES "workspaces"("id") ON DELETE RESTRICT;
ALTER TABLE "localization_variant_revisions" ADD CONSTRAINT "localization_variant_revisions_variant_fkey" FOREIGN KEY ("variantId", "workspaceId") REFERENCES "localization_variant_heads"("id", "workspaceId") ON DELETE RESTRICT;
ALTER TABLE "localization_variant_revisions" ADD CONSTRAINT "localization_variant_revisions_canonical_fkey" FOREIGN KEY ("canonicalScriptVersionId", "workspaceId") REFERENCES "localization_canonical_scripts"("id", "workspaceId") ON DELETE RESTRICT;
ALTER TABLE "localization_variant_revisions" ADD CONSTRAINT "localization_variant_revisions_audio_fkey" FOREIGN KEY ("localizedAudioAssetId", "workspaceId") REFERENCES "media_artifacts"("id", "workspaceId") ON DELETE RESTRICT;
ALTER TABLE "localization_variant_actions" ADD CONSTRAINT "localization_variant_actions_workspace_fkey" FOREIGN KEY ("workspaceId") REFERENCES "workspaces"("id") ON DELETE RESTRICT;
ALTER TABLE "localization_variant_actions" ADD CONSTRAINT "localization_variant_actions_variant_fkey" FOREIGN KEY ("variantId", "workspaceId") REFERENCES "localization_variant_heads"("id", "workspaceId") ON DELETE RESTRICT;
ALTER TABLE "localization_variant_actions" ADD CONSTRAINT "localization_variant_actions_actor_fkey" FOREIGN KEY ("actorClientId", "workspaceId") REFERENCES "api_clients"("id", "workspaceId") ON DELETE RESTRICT;
ALTER TABLE "localization_canonical_scripts" ADD CONSTRAINT "localization_canonical_scripts_revision_check" CHECK ("revision" >= 1);
ALTER TABLE "localization_variant_heads" ADD CONSTRAINT "localization_variant_heads_revision_check" CHECK ("currentRevision" >= 1);
ALTER TABLE "localization_variant_heads" ADD CONSTRAINT "localization_variant_heads_status_check" CHECK ("status" IN ('draft','translating','audio','visual','review','approved','failed','blocked','stale','cancelled'));
ALTER TABLE "localization_variant_revisions" ADD CONSTRAINT "localization_variant_revisions_revision_check" CHECK ("revision" >= 1);
ALTER TABLE "localization_variant_revisions" ADD CONSTRAINT "localization_variant_revisions_status_check" CHECK ("status" IN ('draft','translating','audio','visual','review','approved','failed','blocked','stale','cancelled'));
ALTER TABLE "localization_variant_actions" ADD CONSTRAINT "localization_variant_actions_revision_check" CHECK ("expectedRevision" >= 0 AND "resultRevision" = "expectedRevision" + 1);
