CREATE TABLE "subtitle_segment_overrides" (
  "id" VARCHAR(128) PRIMARY KEY,
  "workspaceId" VARCHAR(128) NOT NULL,
  "projectId" VARCHAR(128) NOT NULL,
  "commandId" VARCHAR(128) NOT NULL,
  "baseVersionId" VARCHAR(128) NOT NULL,
  "resultVersionId" VARCHAR(128) NOT NULL,
  "variantId" VARCHAR(128) NOT NULL,
  "segmentId" VARCHAR(128) NOT NULL,
  "startFrame" INTEGER NOT NULL,
  "endFrame" INTEGER NOT NULL,
  "action" VARCHAR(16) NOT NULL,
  "dimensionKinds" VARCHAR(128) NOT NULL,
  "isProtected" BOOLEAN NOT NULL,
  "previousOverrideId" VARCHAR(128),
  "overrideJson" TEXT NOT NULL,
  "overrideHash" CHAR(64) NOT NULL,
  "impactJson" TEXT NOT NULL,
  "impactHash" CHAR(64) NOT NULL,
  "createdAt" TIMESTAMPTZ(3) NOT NULL,
  CONSTRAINT "subtitle_segment_overrides_action_check" CHECK ("action" IN ('set','reset')),
  -- Half-open [startFrame, endFrame): the end is exclusive and a zero-length range is not a range.
  CONSTRAINT "subtitle_segment_overrides_range_check" CHECK ("startFrame" >= 0 AND "endFrame" > "startFrame"),
  CONSTRAINT "subtitle_segment_overrides_reset_check" CHECK ("action" <> 'reset' OR "previousOverrideId" IS NOT NULL),
  CONSTRAINT "subtitle_segment_overrides_chain_check" CHECK ("previousOverrideId" IS NULL OR "previousOverrideId" <> "id"),
  -- The four overridable dimensions of FR-174, stored sorted and comma separated.
  -- An empty list means the segment went back to the inherited resolution, and only
  -- a `reset` may say that; nothing inherited can be protected.
  CONSTRAINT "subtitle_segment_overrides_dimensions_check" CHECK (
    "dimensionKinds" = ''
    OR "dimensionKinds" ~ '^(position|style|text|visibility)(,(position|style|text|visibility))*$'
  ),
  CONSTRAINT "subtitle_segment_overrides_set_dimensions_check" CHECK ("action" <> 'set' OR "dimensionKinds" <> ''),
  CONSTRAINT "subtitle_segment_overrides_protection_check" CHECK ("dimensionKinds" <> '' OR "isProtected" = FALSE)
);
CREATE UNIQUE INDEX "subtitle_segment_overrides_id_workspaceId_key" ON "subtitle_segment_overrides"("id","workspaceId");
CREATE UNIQUE INDEX "subtitle_segment_overrides_commandId_workspaceId_key" ON "subtitle_segment_overrides"("commandId","workspaceId");
CREATE UNIQUE INDEX "subtitle_segment_overrides_resultVersionId_workspaceId_key" ON "subtitle_segment_overrides"("resultVersionId","workspaceId");
CREATE UNIQUE INDEX "subtitle_segment_overrides_previousOverrideId_workspaceId_key" ON "subtitle_segment_overrides"("previousOverrideId","workspaceId");
CREATE INDEX "subtitle_segment_overrides_workspaceId_projectId_variantId__idx" ON "subtitle_segment_overrides"("workspaceId","projectId","variantId","segmentId","createdAt" DESC);
CREATE INDEX "subtitle_segment_overrides_workspaceId_projectId_baseVersio_idx" ON "subtitle_segment_overrides"("workspaceId","projectId","baseVersionId");

CREATE TABLE "subtitle_segment_override_heads" (
  "workspaceId" VARCHAR(128) NOT NULL,
  "projectId" VARCHAR(128) NOT NULL,
  "variantId" VARCHAR(128) NOT NULL,
  "segmentId" VARCHAR(128) NOT NULL,
  "overrideId" VARCHAR(128) NOT NULL,
  "updatedAt" TIMESTAMPTZ(3) NOT NULL,
  CONSTRAINT "subtitle_segment_override_heads_pkey" PRIMARY KEY ("projectId","workspaceId","variantId","segmentId")
);
CREATE UNIQUE INDEX "subtitle_segment_override_heads_overrideId_workspaceId_key" ON "subtitle_segment_override_heads"("overrideId","workspaceId");

