-- W66 review slice. Applying this migration intentionally blocks every Version
-- writer until the complete output-state cutover is integrated. No runtime
-- fallback, inferred variant, rewritten historical hash or contract-0 INSERT.
ALTER TABLE "project_versions" ADD COLUMN "outputContractVersion" INTEGER NOT NULL DEFAULT 0,
  ADD COLUMN "outputStateId" VARCHAR(128), ADD COLUMN "outputStateHash" CHAR(64), ADD COLUMN "outputBaseHashJson" TEXT;
ALTER TABLE "project_versions" ALTER COLUMN "outputContractVersion" SET DEFAULT 1;
CREATE UNIQUE INDEX "project_versions_output_binding_key" ON "project_versions" ("id", "outputStateId", "projectId", "workspaceId", "outputStateHash");
ALTER TABLE "edit_commands" ADD COLUMN "commandHash" CHAR(64), ADD COLUMN "commandJson" TEXT;
ALTER TABLE "edit_commands" ADD COLUMN "outputPayloadJson" TEXT, ADD COLUMN "outputPayloadHash" CHAR(64);
CREATE UNIQUE INDEX "edit_commands_output_seal_key" ON "edit_commands" ("id", "projectId", "workspaceId", "commandHash");
CREATE UNIQUE INDEX "project_snapshots_output_seal_key" ON "project_snapshots" ("id", "projectId", "workspaceId", "contentHash");
CREATE UNIQUE INDEX "public_operations_output_seal_key" ON "public_operations" ("id", "projectId", "workspaceId", "requestFingerprint");
CREATE UNIQUE INDEX "media_ingest_output_context_key" ON "media_ingest_operations" ("operationId", "projectId", "workspaceId", "sourceArtifactId", "sourceManifestId");
CREATE UNIQUE INDEX "media_manifests_output_seal_key" ON "media_artifact_manifests" ("id", "artifactId", "workspaceId", "manifestHash");
CREATE UNIQUE INDEX "media_transcripts_output_seal_key" ON "media_transcripts" ("id", "projectId", "workspaceId", "sourceArtifactId", "sourceManifestId", "transcriptHash");
ALTER TABLE "edit_commands" ADD CONSTRAINT "edit_commands_document_seal_check" CHECK (
  ("commandHash" IS NULL AND "commandJson" IS NULL) OR
  ("commandHash" IS NOT NULL AND "commandJson" IS NOT NULL AND
   "commandHash" = encode(sha256(convert_to("commandJson", 'UTF8')), 'hex'))
);
ALTER TABLE "edit_commands" ADD CONSTRAINT "edit_commands_output_payload_seal_check" CHECK (
  ("type" NOT IN ('create-output-variant', 'revise-output-spec') AND "outputPayloadJson" IS NULL AND "outputPayloadHash" IS NULL) OR
  ("type" IN ('create-output-variant', 'revise-output-spec') AND "commandHash" IS NOT NULL AND "commandJson" IS NOT NULL
    AND "outputPayloadJson" IS NOT NULL AND "outputPayloadHash" IS NOT NULL AND "outputPayloadHash" ~ '^[a-f0-9]{64}$'
    AND "outputPayloadHash" = encode(sha256(convert_to("outputPayloadJson", 'UTF8')), 'hex')
    AND ("outputPayloadJson"::jsonb ->> 'canonicalPolicyVersion') IS NOT DISTINCT FROM 'output-canonical-json/v1'
    AND ("commandJson"::jsonb -> 'payload') IS NOT DISTINCT FROM "outputPayloadJson"::jsonb)
);
ALTER TABLE "edit_commands" DROP CONSTRAINT "edit_commands_type_check";
ALTER TABLE "edit_commands" ADD CONSTRAINT "edit_commands_type_check" CHECK ("type" IN (
  'apply-review-patch', 'apply-review-patch-batch', 'apply-subtitle-segment-override',
  'attach-media-library-reference', 'compare-action', 'direct-multicam-session', 'manual-edit', 'remove-spoken-content',
  'replace-source-transcript', 'run-director', 'set-project-color-plan',
  'set-project-lut-selection', 'set-project-policy-overrides', 'set-project-subtitle-mode',
  'create-output-variant', 'revise-output-spec'
));

