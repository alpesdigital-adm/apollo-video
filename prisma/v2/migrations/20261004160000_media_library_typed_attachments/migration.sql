ALTER TABLE "edit_commands" DROP CONSTRAINT "edit_commands_type_check";
ALTER TABLE "edit_commands" ADD CONSTRAINT "edit_commands_type_check" CHECK ("type" IN (
  'apply-review-patch',
  'apply-review-patch-batch',
  'apply-subtitle-segment-override',
  'attach-media-library-reference',
  'compare-action',
  'direct-multicam-session',
  'manual-edit',
  'remove-spoken-content',
  'replace-source-transcript',
  'run-director',
  'set-project-color-plan',
  'set-project-lut-selection',
  'set-project-policy-overrides',
  'set-project-subtitle-mode'
));

CREATE TABLE "media_library_attachments" (
  "id" UUID NOT NULL,
  "workspaceId" VARCHAR(128) NOT NULL,
  "projectId" VARCHAR(128) NOT NULL,
  "selectionKind" VARCHAR(16) NOT NULL,
  "selectionId" VARCHAR(128) NOT NULL,
  "parentArtifactId" VARCHAR(128) NOT NULL,
  "sourceSha256" CHAR(64) NOT NULL,
  "rightsSnapshotId" VARCHAR(128) NOT NULL,
  "segmentHash" CHAR(64),
  "semanticRangeJson" TEXT,
  "sourceTimeMappingJson" TEXT,
  "commandId" VARCHAR(128) NOT NULL,
  "baseVersionId" VARCHAR(128) NOT NULL,
  "resultVersionId" VARCHAR(128) NOT NULL,
  "resultVersionHash" CHAR(64) NOT NULL,
  "actorContextHash" CHAR(64) NOT NULL,
  "idempotencyKey" VARCHAR(128) NOT NULL,
  "requestFingerprint" CHAR(64) NOT NULL,
  "createdAt" TIMESTAMPTZ(3) NOT NULL,
  CONSTRAINT "media_library_attachments_pkey" PRIMARY KEY ("id"),
  CONSTRAINT "media_library_attachments_selection_kind_check" CHECK ("selectionKind" IN ('asset', 'segment')),
  CONSTRAINT "media_library_attachments_segment_shape_check" CHECK (("selectionKind" = 'asset' AND "selectionId" = "parentArtifactId" AND "segmentHash" IS NULL AND "semanticRangeJson" IS NULL AND "sourceTimeMappingJson" IS NULL) OR ("selectionKind" = 'segment' AND "segmentHash" IS NOT NULL AND "semanticRangeJson" IS NOT NULL AND "sourceTimeMappingJson" IS NOT NULL))
);

CREATE UNIQUE INDEX "media_library_attachments_commandId_key" ON "media_library_attachments"("commandId");
CREATE UNIQUE INDEX "media_library_attachments_resultVersionId_key" ON "media_library_attachments"("resultVersionId");
CREATE UNIQUE INDEX "media_library_attachments_workspaceId_projectId_idempotencyKey_key" ON "media_library_attachments"("workspaceId", "projectId", "idempotencyKey");
CREATE INDEX "media_library_attachments_workspaceId_projectId_createdAt_idx" ON "media_library_attachments"("workspaceId", "projectId", "createdAt" DESC);
CREATE INDEX "media_library_attachments_workspaceId_selectionKind_selectionId_idx" ON "media_library_attachments"("workspaceId", "selectionKind", "selectionId");

ALTER TABLE "media_library_attachments" ADD CONSTRAINT "media_library_attachments_project_fkey" FOREIGN KEY ("projectId", "workspaceId") REFERENCES "projects"("id", "workspaceId") ON DELETE CASCADE ON UPDATE CASCADE;
ALTER TABLE "media_library_attachments" ADD CONSTRAINT "media_library_attachments_source_fkey" FOREIGN KEY ("parentArtifactId", "workspaceId") REFERENCES "media_artifacts"("id", "workspaceId") ON DELETE RESTRICT ON UPDATE CASCADE;
ALTER TABLE "media_library_attachments" ADD CONSTRAINT "media_library_attachments_rights_fkey" FOREIGN KEY ("rightsSnapshotId", "workspaceId") REFERENCES "asset_rights_snapshots"("id", "workspaceId") ON DELETE RESTRICT ON UPDATE CASCADE;
ALTER TABLE "media_library_attachments" ADD CONSTRAINT "media_library_attachments_command_fkey" FOREIGN KEY ("commandId", "workspaceId") REFERENCES "edit_commands"("id", "workspaceId") ON DELETE RESTRICT ON UPDATE CASCADE;
ALTER TABLE "media_library_attachments" ADD CONSTRAINT "media_library_attachments_base_version_fkey" FOREIGN KEY ("baseVersionId", "workspaceId") REFERENCES "project_versions"("id", "workspaceId") ON DELETE RESTRICT ON UPDATE CASCADE;
ALTER TABLE "media_library_attachments" ADD CONSTRAINT "media_library_attachments_result_version_fkey" FOREIGN KEY ("resultVersionId", "workspaceId") REFERENCES "project_versions"("id", "workspaceId") ON DELETE RESTRICT ON UPDATE CASCADE;