ALTER TABLE "subtitle_segment_overrides" ADD CONSTRAINT "subtitle_segment_overrides_workspaceId_fkey" FOREIGN KEY ("workspaceId") REFERENCES "workspaces"("id") ON DELETE CASCADE ON UPDATE CASCADE;
ALTER TABLE "subtitle_segment_overrides" ADD CONSTRAINT "subtitle_segment_overrides_projectId_workspaceId_fkey" FOREIGN KEY ("projectId","workspaceId") REFERENCES "projects"("id","workspaceId") ON DELETE CASCADE ON UPDATE CASCADE;
ALTER TABLE "subtitle_segment_overrides" ADD CONSTRAINT "subtitle_segment_overrides_commandId_workspaceId_fkey" FOREIGN KEY ("commandId","workspaceId") REFERENCES "edit_commands"("id","workspaceId") ON DELETE RESTRICT ON UPDATE CASCADE;
ALTER TABLE "subtitle_segment_overrides" ADD CONSTRAINT "subtitle_segment_overrides_baseVersionId_workspaceId_fkey" FOREIGN KEY ("baseVersionId","workspaceId") REFERENCES "project_versions"("id","workspaceId") ON DELETE RESTRICT ON UPDATE CASCADE;
ALTER TABLE "subtitle_segment_overrides" ADD CONSTRAINT "subtitle_segment_overrides_resultVersionId_workspaceId_fkey" FOREIGN KEY ("resultVersionId","workspaceId") REFERENCES "project_versions"("id","workspaceId") ON DELETE RESTRICT ON UPDATE CASCADE;
ALTER TABLE "subtitle_segment_overrides" ADD CONSTRAINT "subtitle_segment_overrides_previousOverrideId_workspaceId_fkey" FOREIGN KEY ("previousOverrideId","workspaceId") REFERENCES "subtitle_segment_overrides"("id","workspaceId") ON DELETE RESTRICT ON UPDATE CASCADE;
ALTER TABLE "subtitle_segment_override_heads" ADD CONSTRAINT "subtitle_segment_override_heads_workspaceId_fkey" FOREIGN KEY ("workspaceId") REFERENCES "workspaces"("id") ON DELETE CASCADE ON UPDATE CASCADE;
ALTER TABLE "subtitle_segment_override_heads" ADD CONSTRAINT "subtitle_segment_override_heads_projectId_workspaceId_fkey" FOREIGN KEY ("projectId","workspaceId") REFERENCES "projects"("id","workspaceId") ON DELETE CASCADE ON UPDATE CASCADE;
ALTER TABLE "subtitle_segment_override_heads" ADD CONSTRAINT "subtitle_segment_override_heads_overrideId_workspaceId_fkey" FOREIGN KEY ("overrideId","workspaceId") REFERENCES "subtitle_segment_overrides"("id","workspaceId") ON DELETE RESTRICT ON UPDATE CASCADE;

-- The canonical EditCommand registry gained `apply-subtitle-segment-override`; the
-- closed PostgreSQL constraint has to say exactly the same thing as
-- src/v2/domain/edit-command-registry.ts, and tests/v2/edit-command-registry.test.mjs
-- compares the two.
ALTER TABLE "edit_commands"
  DROP CONSTRAINT "edit_commands_type_check";

ALTER TABLE "edit_commands"
  ADD CONSTRAINT "edit_commands_type_check"
  CHECK ("type" IN (
      'remove-spoken-content',
      'run-director',
      'apply-review-patch',
      'apply-review-patch-batch',
      'apply-subtitle-segment-override',
      'manual-edit',
      'compare-action',
      'replace-source-transcript',
      'set-project-lut-selection',
      'set-project-policy-overrides',
      'set-project-subtitle-mode'
    ));