CREATE TABLE "output_variants" (
  "id" VARCHAR(128) PRIMARY KEY, "projectId" VARCHAR(128) NOT NULL,
  "workspaceId" VARCHAR(128) NOT NULL, "createdCommandKind" VARCHAR(32) NOT NULL,
  "createdCommandId" VARCHAR(128) NOT NULL, "createdCommandHash" CHAR(64) NOT NULL,
  "createdAt" TIMESTAMPTZ(3) NOT NULL,
  CONSTRAINT "output_variants_scope_key" UNIQUE ("id", "projectId", "workspaceId"),
  CONSTRAINT "output_variants_project_fk" FOREIGN KEY ("projectId", "workspaceId")
    REFERENCES "projects" ("id", "workspaceId") ON DELETE RESTRICT ON UPDATE RESTRICT,
  CHECK ("createdCommandKind" = 'edit-command'),
  CHECK ("createdCommandHash" ~ '^[a-f0-9]{64}$')
);
CREATE INDEX "output_variants_workspaceId_projectId_idx" ON "output_variants" ("workspaceId", "projectId");
CREATE TABLE "output_spec_revisions" (
  "id" VARCHAR(128) PRIMARY KEY, "variantId" VARCHAR(128) NOT NULL,
  "projectId" VARCHAR(128) NOT NULL, "workspaceId" VARCHAR(128) NOT NULL,
  "revisionNumber" INTEGER NOT NULL, "schemaVersion" VARCHAR(64) NOT NULL,
  "canonicalPolicyVersion" VARCHAR(64) NOT NULL,
  "specJson" TEXT NOT NULL, "specHash" CHAR(64) NOT NULL,
  "createdCommandKind" VARCHAR(32) NOT NULL, "createdCommandId" VARCHAR(128) NOT NULL,
  "createdCommandHash" CHAR(64) NOT NULL, "createdAt" TIMESTAMPTZ(3) NOT NULL,
  CONSTRAINT "output_spec_revisions_number_key" UNIQUE ("variantId", "revisionNumber", "projectId", "workspaceId"),
  CONSTRAINT "output_spec_revisions_seal_key" UNIQUE ("id", "variantId", "projectId", "workspaceId", "specHash"),
  CONSTRAINT "output_spec_revisions_variant_fk" FOREIGN KEY ("variantId", "projectId", "workspaceId")
    REFERENCES "output_variants" ("id", "projectId", "workspaceId") ON DELETE RESTRICT ON UPDATE RESTRICT,
  CHECK ("revisionNumber" > 0 AND "schemaVersion" = 'output-spec-revision/v1'),
  CHECK ("canonicalPolicyVersion" = 'output-canonical-json/v1'),
  CHECK (("specJson"::jsonb ->> 'canonicalPolicyVersion') IS NOT DISTINCT FROM "canonicalPolicyVersion"),
  CHECK ("createdCommandKind" = 'edit-command'),
  CHECK ("createdCommandHash" ~ '^[a-f0-9]{64}$'),
  CHECK ("specHash" = encode(sha256(convert_to("specJson", 'UTF8')), 'hex'))
);
CREATE TABLE "project_output_states" (
  "id" VARCHAR(128) PRIMARY KEY, "projectId" VARCHAR(128) NOT NULL,
  "workspaceId" VARCHAR(128) NOT NULL, "resultVersionId" VARCHAR(128) NOT NULL,
  "parentVersionId" VARCHAR(128), "parentStateId" VARCHAR(128), "parentStateHash" CHAR(64),
  "schemaVersion" VARCHAR(64) NOT NULL, "transition" VARCHAR(32) NOT NULL,
  "canonicalPolicyVersion" VARCHAR(64) NOT NULL,
  "transitionPolicyVersion" VARCHAR(64) NOT NULL,
  "producerKind" VARCHAR(32) NOT NULL, "producerId" VARCHAR(128) NOT NULL,
  "provenanceHash" CHAR(64) NOT NULL, "producerHash" CHAR(64) NOT NULL, "producerJson" TEXT NOT NULL,
  "producerEditCommandId" VARCHAR(128), "ingestOperationId" VARCHAR(128),
  "ingestSourceArtifactId" VARCHAR(128), "ingestSourceManifestId" VARCHAR(128), "ingestSourceManifestHash" CHAR(64),
  "ingestTranscriptId" VARCHAR(128), "ingestTranscriptHash" CHAR(64),
  "editPlanSnapshotId" VARCHAR(128) NOT NULL, "editPlanHash" CHAR(64) NOT NULL,
  "editPlanAuthorityJson" TEXT NOT NULL, "editPlanAuthorityHash" CHAR(64) NOT NULL,
  "renderablePlanSnapshotId" VARCHAR(200), "renderablePlanId" VARCHAR(200), "renderablePlanHash" CHAR(64),
  "renderablePlanAuthorityJson" TEXT, "renderablePlanAuthorityHash" CHAR(64),
  "stateJson" TEXT NOT NULL, "stateHash" CHAR(64) NOT NULL, "createdAt" TIMESTAMPTZ(3) NOT NULL,
  CONSTRAINT "project_output_states_scope_key" UNIQUE ("id", "projectId", "workspaceId"),
  CONSTRAINT "project_output_states_result_key" UNIQUE ("resultVersionId", "projectId", "workspaceId"),
  CONSTRAINT "project_output_states_producer_key" UNIQUE ("producerKind", "producerId", "workspaceId"),
  CONSTRAINT "project_output_states_version_seal_key" UNIQUE ("resultVersionId", "id", "projectId", "workspaceId", "stateHash"),
  CONSTRAINT "project_output_states_project_fk" FOREIGN KEY ("projectId", "workspaceId")
    REFERENCES "projects" ("id", "workspaceId") ON DELETE RESTRICT ON UPDATE RESTRICT,
  CONSTRAINT "project_output_states_edit_plan_seal_fk" FOREIGN KEY ("editPlanSnapshotId", "projectId", "workspaceId", "editPlanHash")
    REFERENCES "project_snapshots" ("id", "projectId", "workspaceId", "contentHash") ON DELETE RESTRICT ON UPDATE RESTRICT DEFERRABLE INITIALLY DEFERRED,
  CONSTRAINT "project_output_states_edit_command_seal_fk" FOREIGN KEY ("producerEditCommandId", "projectId", "workspaceId", "provenanceHash")
    REFERENCES "edit_commands" ("id", "projectId", "workspaceId", "commandHash") ON DELETE RESTRICT ON UPDATE RESTRICT DEFERRABLE INITIALLY DEFERRED,
  CONSTRAINT "project_output_states_ingest_operation_seal_fk" FOREIGN KEY ("ingestOperationId", "projectId", "workspaceId", "provenanceHash")
    REFERENCES "public_operations" ("id", "projectId", "workspaceId", "requestFingerprint") ON DELETE RESTRICT ON UPDATE RESTRICT DEFERRABLE INITIALLY DEFERRED,
  CONSTRAINT "project_output_states_ingest_context_seal_fk" FOREIGN KEY ("ingestOperationId", "projectId", "workspaceId", "ingestSourceArtifactId", "ingestSourceManifestId")
    REFERENCES "media_ingest_operations" ("operationId", "projectId", "workspaceId", "sourceArtifactId", "sourceManifestId") ON DELETE RESTRICT ON UPDATE RESTRICT DEFERRABLE INITIALLY DEFERRED,
  CONSTRAINT "project_output_states_ingest_manifest_seal_fk" FOREIGN KEY ("ingestSourceManifestId", "ingestSourceArtifactId", "workspaceId", "ingestSourceManifestHash")
    REFERENCES "media_artifact_manifests" ("id", "artifactId", "workspaceId", "manifestHash") ON DELETE RESTRICT ON UPDATE RESTRICT DEFERRABLE INITIALLY DEFERRED,
  CONSTRAINT "project_output_states_ingest_transcript_seal_fk" FOREIGN KEY ("ingestTranscriptId", "projectId", "workspaceId", "ingestSourceArtifactId", "ingestSourceManifestId", "ingestTranscriptHash")
    REFERENCES "media_transcripts" ("id", "projectId", "workspaceId", "sourceArtifactId", "sourceManifestId", "transcriptHash") ON DELETE RESTRICT ON UPDATE RESTRICT DEFERRABLE INITIALLY DEFERRED,
  CONSTRAINT "project_output_states_parent_version_fk" FOREIGN KEY ("parentVersionId", "projectId", "workspaceId")
    REFERENCES "project_versions" ("id", "projectId", "workspaceId") ON DELETE RESTRICT ON UPDATE RESTRICT,
  CONSTRAINT "project_output_states_parent_seal_fk" FOREIGN KEY
    ("parentVersionId", "parentStateId", "projectId", "workspaceId", "parentStateHash") REFERENCES "project_output_states"
    ("resultVersionId", "id", "projectId", "workspaceId", "stateHash") ON DELETE RESTRICT ON UPDATE RESTRICT,
  CHECK ("schemaVersion" = 'project-output-state/v1'),
  CHECK ("canonicalPolicyVersion" = 'output-canonical-json/v1'),
  CHECK (("stateJson"::jsonb ->> 'canonicalPolicyVersion') IS NOT DISTINCT FROM "canonicalPolicyVersion"),
  CHECK (("producerJson"::jsonb ->> 'canonicalPolicyVersion') IS NOT DISTINCT FROM "canonicalPolicyVersion"),
  CHECK ("transitionPolicyVersion" = 'project-output-transition/v1'),
  CHECK ("transition" IN ('initialize-empty', 'create-variant', 'revise-output', 'inherit', 'set-overlay', 'reset-overlay', 'invalidate', 'restore', 'fork-empty')),
  CHECK ("producerKind" IN ('creation-command', 'edit-command', 'media-ingest-operation')),
  CHECK (("producerKind" = 'edit-command' AND "producerEditCommandId" IS NOT NULL AND "producerEditCommandId" = "producerId") OR
    ("producerKind" <> 'edit-command' AND "producerEditCommandId" IS NULL)),
  CHECK (("producerKind" = 'media-ingest-operation' AND "ingestOperationId" IS NOT NULL AND "ingestOperationId" = "producerId"
    AND "ingestSourceArtifactId" IS NOT NULL AND "ingestSourceManifestId" IS NOT NULL AND "ingestSourceManifestHash" IS NOT NULL
    AND "ingestTranscriptId" IS NOT NULL AND "ingestTranscriptHash" IS NOT NULL
    AND "ingestSourceManifestHash" ~ '^[a-f0-9]{64}$' AND "ingestTranscriptHash" ~ '^[a-f0-9]{64}$') OR
    ("producerKind" <> 'media-ingest-operation' AND "ingestOperationId" IS NULL AND "ingestSourceArtifactId" IS NULL
    AND "ingestSourceManifestId" IS NULL AND "ingestSourceManifestHash" IS NULL AND "ingestTranscriptId" IS NULL AND "ingestTranscriptHash" IS NULL)),
  CHECK ("provenanceHash" ~ '^[a-f0-9]{64}$' AND "editPlanHash" ~ '^[a-f0-9]{64}$'),
  CHECK (("parentStateId" IS NULL AND "parentStateHash" IS NULL) OR
    ("parentVersionId" IS NOT NULL AND "parentStateId" IS NOT NULL AND "parentStateHash" IS NOT NULL AND "parentStateHash" ~ '^[a-f0-9]{64}$')),
  CHECK ("editPlanAuthorityHash" ~ '^[a-f0-9]{64}$' AND
    "editPlanAuthorityHash" = encode(sha256(convert_to("editPlanAuthorityJson", 'UTF8')), 'hex')),
  CHECK (("renderablePlanSnapshotId" IS NULL AND "renderablePlanId" IS NULL AND "renderablePlanHash" IS NULL AND
      "renderablePlanAuthorityJson" IS NULL AND "renderablePlanAuthorityHash" IS NULL) OR
    ("renderablePlanSnapshotId" IS NOT NULL AND "renderablePlanId" IS NOT NULL AND "renderablePlanHash" IS NOT NULL AND
      "renderablePlanHash" ~ '^[a-f0-9]{64}$' AND "renderablePlanAuthorityJson" IS NOT NULL AND "renderablePlanAuthorityHash" IS NOT NULL AND
      "renderablePlanAuthorityHash" ~ '^[a-f0-9]{64}$' AND
      "renderablePlanAuthorityHash" = encode(sha256(convert_to("renderablePlanAuthorityJson", 'UTF8')), 'hex'))),
  CHECK ("producerHash" = encode(sha256(convert_to("producerJson", 'UTF8')), 'hex')),
  CHECK ("stateHash" = encode(sha256(convert_to("stateJson", 'UTF8')), 'hex'))
);
ALTER TABLE "project_versions" ADD CONSTRAINT "project_versions_output_contract_check" CHECK (
  ("outputContractVersion" = 0 AND "outputStateId" IS NULL AND "outputStateHash" IS NULL AND "outputBaseHashJson" IS NULL) OR
  ("outputContractVersion" = 1 AND "outputStateId" IS NOT NULL AND "outputStateHash" IS NOT NULL AND "outputStateHash" ~ '^[a-f0-9]{64}$'
    AND "outputBaseHashJson" IS NOT NULL AND "baseHash" = encode(sha256(convert_to("outputBaseHashJson", 'UTF8')), 'hex'))
);
ALTER TABLE "project_versions" ADD CONSTRAINT "project_versions_exact_output_state_fk" FOREIGN KEY
  ("id", "outputStateId", "projectId", "workspaceId", "outputStateHash") REFERENCES "project_output_states"
  ("resultVersionId", "id", "projectId", "workspaceId", "stateHash") ON DELETE RESTRICT ON UPDATE RESTRICT;

CREATE TABLE "project_output_state_entries" (
  "stateId" VARCHAR(128) NOT NULL, "variantId" VARCHAR(128) NOT NULL,
  "projectId" VARCHAR(128) NOT NULL, "workspaceId" VARCHAR(128) NOT NULL,
  "outputSpecRevisionId" VARCHAR(128) NOT NULL, "specHash" CHAR(64) NOT NULL,
  "canonicalPolicyVersion" VARCHAR(64) NOT NULL,
  "geometryStatus" VARCHAR(16) NOT NULL, "geometryProjectionHash" CHAR(64),
  "entryJson" TEXT NOT NULL, "entryHash" CHAR(64) NOT NULL,
  PRIMARY KEY ("stateId", "variantId"),
  CONSTRAINT "project_output_entries_scope_key" UNIQUE ("stateId", "variantId", "projectId", "workspaceId"),
  CONSTRAINT "project_output_entries_state_fk" FOREIGN KEY ("stateId", "projectId", "workspaceId")
    REFERENCES "project_output_states" ("id", "projectId", "workspaceId") ON DELETE RESTRICT ON UPDATE RESTRICT,
  CONSTRAINT "project_output_entries_revision_seal_fk" FOREIGN KEY
    ("outputSpecRevisionId", "variantId", "projectId", "workspaceId", "specHash") REFERENCES "output_spec_revisions"
    ("id", "variantId", "projectId", "workspaceId", "specHash") ON DELETE RESTRICT ON UPDATE RESTRICT,
  CHECK (("geometryStatus" = 'unmaterialized' AND "geometryProjectionHash" IS NULL) OR
    ("geometryStatus" = 'verified' AND "geometryProjectionHash" IS NOT NULL AND "geometryProjectionHash" ~ '^[a-f0-9]{64}$')),
  CHECK ("canonicalPolicyVersion" = 'output-canonical-json/v1'),
  CHECK (("entryJson"::jsonb ->> 'canonicalPolicyVersion') IS NOT DISTINCT FROM "canonicalPolicyVersion"),
  CHECK ("geometryStatus" <> 'verified' OR
    ("entryJson"::jsonb #>> '{geometry,projection,canonicalPolicyVersion}') IS NOT DISTINCT FROM "canonicalPolicyVersion"),
  CHECK ("entryHash" = encode(sha256(convert_to("entryJson", 'UTF8')), 'hex'))
);
CREATE TABLE "project_output_state_overlays" (
  "id" VARCHAR(128) NOT NULL, "stateId" VARCHAR(128) NOT NULL, "variantId" VARCHAR(128) NOT NULL,
  "projectId" VARCHAR(128) NOT NULL, "workspaceId" VARCHAR(128) NOT NULL,
  "kind" VARCHAR(32) NOT NULL, "clipId" VARCHAR(128) NOT NULL,
  "canonicalPolicyVersion" VARCHAR(64) NOT NULL,
  "startFrame" INTEGER NOT NULL, "endFrame" INTEGER NOT NULL, "status" VARCHAR(16) NOT NULL,
  "originalCommandId" VARCHAR(128) NOT NULL, "originalCommandHash" CHAR(64) NOT NULL,
  "overlayJson" TEXT NOT NULL, "overlayHash" CHAR(64) NOT NULL,
  PRIMARY KEY ("stateId", "id"),
  CONSTRAINT "project_output_overlays_entry_fk" FOREIGN KEY ("stateId", "variantId", "projectId", "workspaceId")
    REFERENCES "project_output_state_entries" ("stateId", "variantId", "projectId", "workspaceId") ON DELETE RESTRICT ON UPDATE RESTRICT,
  CONSTRAINT "project_output_overlays_command_seal_fk" FOREIGN KEY ("originalCommandId", "projectId", "workspaceId", "originalCommandHash")
    REFERENCES "edit_commands" ("id", "projectId", "workspaceId", "commandHash") ON DELETE RESTRICT ON UPDATE RESTRICT DEFERRABLE INITIALLY DEFERRED,
  CHECK ("kind" = 'crop'),
  CHECK ("canonicalPolicyVersion" = 'output-canonical-json/v1'),
  CHECK (("overlayJson"::jsonb ->> 'canonicalPolicyVersion') IS NOT DISTINCT FROM "canonicalPolicyVersion"),
  CHECK (("overlayJson"::jsonb #>> '{document,document,canonicalPolicyVersion}') IS NOT DISTINCT FROM "canonicalPolicyVersion"),
  CHECK ("startFrame" >= 0 AND "endFrame" > "startFrame" AND "status" IN ('active', 'invalidated')),
  CHECK ("originalCommandHash" ~ '^[a-f0-9]{64}$'),
  CHECK ("overlayHash" = encode(sha256(convert_to("overlayJson", 'UTF8')), 'hex'))
);
CREATE INDEX "project_output_overlays_range_idx" ON "project_output_state_overlays" ("stateId", "variantId", "clipId", "startFrame", "endFrame");
CREATE TABLE "project_output_state_invalidations" (
  "id" VARCHAR(128) NOT NULL, "stateId" VARCHAR(128) NOT NULL, "variantId" VARCHAR(128) NOT NULL,
  "projectId" VARCHAR(128) NOT NULL, "workspaceId" VARCHAR(128) NOT NULL,
  "overlayId" VARCHAR(128), "kind" VARCHAR(32) NOT NULL, "reasonCode" VARCHAR(80) NOT NULL,
  "canonicalPolicyVersion" VARCHAR(64) NOT NULL,
  "previousDependencyHash" CHAR(64) NOT NULL, "nextDependencyHash" CHAR(64) NOT NULL,
  "causedByKind" VARCHAR(32) NOT NULL, "causedById" VARCHAR(128) NOT NULL, "causedByHash" CHAR(64) NOT NULL,
  "invalidationJson" TEXT NOT NULL, "invalidationHash" CHAR(64) NOT NULL,
  PRIMARY KEY ("stateId", "id"),
  CONSTRAINT "project_output_invalidations_entry_fk" FOREIGN KEY ("stateId", "variantId", "projectId", "workspaceId")
    REFERENCES "project_output_state_entries" ("stateId", "variantId", "projectId", "workspaceId") ON DELETE RESTRICT ON UPDATE RESTRICT,
  CHECK ("causedByKind" IN ('creation-command', 'edit-command', 'media-ingest-operation')),
  CHECK ("kind" IN ('crop', 'render', 'critic', 'sidecar')),
  CHECK ("canonicalPolicyVersion" = 'output-canonical-json/v1'),
  CHECK (("invalidationJson"::jsonb ->> 'canonicalPolicyVersion') IS NOT DISTINCT FROM "canonicalPolicyVersion"),
  CHECK (("invalidationJson"::jsonb #>> '{document,document,canonicalPolicyVersion}') IS NOT DISTINCT FROM "canonicalPolicyVersion"),
  CHECK ("previousDependencyHash" ~ '^[a-f0-9]{64}$' AND "nextDependencyHash" ~ '^[a-f0-9]{64}$' AND "causedByHash" ~ '^[a-f0-9]{64}$'),
  CHECK ("invalidationHash" = encode(sha256(convert_to("invalidationJson", 'UTF8')), 'hex'))
);

CREATE FUNCTION w66_output_immutable() RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN
  RAISE EXCEPTION 'W66 immutable record: % %', TG_TABLE_NAME, TG_OP USING ERRCODE = '23514';
END $$;
CREATE FUNCTION w66_version_insert_contract() RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN
  IF NEW."outputContractVersion" IS DISTINCT FROM 1 THEN
    RAISE EXCEPTION 'W66 contract 0 is migration audit history only' USING ERRCODE = '23514';
  END IF;
  RETURN NEW;
END $$;
CREATE TRIGGER project_versions_output_insert BEFORE INSERT ON "project_versions"
  FOR EACH ROW EXECUTE FUNCTION w66_version_insert_contract();
CREATE TRIGGER project_versions_immutable BEFORE UPDATE OR DELETE ON "project_versions"
  FOR EACH ROW EXECUTE FUNCTION w66_output_immutable();
DO $$ DECLARE table_name text; BEGIN
  FOREACH table_name IN ARRAY ARRAY['output_variants', 'output_spec_revisions', 'project_output_states',
    'project_output_state_entries', 'project_output_state_overlays', 'project_output_state_invalidations'] LOOP
    EXECUTE format('CREATE TRIGGER %I BEFORE UPDATE OR DELETE ON %I FOR EACH ROW EXECUTE FUNCTION w66_output_immutable()', table_name || '_immutable', table_name);
  END LOOP;
END $$;

-- No immediate FK toward a future Command or future RenderablePlanSnapshot.
-- This function reads final transaction state, including entities inserted later.
CREATE FUNCTION w66_assert_provenance(kind text, identity text, seal text, project_id text, workspace_id text, result_version_id text DEFAULT NULL)
RETURNS void LANGUAGE plpgsql AS $$
BEGIN
  IF kind = 'creation-command' THEN
    IF NOT EXISTS (SELECT 1 FROM "project_creation_commands" c WHERE c."id" = identity
      AND c."projectId" = project_id AND c."workspaceId" = workspace_id AND c."commandHash" = seal
      AND (result_version_id IS NULL OR c."versionId" = result_version_id)) THEN
      RAISE EXCEPTION 'W66 creation Command provenance mismatch' USING ERRCODE = '23514';
    END IF;
  ELSIF kind = 'edit-command' THEN
    IF NOT EXISTS (SELECT 1 FROM "edit_commands" c WHERE c."id" = identity AND c."projectId" = project_id
      AND c."workspaceId" = workspace_id AND c."commandHash" = seal AND c."commandJson" IS NOT NULL
      AND c."commandJson"::jsonb ->> 'id' = c."id" AND c."commandJson"::jsonb ->> 'workspaceId' = c."workspaceId"
      AND c."commandJson"::jsonb ->> 'projectId' = c."projectId" AND c."commandJson"::jsonb ->> 'type' = c."type"
      AND c."commandJson"::jsonb ->> 'baseVersionId' = c."baseVersionId" AND c."commandJson"::jsonb ->> 'baseHash' = c."baseHash"
      AND c."commandJson"::jsonb -> 'scope' = c."scopeJson"::jsonb AND c."commandJson"::jsonb -> 'payload' = c."payloadJson"::jsonb
      AND (result_version_id IS NULL OR EXISTS (SELECT 1 FROM "project_versions" v
        WHERE v."id" = result_version_id AND v."commandId" = c."id" AND v."projectId" = project_id AND v."workspaceId" = workspace_id
          AND v."parentVersionId" = c."baseVersionId" AND EXISTS (SELECT 1 FROM "project_versions" b
            WHERE b."id" = c."baseVersionId" AND b."projectId" = project_id AND b."workspaceId" = workspace_id AND b."baseHash" = c."baseHash")))) THEN
      RAISE EXCEPTION 'W66 edit Command provenance mismatch' USING ERRCODE = '23514';
    END IF;
  ELSIF kind = 'media-ingest-operation' THEN
    IF NOT EXISTS (SELECT 1 FROM "public_operations" o JOIN "media_ingest_operations" i
      ON i."operationId" = o."id" AND i."workspaceId" = o."workspaceId"
      WHERE o."id" = identity AND o."workspaceId" = workspace_id AND o."projectId" = project_id
        AND i."projectId" = project_id AND o."type" = 'media-ingest' AND o."requestFingerprint" = seal) THEN
      RAISE EXCEPTION 'W66 ingest operation provenance mismatch' USING ERRCODE = '23514';
    END IF;
  ELSE RAISE EXCEPTION 'W66 unsupported provenance kind' USING ERRCODE = '23514'; END IF;
END $$;

CREATE FUNCTION w66_assert_output_revision_origin(revision "output_spec_revisions") RETURNS void LANGUAGE plpgsql AS $$
DECLARE command "edit_commands"%ROWTYPE; base "project_versions"%ROWTYPE; payload jsonb;
  previous "project_output_state_entries"%ROWTYPE; base_plan jsonb; base_duration integer;
BEGIN
  IF revision."createdCommandKind" IS DISTINCT FROM 'edit-command' THEN
    RAISE EXCEPTION 'W66 output revision requires an explicit output EditCommand' USING ERRCODE = '23514';
  END IF;
  PERFORM w66_assert_provenance('edit-command', revision."createdCommandId", revision."createdCommandHash", revision."projectId", revision."workspaceId");
  SELECT * INTO STRICT command FROM "edit_commands" WHERE "id" = revision."createdCommandId";
  SELECT * INTO STRICT base FROM "project_versions" WHERE "id" = command."baseVersionId" AND "projectId" = command."projectId" AND "workspaceId" = command."workspaceId";
  payload := command."outputPayloadJson"::jsonb;
  IF command."type" IS DISTINCT FROM (CASE WHEN revision."revisionNumber" = 1 THEN 'create-output-variant' ELSE 'revise-output-spec' END)
    OR command."scopeJson"::jsonb IS DISTINCT FROM jsonb_build_object('outputVariantIds', jsonb_build_array(revision."variantId"))
    OR command."outputPayloadJson" IS NULL OR command."outputPayloadHash" IS NULL
    OR payload ->> 'schemaVersion' IS DISTINCT FROM 'output-variant-command/v1'
    OR payload ->> 'canonicalPolicyVersion' IS DISTINCT FROM 'output-canonical-json/v1'
    OR payload ->> 'variantId' IS DISTINCT FROM revision."variantId"
    OR payload -> 'revision' IS DISTINCT FROM revision."specJson"::jsonb
    OR payload ->> 'revisionSpecHash' IS DISTINCT FROM revision."specHash"
    OR payload - ARRAY['schemaVersion', 'canonicalPolicyVersion', 'variantId', 'expectedRevisionId', 'expectedSpecHash',
      'revision', 'revisionSpecHash', 'impact'] IS DISTINCT FROM '{}'::jsonb THEN
    RAISE EXCEPTION 'W66 output revision Command type/scope/payload mismatch' USING ERRCODE = '23514';
  END IF;
  SELECT CASE WHEN r."id" IS NULL THEN x."contentJson"::jsonb ELSE r."planJson"::jsonb END INTO STRICT base_plan
    FROM "project_snapshots" x LEFT JOIN "project_output_states" s ON s."id" = base."outputStateId"
      LEFT JOIN "renderable_plan_snapshots" r ON r."id" = s."renderablePlanSnapshotId"
    WHERE x."id" = base."editPlanSnapshotId" AND x."projectId" = base."projectId" AND x."workspaceId" = base."workspaceId";
  IF jsonb_typeof(base_plan -> 'durationFrames') IS DISTINCT FROM 'number' THEN
    RAISE EXCEPTION 'W66 output Command requires the actual base plan duration' USING ERRCODE = '23514';
  END IF;
  base_duration := (base_plan ->> 'durationFrames')::integer;
  IF revision."revisionNumber" = 1 THEN
    IF payload -> 'expectedRevisionId' IS DISTINCT FROM 'null'::jsonb OR payload -> 'expectedSpecHash' IS DISTINCT FROM 'null'::jsonb
      OR EXISTS (SELECT 1 FROM "project_output_state_entries" e WHERE e."stateId" = base."outputStateId" AND e."variantId" = revision."variantId") THEN
      RAISE EXCEPTION 'W66 create output variant already exists in the exact base State' USING ERRCODE = '23514';
    END IF;
  ELSE
    SELECT * INTO previous FROM "project_output_state_entries" e WHERE e."stateId" = base."outputStateId" AND e."variantId" = revision."variantId";
    IF NOT FOUND OR base."outputContractVersion" IS DISTINCT FROM 1
      OR payload ->> 'expectedRevisionId' IS DISTINCT FROM previous."outputSpecRevisionId"
      OR payload ->> 'expectedSpecHash' IS DISTINCT FROM previous."specHash"
      OR NOT EXISTS (SELECT 1 FROM "output_spec_revisions" r WHERE r."id" = previous."outputSpecRevisionId"
        AND r."variantId" = revision."variantId" AND r."projectId" = revision."projectId" AND r."workspaceId" = revision."workspaceId"
        AND r."specHash" = previous."specHash" AND r."revisionNumber" = revision."revisionNumber" - 1) THEN
      RAISE EXCEPTION 'W66 revise output predecessor is not a member of the exact base State' USING ERRCODE = '23514';
    END IF;
  END IF;
  IF base_duration < 0 OR payload -> 'impact' IS DISTINCT FROM jsonb_build_object(
    'schemaVersion', 'project-output-state-impact/v1', 'canonicalPolicyVersion', 'output-canonical-json/v1',
    'variantId', revision."variantId", 'previousRevisionId', CASE WHEN revision."revisionNumber" = 1 THEN NULL ELSE previous."outputSpecRevisionId" END,
    'nextRevisionId', revision."id", 'renderSemanticsChanged', base_duration > 0,
    'affectedRanges', CASE WHEN base_duration = 0 THEN '[]'::jsonb ELSE jsonb_build_array(jsonb_build_object('startFrame', 0, 'endFrame', base_duration)) END) THEN
    RAISE EXCEPTION 'W66 output revision impact does not match its exact base plan' USING ERRCODE = '23514';
  END IF;
  IF NOT EXISTS (SELECT 1 FROM "project_output_states" s JOIN "project_output_state_entries" e ON e."stateId" = s."id"
    WHERE e."outputSpecRevisionId" = revision."id" AND s."producerKind" = 'edit-command' AND s."producerId" = command."id"
      AND s."projectId" = command."projectId" AND s."workspaceId" = command."workspaceId" AND s."provenanceHash" = command."commandHash"
      AND s."transition" = CASE WHEN revision."revisionNumber" = 1 THEN 'create-variant' ELSE 'revise-output' END
      AND s."parentVersionId" = command."baseVersionId"
      AND s."producerJson"::jsonb IS NOT DISTINCT FROM jsonb_build_object(
        'schemaVersion', 'output-variant-version-producer/v1', 'canonicalPolicyVersion', 'output-canonical-json/v1',
        'commandId', command."id", 'commandHash', command."commandHash", 'requestFingerprint', command."requestFingerprint",
        'workspaceId', command."workspaceId", 'projectId', command."projectId", 'baseVersionId', command."baseVersionId",
        'baseHash', command."baseHash", 'payloadHash', command."outputPayloadHash")) THEN
    RAISE EXCEPTION 'W66 output revision has no exact typed origin State' USING ERRCODE = '23514';
  END IF;
END $$;

-- Preserve historical plan hashes. The new seal covers the exact legacy
-- canonical text and its authority metadata; JSONB comparison binds meaning
-- to the stored scoped plan without recreating its historical serializer.
CREATE FUNCTION w66_assert_plan_authority(authority_json text, authority_hash text, plan_kind text,
  legacy_hash text, legacy_document jsonb) RETURNS void LANGUAGE plpgsql AS $$
DECLARE authority jsonb;
BEGIN
  IF authority_json IS NULL OR authority_hash IS NULL OR legacy_hash IS NULL OR legacy_document IS NULL OR plan_kind IS NULL
    OR jsonb_typeof(legacy_document) IS DISTINCT FROM 'object'
    OR authority_hash !~ '^[a-f0-9]{64}$' OR legacy_hash !~ '^[a-f0-9]{64}$'
    OR plan_kind NOT IN ('project-edit-plan', 'renderable-edit-plan') THEN
    RAISE EXCEPTION 'W66 missing or invalid plan authority seal' USING ERRCODE = '23514';
  END IF;
  authority := authority_json::jsonb;
  IF jsonb_typeof(authority) IS DISTINCT FROM 'object'
    OR authority ->> 'schemaVersion' IS DISTINCT FROM 'output-plan-authority/v1'
    OR authority ->> 'canonicalPolicyVersion' IS DISTINCT FROM 'output-canonical-json/v1'
    OR authority ->> 'kind' IS DISTINCT FROM plan_kind
    OR jsonb_typeof(authority -> 'legacyCanonicalJson') IS DISTINCT FROM 'string'
    OR authority ->> 'legacyHash' IS DISTINCT FROM legacy_hash
    OR authority - ARRAY['schemaVersion', 'canonicalPolicyVersion', 'kind', 'legacyCanonicalJson', 'legacyHash'] IS DISTINCT FROM '{}'::jsonb
    OR encode(sha256(convert_to(authority_json, 'UTF8')), 'hex') IS DISTINCT FROM authority_hash THEN
    RAISE EXCEPTION 'W66 plan authority policy/kind/document mismatch' USING ERRCODE = '23514';
  END IF;
  IF encode(sha256(convert_to(authority ->> 'legacyCanonicalJson', 'UTF8')), 'hex') IS DISTINCT FROM legacy_hash
    OR (authority ->> 'legacyCanonicalJson')::jsonb IS DISTINCT FROM legacy_document THEN
    RAISE EXCEPTION 'W66 historical plan authority digest/body mismatch' USING ERRCODE = '23514';
  END IF;
END $$;

CREATE FUNCTION w66_plan_has_video(plan_document jsonb) RETURNS boolean LANGUAGE plpgsql AS $$
DECLARE track jsonb; has_video boolean := false;
BEGIN
  IF jsonb_typeof(plan_document) IS DISTINCT FROM 'object'
    OR jsonb_typeof(plan_document -> 'videoTracks') IS DISTINCT FROM 'array'
    OR jsonb_typeof(plan_document -> 'durationFrames') IS DISTINCT FROM 'number' THEN
    RAISE EXCEPTION 'W66 plan requires materialized video tracks/duration' USING ERRCODE = '23514';
  END IF;
  FOR track IN SELECT x FROM jsonb_array_elements(plan_document -> 'videoTracks') x LOOP
    IF jsonb_typeof(track) IS DISTINCT FROM 'object' OR jsonb_typeof(track -> 'clips') IS DISTINCT FROM 'array' THEN
      RAISE EXCEPTION 'W66 plan has an invalid video track' USING ERRCODE = '23514';
    END IF;
    has_video := has_video OR jsonb_array_length(track -> 'clips') > 0;
  END LOOP;
  RETURN has_video;
END $$;

-- Read immutable scoped facts without reproducing historical locale-dependent
-- serialization in PostgreSQL. The raw historical text must carry its old SHA.
CREATE FUNCTION w66_assert_non_output_snapshot_facts(version "project_versions") RETURNS void LANGUAGE plpgsql AS $$
DECLARE expected_snapshot record; observed_snapshot "project_snapshots"%ROWTYPE;
BEGIN
  FOR expected_snapshot IN SELECT * FROM (VALUES
    (version."briefSnapshotId", 'brief'), (version."policiesSnapshotId", 'policies'),
    (version."treatmentSnapshotId", 'treatment'), (version."storySnapshotId", 'story')) AS refs(identity, kind) LOOP
    IF expected_snapshot.identity IS NULL THEN
      IF expected_snapshot.kind IN ('brief', 'policies') THEN
        RAISE EXCEPTION 'W66 required non-output snapshot fact is absent' USING ERRCODE = '23514';
      END IF;
      CONTINUE;
    END IF;
    SELECT * INTO observed_snapshot FROM "project_snapshots" x WHERE x."id" = expected_snapshot.identity
      AND x."projectId" = version."projectId" AND x."workspaceId" = version."workspaceId"
      AND x."kind" = expected_snapshot.kind;
    IF NOT FOUND OR observed_snapshot."schemaVersion" IS DISTINCT FROM 1 OR observed_snapshot."contentHash" IS DISTINCT FROM
      encode(sha256(convert_to(observed_snapshot."contentJson", 'UTF8')), 'hex') THEN
      RAISE EXCEPTION 'W66 non-output snapshot kind/scope/historical digest mismatch' USING ERRCODE = '23514';
    END IF;
  END LOOP;
END $$;

CREATE FUNCTION w66_assert_output_state(state_id text) RETURNS void LANGUAGE plpgsql AS $$
DECLARE s "project_output_states"%ROWTYPE; v "project_versions"%ROWTYPE; p "project_versions"%ROWTYPE;
  body jsonb; row_doc jsonb; edit_plan jsonb; renderable_plan jsonb;
  edit_plan_has_video boolean; renderable_plan_has_video boolean := false;
  origin_revision "output_spec_revisions"%ROWTYPE;
  base_state "project_output_states"%ROWTYPE; base_edit_plan jsonb; base_renderable_plan jsonb;
  base_other_entries jsonb; child_other_entries jsonb;
  root_creation "project_creation_commands"%ROWTYPE; output_command "edit_commands"%ROWTYPE;
  brief_snapshot "project_snapshots"%ROWTYPE; policies_snapshot "project_snapshots"%ROWTYPE;
  state_member_row record; item jsonb; expected_count integer; ingest_identity text;
BEGIN
  SELECT * INTO STRICT s FROM "project_output_states" WHERE "id" = state_id;
  SELECT * INTO STRICT v FROM "project_versions" WHERE "id" = s."resultVersionId";
  IF v."outputContractVersion" <> 1 OR v."outputStateId" IS DISTINCT FROM s."id"
    OR v."outputStateHash" IS DISTINCT FROM s."stateHash" OR v."projectId" <> s."projectId" OR v."workspaceId" <> s."workspaceId"
    OR v."parentVersionId" IS DISTINCT FROM s."parentVersionId" OR v."editPlanSnapshotId" <> s."editPlanSnapshotId"
    OR v."createdAt" IS DISTINCT FROM s."createdAt" THEN
    RAISE EXCEPTION 'W66 state has no exact consuming Version' USING ERRCODE = '23514';
  END IF;
  IF s."parentVersionId" IS NOT NULL THEN
    SELECT * INTO STRICT p FROM "project_versions" WHERE "id" = s."parentVersionId";
    IF p."outputStateId" IS DISTINCT FROM s."parentStateId" OR p."outputStateHash" IS DISTINCT FROM s."parentStateHash" THEN
      RAISE EXCEPTION 'W66 parent state seal mismatch' USING ERRCODE = '23514';
    END IF;
    IF p."outputContractVersion" = 0 AND s."transition" <> 'create-variant' THEN
      RAISE EXCEPTION 'W66 historical baseline requires explicit create-variant Command' USING ERRCODE = '23514';
    END IF;
  END IF;
  IF v."outputBaseHashJson" IS NULL OR v."outputBaseHashJson"::jsonb IS DISTINCT FROM jsonb_build_object(
    'schemaVersion', 'project-version-output-state/v1', 'canonicalPolicyVersion', s."canonicalPolicyVersion",
    'workspaceId', s."workspaceId", 'projectId', s."projectId", 'resultVersionId', s."resultVersionId",
    'parentVersionId', s."parentVersionId", 'previousBaseHash', CASE WHEN s."parentVersionId" IS NULL THEN NULL ELSE p."baseHash" END,
    'producerHash', s."producerHash", 'outputStateId', s."id", 'outputStateHash', s."stateHash") THEN
    RAISE EXCEPTION 'W66 Version base-hash authority dependencies mismatch' USING ERRCODE = '23514';
  END IF;
  PERFORM w66_assert_provenance(s."producerKind", s."producerId", s."provenanceHash", s."projectId", s."workspaceId", s."resultVersionId");
  IF (v."sequence" = 1) IS DISTINCT FROM (s."producerKind" = 'creation-command') THEN
    RAISE EXCEPTION 'W66 root/child provenance kind mismatch' USING ERRCODE = '23514';
  END IF;
  IF s."producerKind" = 'creation-command' AND NOT EXISTS (SELECT 1 FROM "project_creation_commands" c
    WHERE c."id" = s."producerId" AND
      ((c."action" = 'create' AND v."forkedFromVersionId" IS NULL AND s."transition" = 'initialize-empty') OR
       (c."action" = 'duplicate' AND s."transition" = 'fork-empty' AND v."forkedFromVersionId" = c."sourceVersionId"
        AND v."forkedFromProjectId" = c."sourceProjectId"))) THEN
    RAISE EXCEPTION 'W66 creation/fork action mismatch' USING ERRCODE = '23514';
  END IF;
  IF s."producerKind" = 'creation-command' THEN
    SELECT * INTO STRICT root_creation FROM "project_creation_commands" c WHERE c."id" = s."producerId"
      AND c."workspaceId" = s."workspaceId" AND c."projectId" = s."projectId";
    IF v."createdBy" IS DISTINCT FROM root_creation."actorClientId" OR v."createdAt" IS DISTINCT FROM root_creation."createdAt" THEN
      RAISE EXCEPTION 'W66 root Version author/time differs from its CreationCommand' USING ERRCODE = '23514';
    END IF;
    PERFORM w66_assert_non_output_snapshot_facts(v);
    SELECT * INTO STRICT brief_snapshot FROM "project_snapshots" x WHERE x."id" = v."briefSnapshotId"
      AND x."projectId" = v."projectId" AND x."workspaceId" = v."workspaceId" AND x."kind" = 'brief';
    SELECT * INTO STRICT policies_snapshot FROM "project_snapshots" x WHERE x."id" = v."policiesSnapshotId"
      AND x."projectId" = v."projectId" AND x."workspaceId" = v."workspaceId" AND x."kind" = 'policies';
    -- CreationCommand v1 does not seal caller brief/policies intent. This guard
    -- binds persisted facts only, rather than inventing a request fingerprint.
    IF s."producerJson"::jsonb IS DISTINCT FROM jsonb_build_object(
      'schemaVersion', 'project-created-version/v1', 'canonicalPolicyVersion', s."canonicalPolicyVersion",
      'briefHash', brief_snapshot."contentHash", 'policyHash', policies_snapshot."contentHash") THEN
      RAISE EXCEPTION 'W66 root producer differs from actual brief/policies facts' USING ERRCODE = '23514';
    END IF;
  END IF;
  IF s."producerKind" = 'media-ingest-operation' THEN
    ingest_identity := encode(sha256(convert_to(s."ingestOperationId" || ':' || s."ingestSourceArtifactId" || ':' ||
      s."ingestSourceManifestId" || ':' || s."ingestTranscriptHash", 'UTF8')), 'hex');
    IF s."resultVersionId" <> 'project-version-ingest-' || left(ingest_identity, 48)
      OR s."editPlanSnapshotId" <> 'project-snapshot-ingest-' || left(ingest_identity, 48)
      OR s."renderablePlanSnapshotId" IS NOT NULL OR v."commandId" IS NOT NULL OR s."parentVersionId" IS NULL
      OR s."producerJson"::jsonb IS DISTINCT FROM jsonb_build_object(
        'schemaVersion', 'ingested-source-project-version/v2', 'canonicalPolicyVersion', s."canonicalPolicyVersion", 'operationId', s."ingestOperationId",
        'workspaceId', s."workspaceId", 'projectId', s."projectId", 'resultVersionId', s."resultVersionId",
        'sourceArtifactId', s."ingestSourceArtifactId", 'sourceManifestId', s."ingestSourceManifestId",
        'sourceManifestHash', s."ingestSourceManifestHash", 'transcriptId', s."ingestTranscriptId",
        'transcriptHash', s."ingestTranscriptHash", 'editPlanSnapshotId', s."editPlanSnapshotId", 'editPlanHash', s."editPlanHash")
      OR NOT EXISTS (SELECT 1 FROM "project_snapshots" x WHERE x."id" = s."editPlanSnapshotId"
        AND x."contentJson"::jsonb ->> 'id' = 'edit-plan-ingest-' || left(ingest_identity, 48)
        AND x."contentJson"::jsonb ->> 'projectVersionId' = s."resultVersionId") THEN
      RAISE EXCEPTION 'W66 ingest producer does not bind its exact generated child' USING ERRCODE = '23514';
    END IF;
  END IF;
  IF NOT EXISTS (SELECT 1 FROM "project_snapshots" x WHERE x."id" = s."editPlanSnapshotId" AND x."kind" = 'edit-plan'
    AND x."projectId" = s."projectId" AND x."workspaceId" = s."workspaceId" AND x."contentHash" = s."editPlanHash"
    AND x."contentJson"::jsonb ->> 'projectVersionId' = s."resultVersionId"
    ) THEN
    RAISE EXCEPTION 'W66 EditPlan snapshot seal mismatch' USING ERRCODE = '23514';
  END IF;
  SELECT x."contentJson"::jsonb INTO STRICT edit_plan FROM "project_snapshots" x WHERE x."id" = s."editPlanSnapshotId";
  edit_plan_has_video := w66_plan_has_video(edit_plan);
  PERFORM w66_assert_plan_authority(s."editPlanAuthorityJson", s."editPlanAuthorityHash",
    'project-edit-plan', s."editPlanHash", edit_plan);
  IF s."renderablePlanSnapshotId" IS NOT NULL AND NOT EXISTS (SELECT 1 FROM "renderable_plan_snapshots" r
    WHERE r."id" = s."renderablePlanSnapshotId" AND r."projectId" = s."projectId" AND r."workspaceId" = s."workspaceId"
    AND r."projectVersionId" = s."resultVersionId" AND r."planId" = s."renderablePlanId" AND r."planHash" = s."renderablePlanHash"
    AND r."planJson"::jsonb ->> 'id' = r."planId"
    AND r."planJson"::jsonb ->> 'projectVersionId' = r."projectVersionId"
    ) THEN
    RAISE EXCEPTION 'W66 RenderablePlan binding mismatch' USING ERRCODE = '23514';
  END IF;
  IF s."renderablePlanSnapshotId" IS NOT NULL THEN
    SELECT r."planJson"::jsonb INTO STRICT renderable_plan FROM "renderable_plan_snapshots" r WHERE r."id" = s."renderablePlanSnapshotId";
    renderable_plan_has_video := w66_plan_has_video(renderable_plan);
    PERFORM w66_assert_plan_authority(s."renderablePlanAuthorityJson", s."renderablePlanAuthorityHash",
      'renderable-edit-plan', s."renderablePlanHash", jsonb_build_object(
        'schemaVersion', 'renderable-edit-plan-hash/v2', 'compilerVersion', 'renderable-edit-plan/2026-09-05-v1',
        'plan', renderable_plan - 'createdAt'));
  END IF;
  body := s."stateJson"::jsonb;
  row_doc := jsonb_build_object('schemaVersion', s."schemaVersion", 'canonicalPolicyVersion', s."canonicalPolicyVersion", 'id', s."id", 'projectId', s."projectId", 'workspaceId', s."workspaceId",
    'resultVersionId', s."resultVersionId", 'parentVersionId', s."parentVersionId", 'parentStateId', s."parentStateId", 'parentStateHash', s."parentStateHash",
    'transition', s."transition", 'transitionPolicyVersion', s."transitionPolicyVersion",
    'provenance', jsonb_build_object('kind', s."producerKind", 'id', s."producerId", 'hash', s."provenanceHash"),
    'producer', jsonb_build_object('hash', s."producerHash", 'document', s."producerJson"::jsonb),
    'editPlan', jsonb_build_object('snapshotId', s."editPlanSnapshotId", 'hash', s."editPlanHash", 'authority',
      jsonb_build_object('schemaVersion', 'output-plan-authority/v1', 'document', s."editPlanAuthorityJson"::jsonb, 'hash', s."editPlanAuthorityHash")),
    'renderablePlan', CASE WHEN s."renderablePlanSnapshotId" IS NULL THEN 'null'::jsonb ELSE jsonb_build_object(
      'snapshotId', s."renderablePlanSnapshotId", 'planId', s."renderablePlanId", 'hash', s."renderablePlanHash", 'authority',
      jsonb_build_object('schemaVersion', 'output-plan-authority/v1', 'document', s."renderablePlanAuthorityJson"::jsonb, 'hash', s."renderablePlanAuthorityHash")) END,
    'createdAt', to_char(s."createdAt" AT TIME ZONE 'UTC', 'YYYY-MM-DD"T"HH24:MI:SS.MS"Z"'));
  IF body - ARRAY['entries', 'overlays', 'invalidations'] IS DISTINCT FROM row_doc
    OR jsonb_typeof(body -> 'entries') IS DISTINCT FROM 'array' OR jsonb_typeof(body -> 'overlays') IS DISTINCT FROM 'array'
    OR jsonb_typeof(body -> 'invalidations') IS DISTINCT FROM 'array' THEN
    RAISE EXCEPTION 'W66 state document/columns mismatch' USING ERRCODE = '23514';
  END IF;
  IF s."transition" IN ('initialize-empty', 'fork-empty') AND
    (v."sequence" <> 1 OR s."producerKind" <> 'creation-command' OR jsonb_array_length(body -> 'entries') <> 0
     OR s."parentVersionId" IS NOT NULL OR edit_plan_has_video OR renderable_plan_has_video
     OR edit_plan -> 'durationFrames' IS DISTINCT FROM '0'::jsonb
     OR (s."renderablePlanSnapshotId" IS NOT NULL AND renderable_plan -> 'durationFrames' IS DISTINCT FROM '0'::jsonb)
     OR jsonb_array_length(body -> 'overlays') <> 0 OR jsonb_array_length(body -> 'invalidations') <> 0) THEN
    RAISE EXCEPTION 'W66 empty bootstrap/fork contract mismatch' USING ERRCODE = '23514';
  END IF;
  IF v."sequence" = 1 AND s."transition" NOT IN ('initialize-empty', 'fork-empty') THEN
    RAISE EXCEPTION 'W66 root transition is not explicit' USING ERRCODE = '23514';
  END IF;
  IF (s."transition" IN ('create-variant', 'revise-output')) IS DISTINCT FROM
    (s."producerKind" = 'edit-command' AND EXISTS (SELECT 1 FROM "edit_commands" c WHERE c."id" = s."producerId"
      AND c."type" IN ('create-output-variant', 'revise-output-spec'))) THEN
    RAISE EXCEPTION 'W66 output transition Command mismatch' USING ERRCODE = '23514';
  END IF;
  IF s."transition" IN ('create-variant', 'revise-output') THEN
    IF NOT EXISTS (SELECT 1 FROM "edit_commands" c WHERE c."id" = s."producerId"
      AND c."type" = CASE s."transition" WHEN 'create-variant' THEN 'create-output-variant' ELSE 'revise-output-spec' END)
      OR (SELECT count(*) FROM "project_output_state_entries" e JOIN "output_spec_revisions" r ON r."id" = e."outputSpecRevisionId"
        WHERE e."stateId" = s."id" AND r."createdCommandKind" = 'edit-command' AND r."createdCommandId" = s."producerId"
          AND r."createdCommandHash" = s."provenanceHash" AND r."projectId" = s."projectId" AND r."workspaceId" = s."workspaceId") <> 1 THEN
      RAISE EXCEPTION 'W66 output transition must consume exactly its Command revision' USING ERRCODE = '23514';
    END IF;
    SELECT r.* INTO STRICT origin_revision FROM "project_output_state_entries" e JOIN "output_spec_revisions" r ON r."id" = e."outputSpecRevisionId"
      WHERE e."stateId" = s."id" AND r."createdCommandKind" = 'edit-command' AND r."createdCommandId" = s."producerId"
        AND r."createdCommandHash" = s."provenanceHash" AND r."projectId" = s."projectId" AND r."workspaceId" = s."workspaceId";
    PERFORM w66_assert_output_revision_origin(origin_revision);
  END IF;
  SELECT count(*) INTO expected_count FROM "project_output_state_entries" WHERE "stateId" = s."id";
  IF expected_count <> jsonb_array_length(body -> 'entries') OR expected_count <> (SELECT count(DISTINCT x ->> 'variantId') FROM jsonb_array_elements(body -> 'entries') x) THEN
    RAISE EXCEPTION 'W66 entry membership/count mismatch' USING ERRCODE = '23514';
  END IF;
  IF (edit_plan_has_video OR renderable_plan_has_video) AND NOT EXISTS
    (SELECT 1 FROM "project_output_state_entries" e WHERE e."stateId" = s."id" AND e."geometryStatus" = 'verified') THEN
    RAISE EXCEPTION 'W66 referenced video requires an explicit verified output entry' USING ERRCODE = '23514';
  END IF;
  FOR state_member_row IN SELECT * FROM "project_output_state_entries" WHERE "stateId" = s."id" LOOP
    SELECT x INTO STRICT item FROM jsonb_array_elements(body -> 'entries') x WHERE x ->> 'variantId' = state_member_row."variantId";
    IF item IS DISTINCT FROM state_member_row."entryJson"::jsonb OR item ->> 'outputSpecRevisionId' IS DISTINCT FROM state_member_row."outputSpecRevisionId"
      OR item ->> 'specHash' IS DISTINCT FROM state_member_row."specHash" OR item #>> '{geometry,status}' IS DISTINCT FROM state_member_row."geometryStatus"
      OR item #>> '{geometry,projectionHash}' IS DISTINCT FROM state_member_row."geometryProjectionHash"
      OR item -> 'spec' IS DISTINCT FROM (SELECT r."specJson"::jsonb FROM "output_spec_revisions" r WHERE r."id" = state_member_row."outputSpecRevisionId") THEN
      RAISE EXCEPTION 'W66 entry document/revision mismatch' USING ERRCODE = '23514';
    END IF;
    IF state_member_row."geometryStatus" = 'unmaterialized' AND
      (edit_plan_has_video OR renderable_plan_has_video OR item #> '{geometry,projection}' IS DISTINCT FROM 'null'::jsonb OR EXISTS
        (SELECT 1 FROM "project_output_state_overlays" o WHERE o."stateId" = s."id" AND o."variantId" = state_member_row."variantId" AND o."status" = 'active')) THEN
      RAISE EXCEPTION 'W66 unmaterialized output has geometry/active overlay' USING ERRCODE = '23514';
    END IF;
  END LOOP;
  SELECT count(*) INTO expected_count FROM "project_output_state_overlays" WHERE "stateId" = s."id";
  IF expected_count <> jsonb_array_length(body -> 'overlays') OR expected_count <> (SELECT count(DISTINCT x ->> 'id') FROM jsonb_array_elements(body -> 'overlays') x) THEN
    RAISE EXCEPTION 'W66 overlay membership/count mismatch' USING ERRCODE = '23514';
  END IF;
  FOR state_member_row IN SELECT * FROM "project_output_state_overlays" WHERE "stateId" = s."id" LOOP
    SELECT x INTO STRICT item FROM jsonb_array_elements(body -> 'overlays') x WHERE x ->> 'id' = state_member_row."id";
    IF item IS DISTINCT FROM state_member_row."overlayJson"::jsonb OR item ->> 'variantId' IS DISTINCT FROM state_member_row."variantId"
      OR item ->> 'kind' IS DISTINCT FROM state_member_row."kind" OR item ->> 'clipId' IS DISTINCT FROM state_member_row."clipId"
      OR (item ->> 'startFrame')::integer IS DISTINCT FROM state_member_row."startFrame" OR (item ->> 'endFrame')::integer IS DISTINCT FROM state_member_row."endFrame"
      OR item ->> 'status' IS DISTINCT FROM state_member_row."status" OR item #>> '{provenance,id}' IS DISTINCT FROM state_member_row."originalCommandId"
      OR item #>> '{provenance,hash}' IS DISTINCT FROM state_member_row."originalCommandHash" THEN
      RAISE EXCEPTION 'W66 overlay document/columns mismatch' USING ERRCODE = '23514';
    END IF;
    PERFORM w66_assert_provenance('edit-command', state_member_row."originalCommandId", state_member_row."originalCommandHash", s."projectId", s."workspaceId");
    IF state_member_row."status" = 'invalidated' AND NOT EXISTS (SELECT 1 FROM "project_output_state_invalidations" i
      WHERE i."stateId" = s."id" AND i."variantId" = state_member_row."variantId" AND i."overlayId" = state_member_row."id") THEN
      RAISE EXCEPTION 'W66 invalidated overlay has no issue' USING ERRCODE = '23514';
    END IF;
  END LOOP;
  IF EXISTS (SELECT 1 FROM "project_output_state_overlays" a JOIN "project_output_state_overlays" b
    ON a."stateId" = b."stateId" AND a."variantId" = b."variantId" AND a."clipId" = b."clipId" AND a."kind" = b."kind"
    AND a."id" < b."id" AND a."startFrame" < b."endFrame" AND b."startFrame" < a."endFrame"
    WHERE a."stateId" = s."id" AND a."status" = 'active' AND b."status" = 'active') THEN
    RAISE EXCEPTION 'W66 active overlay ranges overlap' USING ERRCODE = '23514';
  END IF;
  SELECT count(*) INTO expected_count FROM "project_output_state_invalidations" WHERE "stateId" = s."id";
  IF expected_count <> jsonb_array_length(body -> 'invalidations') OR expected_count <> (SELECT count(DISTINCT x ->> 'id') FROM jsonb_array_elements(body -> 'invalidations') x) THEN
    RAISE EXCEPTION 'W66 invalidation membership/count mismatch' USING ERRCODE = '23514';
  END IF;
  FOR state_member_row IN SELECT * FROM "project_output_state_invalidations" WHERE "stateId" = s."id" LOOP
    SELECT x INTO STRICT item FROM jsonb_array_elements(body -> 'invalidations') x WHERE x ->> 'id' = state_member_row."id";
    IF item IS DISTINCT FROM state_member_row."invalidationJson"::jsonb OR item ->> 'variantId' IS DISTINCT FROM state_member_row."variantId"
      OR item ->> 'overlayId' IS DISTINCT FROM state_member_row."overlayId" OR item ->> 'kind' IS DISTINCT FROM state_member_row."kind"
      OR item ->> 'reasonCode' IS DISTINCT FROM state_member_row."reasonCode" OR item ->> 'previousDependencyHash' IS DISTINCT FROM state_member_row."previousDependencyHash"
      OR item ->> 'nextDependencyHash' IS DISTINCT FROM state_member_row."nextDependencyHash" OR item #>> '{provenance,kind}' IS DISTINCT FROM state_member_row."causedByKind"
      OR item #>> '{provenance,id}' IS DISTINCT FROM state_member_row."causedById" OR item #>> '{provenance,hash}' IS DISTINCT FROM state_member_row."causedByHash" THEN
      RAISE EXCEPTION 'W66 invalidation document/columns mismatch' USING ERRCODE = '23514';
    END IF;
    PERFORM w66_assert_provenance(state_member_row."causedByKind", state_member_row."causedById", state_member_row."causedByHash", s."projectId", s."workspaceId");
    IF state_member_row."overlayId" IS NOT NULL AND NOT EXISTS (SELECT 1 FROM "project_output_state_overlays" o
      WHERE o."stateId" = s."id" AND o."id" = state_member_row."overlayId" AND o."variantId" = state_member_row."variantId" AND o."status" = 'invalidated') THEN
      RAISE EXCEPTION 'W66 invalidation does not reference its disabled overlay' USING ERRCODE = '23514';
    END IF;
  END LOOP;
  -- These two Commands authorize one member effect, not a rewrite of the
  -- parent State. Other producer families require their own reviewed contracts.
  IF s."transition" IN ('create-variant', 'revise-output') THEN
    IF p."outputContractVersion" IS DISTINCT FROM 1 OR p."projectId" IS DISTINCT FROM s."projectId"
      OR p."workspaceId" IS DISTINCT FROM s."workspaceId" OR s."parentStateId" IS NULL THEN
      RAISE EXCEPTION 'W66 output Command requires an exact operational base State' USING ERRCODE = '23514';
    END IF;
    IF v."briefSnapshotId" IS DISTINCT FROM p."briefSnapshotId" OR v."policiesSnapshotId" IS DISTINCT FROM p."policiesSnapshotId"
      OR v."treatmentSnapshotId" IS DISTINCT FROM p."treatmentSnapshotId" OR v."storySnapshotId" IS DISTINCT FROM p."storySnapshotId" THEN
      RAISE EXCEPTION 'W66 output Command changed preserved non-output snapshot references' USING ERRCODE = '23514';
    END IF;
    PERFORM w66_assert_non_output_snapshot_facts(v);
    SELECT * INTO STRICT output_command FROM "edit_commands" c WHERE c."id" = s."producerId"
      AND c."workspaceId" = s."workspaceId" AND c."projectId" = s."projectId";
    IF output_command."actorType" IS DISTINCT FROM 'api-client'
      OR output_command."commandJson"::jsonb #>> '{author,type}' IS DISTINCT FROM output_command."actorType"
      OR output_command."commandJson"::jsonb #>> '{author,id}' IS DISTINCT FROM output_command."actorId"
      OR output_command."commandJson"::jsonb #>> '{author,delegatedUserId}' IS DISTINCT FROM output_command."delegatedUserId"
      OR output_command."commandJson"::jsonb ->> 'createdAt' IS DISTINCT FROM
        to_char(output_command."createdAt" AT TIME ZONE 'UTC', 'YYYY-MM-DD"T"HH24:MI:SS.MS"Z"')
      OR v."createdBy" IS DISTINCT FROM output_command."actorId" OR v."createdAt" IS DISTINCT FROM output_command."createdAt"
      OR origin_revision."createdAt" IS DISTINCT FROM output_command."createdAt"
      OR (s."transition" = 'create-variant' AND NOT EXISTS (SELECT 1 FROM "output_variants" ov WHERE ov."id" = origin_revision."variantId"
        AND ov."projectId" = s."projectId" AND ov."workspaceId" = s."workspaceId" AND ov."createdAt" = output_command."createdAt")) THEN
      RAISE EXCEPTION 'W66 output Command author/time authority mismatch' USING ERRCODE = '23514';
    END IF;
    SELECT * INTO base_state FROM "project_output_states" b WHERE b."id" = s."parentStateId"
      AND b."resultVersionId" = p."id" AND b."stateHash" = s."parentStateHash"
      AND b."projectId" = s."projectId" AND b."workspaceId" = s."workspaceId";
    IF NOT FOUND THEN
      RAISE EXCEPTION 'W66 output Command requires an exact operational base State' USING ERRCODE = '23514';
    END IF;
    SELECT coalesce(jsonb_object_agg(x ->> 'variantId', x), '{}'::jsonb) INTO base_other_entries
      FROM jsonb_array_elements(base_state."stateJson"::jsonb -> 'entries') x
      WHERE x ->> 'variantId' IS DISTINCT FROM origin_revision."variantId";
    SELECT coalesce(jsonb_object_agg(x ->> 'variantId', x), '{}'::jsonb) INTO child_other_entries
      FROM jsonb_array_elements(body -> 'entries') x
      WHERE x ->> 'variantId' IS DISTINCT FROM origin_revision."variantId";
    IF child_other_entries IS DISTINCT FROM base_other_entries THEN
      RAISE EXCEPTION 'W66 output Command changed a non-target State member' USING ERRCODE = '23514';
    END IF;
    IF body -> 'overlays' IS DISTINCT FROM base_state."stateJson"::jsonb -> 'overlays'
      OR body -> 'invalidations' IS DISTINCT FROM base_state."stateJson"::jsonb -> 'invalidations' THEN
      RAISE EXCEPTION 'W66 output Command changed preserved overlays or invalidations' USING ERRCODE = '23514';
    END IF;
    SELECT x."contentJson"::jsonb INTO STRICT base_edit_plan FROM "project_snapshots" x
      WHERE x."id" = base_state."editPlanSnapshotId" AND x."contentHash" = base_state."editPlanHash"
        AND x."projectId" = s."projectId" AND x."workspaceId" = s."workspaceId";
    IF edit_plan - ARRAY['id', 'projectVersionId', 'createdAt'] IS DISTINCT FROM
      base_edit_plan - ARRAY['id', 'projectVersionId', 'createdAt']
      OR (s."renderablePlanSnapshotId" IS NULL) IS DISTINCT FROM (base_state."renderablePlanSnapshotId" IS NULL) THEN
      RAISE EXCEPTION 'W66 output Command changed plan semantics or Renderable presence' USING ERRCODE = '23514';
    END IF;
    IF s."renderablePlanSnapshotId" IS NOT NULL THEN
      SELECT r."planJson"::jsonb INTO STRICT base_renderable_plan FROM "renderable_plan_snapshots" r
        WHERE r."id" = base_state."renderablePlanSnapshotId" AND r."planHash" = base_state."renderablePlanHash"
          AND r."projectVersionId" = p."id" AND r."projectId" = s."projectId" AND r."workspaceId" = s."workspaceId";
      IF renderable_plan - ARRAY['id', 'projectVersionId', 'createdAt'] IS DISTINCT FROM
        base_renderable_plan - ARRAY['id', 'projectVersionId', 'createdAt'] THEN
        RAISE EXCEPTION 'W66 output Command changed Renderable plan semantics' USING ERRCODE = '23514';
      END IF;
    END IF;
  END IF;
END $$;

CREATE FUNCTION w66_output_deferred_check() RETURNS trigger LANGUAGE plpgsql AS $$
DECLARE state_id text; revision "output_spec_revisions"%ROWTYPE;
BEGIN
  IF TG_TABLE_NAME = 'project_output_states' THEN state_id := NEW."id";
  ELSIF TG_TABLE_NAME = 'project_versions' THEN state_id := NEW."outputStateId";
  ELSIF TG_TABLE_NAME IN ('project_output_state_entries', 'project_output_state_overlays', 'project_output_state_invalidations') THEN state_id := NEW."stateId";
  ELSIF TG_TABLE_NAME = 'output_variants' THEN
    SELECT r.* INTO STRICT revision FROM "output_spec_revisions" r WHERE r."variantId" = NEW."id" AND r."revisionNumber" = 1;
    IF revision."createdCommandKind" <> NEW."createdCommandKind" OR revision."createdCommandId" <> NEW."createdCommandId"
      OR revision."createdCommandHash" <> NEW."createdCommandHash" THEN
      RAISE EXCEPTION 'W66 variant first revision provenance mismatch' USING ERRCODE = '23514';
    END IF;
    PERFORM w66_assert_output_revision_origin(revision);
    RETURN NULL;
  ELSIF TG_TABLE_NAME = 'output_spec_revisions' THEN
    PERFORM w66_assert_output_revision_origin(NEW::"output_spec_revisions");
    IF NEW."revisionNumber" > 1 AND NOT EXISTS (SELECT 1 FROM "output_spec_revisions" r WHERE r."variantId" = NEW."variantId"
      AND r."projectId" = NEW."projectId" AND r."workspaceId" = NEW."workspaceId" AND r."revisionNumber" = NEW."revisionNumber" - 1) THEN
      RAISE EXCEPTION 'W66 revision sequence gap' USING ERRCODE = '23514';
    END IF;
    IF NOT EXISTS (SELECT 1 FROM "project_output_state_entries" e JOIN "project_output_states" s ON s."id" = e."stateId"
      WHERE e."outputSpecRevisionId" = NEW."id" AND s."producerKind" = NEW."createdCommandKind"
      AND s."producerId" = NEW."createdCommandId" AND s."provenanceHash" = NEW."createdCommandHash") THEN
      RAISE EXCEPTION 'W66 revision has no origin state consumption' USING ERRCODE = '23514';
    END IF;
    IF NEW."specJson"::jsonb ->> 'id' IS DISTINCT FROM NEW."id" OR NEW."specJson"::jsonb ->> 'variantId' IS DISTINCT FROM NEW."variantId"
      OR NEW."specJson"::jsonb ->> 'projectId' IS DISTINCT FROM NEW."projectId" OR NEW."specJson"::jsonb ->> 'workspaceId' IS DISTINCT FROM NEW."workspaceId"
      OR (NEW."specJson"::jsonb ->> 'revisionNumber')::integer IS DISTINCT FROM NEW."revisionNumber"
      OR NEW."specJson"::jsonb ->> 'schemaVersion' IS DISTINCT FROM NEW."schemaVersion" THEN
      RAISE EXCEPTION 'W66 revision document identity mismatch' USING ERRCODE = '23514';
    END IF;
    RETURN NULL;
  ELSIF TG_TABLE_NAME = 'renderable_plan_snapshots' THEN
    SELECT v."outputStateId" INTO STRICT state_id FROM "project_versions" v WHERE v."id" = NEW."projectVersionId" AND v."outputContractVersion" = 1;
    IF NOT EXISTS (SELECT 1 FROM "project_output_states" s WHERE s."id" = state_id AND s."renderablePlanSnapshotId" = NEW."id"
      AND s."renderablePlanId" = NEW."planId" AND s."renderablePlanHash" = NEW."planHash") THEN
      RAISE EXCEPTION 'W66 new renderable snapshot lacks reciprocal state binding' USING ERRCODE = '23514';
    END IF;
  END IF;
  PERFORM w66_assert_output_state(state_id);
  RETURN NULL;
END $$;
DO $$ DECLARE table_name text; BEGIN
  FOREACH table_name IN ARRAY ARRAY['output_variants', 'output_spec_revisions', 'project_output_states', 'project_versions',
    'project_output_state_entries', 'project_output_state_overlays', 'project_output_state_invalidations', 'renderable_plan_snapshots'] LOOP
    EXECUTE format('CREATE CONSTRAINT TRIGGER %I AFTER INSERT ON %I DEFERRABLE INITIALLY DEFERRED FOR EACH ROW EXECUTE FUNCTION w66_output_deferred_check()', table_name || '_w66_commit_check', table_name);
  END LOOP;
END $$;

-- Immutable documents are protected from insertion onward, including before
-- their first State exists. This does not depend on an EXISTS snapshot/isolation
-- level and closes both orderings of the dependency UPDATE vs first-State race.
CREATE FUNCTION w66_output_dependency_guard() RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN
  IF TG_TABLE_NAME = 'public_operations' THEN
    IF OLD."type" <> 'media-ingest' AND (TG_OP = 'DELETE' OR NEW."type" <> 'media-ingest') THEN
      IF TG_OP = 'DELETE' THEN RETURN OLD; END IF;
      RETURN NEW;
    END IF;
    IF TG_OP = 'DELETE' OR ROW(OLD."id", OLD."workspaceId", OLD."projectId", OLD."type", OLD."requestFingerprint",
      OLD."clientId", OLD."actorCredentialId", OLD."actorEnvironment", OLD."actorAuthenticationKind", OLD."actorContextHash",
      OLD."delegatedUserId", OLD."delegatedIdentityId", OLD."workspaceRole", OLD."idempotencyKey", OLD."targetType", OLD."targetId", OLD."createdAt")
      IS DISTINCT FROM ROW(NEW."id", NEW."workspaceId", NEW."projectId", NEW."type", NEW."requestFingerprint",
      NEW."clientId", NEW."actorCredentialId", NEW."actorEnvironment", NEW."actorAuthenticationKind", NEW."actorContextHash",
      NEW."delegatedUserId", NEW."delegatedIdentityId", NEW."workspaceRole", NEW."idempotencyKey", NEW."targetType", NEW."targetId", NEW."createdAt") THEN
      RAISE EXCEPTION 'W66 immutable ingest intent' USING ERRCODE = '23514';
    END IF;
    -- Status, phase, attempt, result/error, progress, leases and heartbeat remain
    -- owned by the existing worker CAS/fences; no new latches or status authority.
    RETURN NEW;
  END IF;
  RAISE EXCEPTION 'W66 immutable dependency: % %', TG_TABLE_NAME, TG_OP USING ERRCODE = '23514';
END $$;
DO $$ DECLARE table_name text; BEGIN
  FOREACH table_name IN ARRAY ARRAY['edit_commands', 'project_creation_commands', 'project_snapshots', 'renderable_plan_snapshots',
    'media_ingest_operations', 'media_artifact_manifests', 'media_transcripts', 'public_operations'] LOOP
    EXECUTE format('CREATE TRIGGER %I BEFORE UPDATE OR DELETE ON %I FOR EACH ROW EXECUTE FUNCTION w66_output_dependency_guard()', table_name || '_w66_dependency_guard', table_name);
  END LOOP;
END $$;
