-- Isolated W66 full-bundle persistence. No runtime writer is activated here.
-- Historical contract-0 rows remain audit history. Contract-1 function bodies
-- and their canonical hash algorithms are not changed by this dispatcher.
ALTER TABLE projects ADD COLUMN "creationContractVersion" integer NOT NULL DEFAULT 1;
ALTER TABLE projects ADD CONSTRAINT projects_creation_contract_check CHECK ("creationContractVersion" IN (1,2));
ALTER TABLE project_versions ADD COLUMN "outputVersionJson" text;
ALTER TABLE project_creation_commands ADD COLUMN "schemaVersion" integer NOT NULL DEFAULT 1,
 ADD COLUMN "canonicalPolicyVersion" varchar(64), ADD COLUMN "commandJson" text,
 ADD COLUMN "commandBodyJson" text, ADD COLUMN "payloadJson" text, ADD COLUMN "payloadHash" char(64),
 ADD COLUMN "requestJson" text, ADD COLUMN "forkDerivationId" varchar(128), ADD COLUMN "forkDerivationHash" char(64);
ALTER TABLE project_output_states ADD COLUMN "creationCommandV2Id" varchar(128),
 ADD COLUMN "forkRenderableCandidateId" varchar(200),
 ADD COLUMN "consumptionStatus" varchar(32) NOT NULL DEFAULT 'historical-v1', ADD COLUMN "consumptionJson" text;
CREATE UNIQUE INDEX "project_creation_commands_v2_scope_key" ON "project_creation_commands"
 (id,"projectId","workspaceId","versionId","commandHash");
CREATE UNIQUE INDEX "project_output_states_target_identity_key" ON "project_output_states" ("resultVersionId",id,"projectId","workspaceId");
CREATE TABLE "project_fork_derivations" (
 id varchar(128) PRIMARY KEY, "workspaceId" varchar(128) NOT NULL,
 "sourceProjectId" varchar(128) NOT NULL, "sourceVersionId" varchar(128) NOT NULL,
 "sourceStateId" varchar(128) NOT NULL, "sourceStateHash" char(64) NOT NULL, "sourceBaseHash" char(64) NOT NULL,
 "targetProjectId" varchar(128) NOT NULL, "targetVersionId" varchar(128) NOT NULL, "targetStateId" varchar(128) NOT NULL,
 "creationCommandId" varchar(128) NOT NULL, "schemaVersion" varchar(64) NOT NULL,
 "canonicalPolicyVersion" varchar(64) NOT NULL, "derivationJson" text NOT NULL, "derivationHash" char(64) NOT NULL,
 "createdAt" timestamptz(3) NOT NULL,
 CHECK("schemaVersion"='project-fork-derivation/v2' AND "canonicalPolicyVersion"='output-canonical-json/v1'),
 CHECK("derivationHash"=encode(sha256(convert_to("derivationJson",'UTF8')),'hex'))
);
CREATE UNIQUE INDEX "project_fork_derivations_seal_key" ON "project_fork_derivations" (id,"targetProjectId","workspaceId","derivationHash");
CREATE UNIQUE INDEX "project_fork_derivations_creationCommandId_workspaceId_key" ON "project_fork_derivations" ("creationCommandId","workspaceId");
CREATE UNIQUE INDEX "project_fork_derivations_targetVersionId_targetProjectId_wo_key" ON "project_fork_derivations" ("targetVersionId","targetProjectId","workspaceId");
CREATE TABLE "project_fork_renderable_candidates" (
 id varchar(200) PRIMARY KEY, "workspaceId" varchar(128) NOT NULL, "projectId" varchar(128) NOT NULL,
 "projectVersionId" varchar(128) NOT NULL, "derivationId" varchar(128) NOT NULL, "derivationHash" char(64) NOT NULL,
 "planId" varchar(200) NOT NULL, "planHash" char(64) NOT NULL, "planHashJson" text NOT NULL, "candidateJson" text NOT NULL,
 "candidateHash" char(64) NOT NULL, "createdAt" timestamptz(3) NOT NULL,
 CHECK("planHash"=encode(sha256(convert_to("planHashJson",'UTF8')),'hex')),
 CHECK("candidateHash"=encode(sha256(convert_to("candidateJson",'UTF8')),'hex'))
);
CREATE UNIQUE INDEX "project_fork_renderable_candidates_scope_key" ON "project_fork_renderable_candidates" (id,"projectId","workspaceId");
CREATE UNIQUE INDEX "project_fork_renderable_candidates_projectVersionId_project_key" ON "project_fork_renderable_candidates" ("projectVersionId","projectId","workspaceId");
CREATE TABLE "project_fork_crop_decisions" (
 id varchar(128) PRIMARY KEY, "stateId" varchar(128) NOT NULL, "workspaceId" varchar(128) NOT NULL,
 "projectId" varchar(128) NOT NULL, "variantId" varchar(128) NOT NULL, "clipId" varchar(128) NOT NULL,
 "creationCommandId" varchar(128) NOT NULL, "sourceOverlayId" varchar(128) NOT NULL, "sourceOverlayHash" char(64) NOT NULL,
 status varchar(64) NOT NULL, "decisionJson" text NOT NULL, "decisionHash" char(64) NOT NULL, "createdAt" timestamptz(3) NOT NULL,
 CHECK(status='inactive-requires-target-materialization'),
 CHECK("decisionHash"=encode(sha256(convert_to("decisionJson",'UTF8')),'hex'))
);
CREATE TABLE "project_fork_invalidation_lineage" (
 id varchar(128) PRIMARY KEY, "stateId" varchar(128) NOT NULL, "workspaceId" varchar(128) NOT NULL,
 "projectId" varchar(128) NOT NULL, "variantId" varchar(128) NOT NULL, "sourceId" varchar(128) NOT NULL,
 "sourceHash" char(64) NOT NULL, "lineageJson" text NOT NULL, "lineageHash" char(64) NOT NULL,
 CHECK("lineageHash"=encode(sha256(convert_to("lineageJson",'UTF8')),'hex'))
);
ALTER TABLE "project_fork_derivations" ADD CONSTRAINT "project_fork_derivations_targetVersionId_targetProjectId_w_fkey" FOREIGN KEY ("targetVersionId","targetProjectId","workspaceId") REFERENCES "project_versions" (id,"projectId","workspaceId") DEFERRABLE INITIALLY DEFERRED;
ALTER TABLE "project_fork_derivations" ADD CONSTRAINT "project_fork_derivations_targetVersionId_targetStateId_tar_fkey" FOREIGN KEY ("targetVersionId","targetStateId","targetProjectId","workspaceId") REFERENCES "project_output_states" ("resultVersionId",id,"projectId","workspaceId") DEFERRABLE INITIALLY DEFERRED;
ALTER TABLE "project_fork_derivations" ADD CONSTRAINT "project_fork_derivations_sourceVersionId_sourceProjectId_w_fkey" FOREIGN KEY ("sourceVersionId","sourceProjectId","workspaceId") REFERENCES "project_versions" (id,"projectId","workspaceId") DEFERRABLE INITIALLY DEFERRED;
ALTER TABLE "project_fork_derivations" ADD CONSTRAINT "project_fork_derivations_sourceVersionId_sourceStateId_sou_fkey" FOREIGN KEY ("sourceVersionId","sourceStateId","sourceProjectId","workspaceId","sourceStateHash") REFERENCES "project_output_states" ("resultVersionId",id,"projectId","workspaceId","stateHash") DEFERRABLE INITIALLY DEFERRED;
ALTER TABLE "project_fork_derivations" ADD CONSTRAINT "project_fork_derivations_creationCommandId_fkey" FOREIGN KEY ("creationCommandId") REFERENCES "project_creation_commands" (id) DEFERRABLE INITIALLY DEFERRED;
ALTER TABLE "project_fork_renderable_candidates" ADD CONSTRAINT "project_fork_renderable_candidates_projectVersionId_projec_fkey" FOREIGN KEY ("projectVersionId","projectId","workspaceId") REFERENCES "project_versions" (id,"projectId","workspaceId") DEFERRABLE INITIALLY DEFERRED;
ALTER TABLE "project_fork_renderable_candidates" ADD CONSTRAINT "project_fork_renderable_candidates_derivationId_projectId__fkey" FOREIGN KEY ("derivationId","projectId","workspaceId","derivationHash") REFERENCES "project_fork_derivations" (id,"targetProjectId","workspaceId","derivationHash") DEFERRABLE INITIALLY DEFERRED;
ALTER TABLE "project_fork_crop_decisions" ADD CONSTRAINT "project_fork_crop_decisions_stateId_variantId_projectId_wo_fkey" FOREIGN KEY ("stateId","variantId","projectId","workspaceId") REFERENCES "project_output_state_entries" ("stateId","variantId","projectId","workspaceId") DEFERRABLE INITIALLY DEFERRED;
ALTER TABLE "project_fork_crop_decisions" ADD CONSTRAINT "project_fork_crop_decisions_creationCommandId_fkey" FOREIGN KEY ("creationCommandId") REFERENCES "project_creation_commands" (id) DEFERRABLE INITIALLY DEFERRED;
ALTER TABLE "project_fork_invalidation_lineage" ADD CONSTRAINT "project_fork_invalidation_lineage_stateId_variantId_projec_fkey" FOREIGN KEY ("stateId","variantId","projectId","workspaceId") REFERENCES "project_output_state_entries" ("stateId","variantId","projectId","workspaceId") DEFERRABLE INITIALLY DEFERRED;
ALTER TABLE "project_creation_commands" ADD CONSTRAINT "creation_v2_derivation_seal_fk" FOREIGN KEY
 ("forkDerivationId","projectId","workspaceId","forkDerivationHash") REFERENCES project_fork_derivations(id,"targetProjectId","workspaceId","derivationHash") DEFERRABLE INITIALLY DEFERRED;
ALTER TABLE "project_output_states" ADD CONSTRAINT "states_creation_v2_seal_fk" FOREIGN KEY
 ("creationCommandV2Id","projectId","workspaceId","resultVersionId","provenanceHash")
 REFERENCES project_creation_commands(id,"projectId","workspaceId","versionId","commandHash") DEFERRABLE INITIALLY DEFERRED;
ALTER TABLE "project_output_states" ADD CONSTRAINT "states_fork_candidate_fk" FOREIGN KEY
 ("forkRenderableCandidateId","projectId","workspaceId") REFERENCES project_fork_renderable_candidates(id,"projectId","workspaceId") DEFERRABLE INITIALLY DEFERRED;
-- Existing cyclic relations must not force artificial/null insert order.
ALTER TABLE project_versions ALTER CONSTRAINT project_versions_exact_output_state_fk DEFERRABLE INITIALLY DEFERRED;
ALTER TABLE project_creation_commands ALTER CONSTRAINT "project_creation_commands_versionId_projectId_workspaceId_fkey" DEFERRABLE INITIALLY DEFERRED;

-- Partition every incompatible v1 CHECK explicitly. Its original expression
-- remains literal for historical/v1 rows; v2 is governed by its own complete
-- deferred validator below, not by a nullable bypass.
DO $$ DECLARE item record; gate text; BEGIN
 FOR item IN SELECT c.conname, c.conrelid::regclass AS relation, pg_get_expr(c.conbin,c.conrelid) AS expression
  FROM pg_constraint c WHERE c.contype='c' AND c.conrelid IN
   ('project_output_states'::regclass,'output_variants'::regclass,'output_spec_revisions'::regclass,'project_output_state_entries'::regclass) LOOP
  -- Leave compatible policy, JSON-binding, hash, parent and provenance checks
  -- unchanged. Only the old version/kind/transition/geometry enums differ.
  IF NOT (
   (item.relation::text='project_output_states' AND
    (position('project-output-state/v1' in item.expression)>0 OR position('project-output-transition/v1' in item.expression)>0 OR
     position('initialize-empty' in item.expression)>0 OR position('creation-command' in item.expression)>0)) OR
   (item.relation::text='output_variants' AND position('"createdCommandKind"' in item.expression)>0) OR
   (item.relation::text='output_spec_revisions' AND
    (position('output-spec-revision/v1' in item.expression)>0 OR position('"createdCommandKind"' in item.expression)>0)) OR
   (item.relation::text='project_output_state_entries' AND position('"geometryStatus"' in item.expression)>0)) THEN CONTINUE; END IF;
  gate := CASE item.relation::text WHEN 'project_output_states' THEN '"schemaVersion" = ''project-output-state/v2'''
   WHEN 'output_variants' THEN '"createdCommandKind" = ''creation-command-v2'''
   WHEN 'output_spec_revisions' THEN '"schemaVersion" = ''output-spec-revision/v2'''
   WHEN 'project_output_state_entries' THEN '"geometryStatus" = ''blocked-v2''' END;
  EXECUTE format('ALTER TABLE %s DROP CONSTRAINT %I',item.relation,item.conname);
  EXECUTE format('ALTER TABLE %s ADD CONSTRAINT %I CHECK ((%s) OR (%s))',item.relation,item.conname,gate,item.expression);
 END LOOP;
END $$;
ALTER TABLE project_versions DROP CONSTRAINT project_versions_output_contract_check;
ALTER TABLE project_versions ADD CONSTRAINT project_versions_output_contract_check CHECK (
 ("outputContractVersion"=0 AND "outputStateId" IS NULL AND "outputStateHash" IS NULL AND "outputBaseHashJson" IS NULL AND "outputVersionJson" IS NULL) OR
 ("outputContractVersion" IN (1,2) AND "outputStateId" IS NOT NULL AND "outputStateHash" IS NOT NULL AND "outputStateHash" ~ '^[a-f0-9]{64}$'
  AND "outputBaseHashJson" IS NOT NULL AND "baseHash"=encode(sha256(convert_to("outputBaseHashJson",'UTF8')),'hex')
  AND (CASE WHEN "outputContractVersion"=2 THEN "outputVersionJson" IS NOT NULL ELSE "outputVersionJson" IS NULL END)));
ALTER TABLE project_creation_commands ADD CONSTRAINT creation_document_v2_check CHECK (
 ("schemaVersion"=1 AND "commandJson" IS NULL AND "payloadJson" IS NULL AND "commandBodyJson" IS NULL AND "requestJson" IS NULL
  AND "payloadHash" IS NULL AND "forkDerivationId" IS NULL AND "forkDerivationHash" IS NULL AND "canonicalPolicyVersion" IS NULL) OR
 ("schemaVersion"=2 AND "canonicalPolicyVersion"='output-canonical-json/v1' AND "commandJson" IS NOT NULL AND "commandBodyJson" IS NOT NULL
  AND "payloadJson" IS NOT NULL AND "requestJson" IS NOT NULL AND "payloadHash" IS NOT NULL
  AND "payloadHash"=encode(sha256(convert_to("payloadJson",'UTF8')),'hex')
  AND "commandHash"=encode(sha256(convert_to("commandBodyJson",'UTF8')),'hex')
  AND "requestFingerprint"=encode(sha256(convert_to("requestJson",'UTF8')),'hex')
  AND (("forkDerivationId" IS NULL AND "forkDerivationHash" IS NULL) OR ("forkDerivationId" IS NOT NULL AND "forkDerivationHash" ~ '^[a-f0-9]{64}$'))));
ALTER TABLE project_output_states ADD CONSTRAINT states_v2_discriminator_check CHECK (
 ("schemaVersion"='project-output-state/v1' AND "creationCommandV2Id" IS NULL AND "forkRenderableCandidateId" IS NULL
  AND "consumptionStatus"='historical-v1' AND "consumptionJson" IS NULL) OR
 ("schemaVersion"='project-output-state/v2' AND "creationCommandV2Id" IS NOT NULL AND "consumptionStatus"='blocked'
  AND "consumptionJson" IS NOT NULL AND "canonicalPolicyVersion"='output-canonical-json/v1'
  AND "transitionPolicyVersion"='project-output-transition/v2' AND "producerKind"='creation-command-v2'
  AND "producerId"="creationCommandV2Id" AND "parentVersionId" IS NULL AND "parentStateId" IS NULL AND "parentStateHash" IS NULL
  AND "producerEditCommandId" IS NULL AND "ingestOperationId" IS NULL AND "ingestSourceArtifactId" IS NULL
  AND "ingestSourceManifestId" IS NULL AND "ingestSourceManifestHash" IS NULL AND "ingestTranscriptId" IS NULL AND "ingestTranscriptHash" IS NULL
  AND "renderablePlanSnapshotId" IS NULL AND "renderablePlanId" IS NULL AND "renderablePlanHash" IS NULL
  AND "renderablePlanAuthorityJson" IS NULL AND "renderablePlanAuthorityHash" IS NULL
  AND "stateHash"=encode(sha256(convert_to("stateJson",'UTF8')),'hex')
  AND "producerHash"=encode(sha256(convert_to("producerJson",'UTF8')),'hex')
  AND "editPlanAuthorityHash"=encode(sha256(convert_to("editPlanAuthorityJson",'UTF8')),'hex')));
-- Keep the original version-insert function byte-for-byte; a WHEN routes v2 to
-- its own deferred reciprocity validator. Contract-0 INSERT still hits v1 deny.
DROP TRIGGER project_versions_output_insert ON project_versions;
CREATE TRIGGER project_versions_output_insert BEFORE INSERT ON project_versions
 FOR EACH ROW WHEN (NEW."outputContractVersion" IS DISTINCT FROM 2) EXECUTE FUNCTION w66_version_insert_contract();

CREATE FUNCTION w66_v2_iso(p_input timestamptz) RETURNS text LANGUAGE sql IMMUTABLE STRICT AS $$
 SELECT to_char(p_input AT TIME ZONE 'UTC','YYYY-MM-DD"T"HH24:MI:SS.MS"Z"') $$;
CREATE FUNCTION w66_v2_sha(p_input text) RETURNS text LANGUAGE sql IMMUTABLE STRICT AS $$
 SELECT encode(sha256(convert_to(p_input,'UTF8')),'hex') $$;

-- Stored-envelope metadata only. Ciphertext is never returned/decrypted; the
-- same scope/ref/hash/envelope contract as the integrated projection reader.
CREATE FUNCTION w66_fork_manifest_facts_v2(manifest_id text, workspace_id text) RETURNS jsonb LANGUAGE sql STABLE AS $$
 SELECT jsonb_build_object('id',mf.id,'artifactId',mf."artifactId",'workspaceId',mf."workspaceId",'schemaVersion',mf."schemaVersion",
  'manifestJson',mf."manifestJson",'manifestHash',mf."manifestHash",'createdAt',w66_v2_iso(mf."createdAt"),
  'recipeId',mf."recipeId",'recipeVersion',mf."recipeVersion",'parametersHash',mf."parametersHash",'recipeParametersRef',mf."recipeParametersRef",
  'renderInputRef',mf."renderInputRef",'renderInputHash',mf."renderInputHash",
  'recipeParameters',CASE WHEN rp.ref IS NULL THEN NULL ELSE jsonb_build_object('ref',rp.ref,'workspaceId',rp."workspaceId",'parametersHash',rp."parametersHash",
   'canonicalByteSize',rp."canonicalByteSize",'algorithm',rp.algorithm,'keyId',rp."keyId",'nonce',rp.nonce,'ciphertextSha256',w66_v2_sha(rp.ciphertext),
   'ciphertextByteSize',octet_length(convert_to(rp.ciphertext,'UTF8')),'authTag',rp."authTag",'createdAt',w66_v2_iso(rp."createdAt")) END,
  'renderInput',CASE WHEN ri.ref IS NULL THEN NULL ELSE jsonb_build_object('ref',ri.ref,'workspaceId',ri."workspaceId",'inputHash',ri."inputHash",
   'canonicalByteSize',ri."canonicalByteSize",'algorithm',ri.algorithm,'keyId',ri."keyId",'nonce',ri.nonce,'ciphertextSha256',w66_v2_sha(ri.ciphertext),
   'ciphertextByteSize',octet_length(convert_to(ri.ciphertext,'UTF8')),'authTag',ri."authTag",'createdAt',w66_v2_iso(ri."createdAt")) END)
 FROM media_artifact_manifests mf LEFT JOIN recipe_parameter_payloads rp ON rp.ref=mf."recipeParametersRef" AND rp."workspaceId"=mf."workspaceId"
 LEFT JOIN render_input_payloads ri ON ri.ref=mf."renderInputRef" AND ri."workspaceId"=mf."workspaceId"
 WHERE mf.id=manifest_id AND mf."workspaceId"=workspace_id $$;

CREATE FUNCTION w66_fork_id_v2(m jsonb, k text, source_id text) RETURNS text LANGUAGE plpgsql IMMUTABLE AS $$
DECLARE answer text; matches integer; BEGIN
 SELECT count(*),min(mapping.entry->>'targetId') INTO matches,answer FROM jsonb_array_elements(m) AS mapping(entry)
 WHERE mapping.entry->>'kind'=k AND mapping.entry->>'sourceId'=source_id;
 IF source_id IS NULL OR matches<>1 OR answer IS NULL OR answer=source_id THEN
  RAISE EXCEPTION 'W66v2 fork reference missing or ambiguous' USING ERRCODE='23514'; END IF;
 RETURN answer;
END $$;
CREATE FUNCTION w66_fork_container_v2(p_document jsonb, m jsonb, k text, fields jsonb DEFAULT '{}'::jsonb)
 RETURNS jsonb LANGUAGE plpgsql IMMUTABLE AS $$
DECLARE result jsonb := p_document; field record; BEGIN
 IF jsonb_typeof(p_document) IS DISTINCT FROM 'object' THEN RAISE EXCEPTION 'W66v2 typed container missing' USING ERRCODE='23514'; END IF;
 IF p_document ? 'id' THEN result := jsonb_set(result,'{id}',to_jsonb(w66_fork_id_v2(m,k,p_document->>'id'))); END IF;
 FOR field IN SELECT mapping.field_key,mapping.field_kind FROM jsonb_each_text(fields) AS mapping(field_key,field_kind) LOOP
  IF p_document ? field.field_key THEN result := jsonb_set(result,ARRAY[field.field_key],to_jsonb(w66_fork_id_v2(m,field.field_kind,p_document->>field.field_key))); END IF;
 END LOOP;
 RETURN result;
END $$;
CREATE FUNCTION w66_fork_plan_v2(p_document jsonb, m jsonb, target jsonb, ref jsonb, source_row jsonb, compiled boolean)
 RETURNS jsonb LANGUAGE plpgsql IMMUTABLE AS $$
DECLARE result jsonb; key text; member_kind text; fields jsonb; item jsonb; track jsonb; items jsonb; tracks jsonb;
BEGIN
 IF p_document ?| ARRAY['reviewStatus','forkDerivationRef','sourceDirectionLineage','sourceEditingLineage']
  OR (p_document ? 'localeVariantRefs' AND p_document->'localeVariantRefs' IS DISTINCT FROM '[]'::jsonb) THEN
  RAISE EXCEPTION 'W66v2 source is not an original typed plan' USING ERRCODE='23514'; END IF;
 result := p_document || jsonb_build_object('id',w66_fork_id_v2(m,CASE WHEN compiled THEN 'renderable-plan' ELSE 'edit-plan' END,p_document->>'id'),
  'projectVersionId',target->>'resultVersionId','createdAt',target->>'createdAt');
 IF p_document ? 'projectId' THEN result := result || jsonb_build_object('projectId',target->>'projectId'); END IF;
 IF p_document ? 'workspaceId' THEN result := result || jsonb_build_object('workspaceId',target->>'workspaceId'); END IF;
 FOREACH key IN ARRAY ARRAY['sources','videoTracks','subtitleTracks','audioTracks','overlayTracks','effectTracks','markers','protectedElements','transitions'] LOOP
  IF NOT p_document ? key THEN
   IF key IN ('markers','protectedElements','transitions') THEN CONTINUE; END IF;
   RAISE EXCEPTION 'W66v2 required typed array missing' USING ERRCODE='23514'; END IF;
  IF jsonb_typeof(p_document->key) IS DISTINCT FROM 'array' THEN RAISE EXCEPTION 'W66v2 typed array invalid' USING ERRCODE='23514'; END IF;
  member_kind := CASE key WHEN 'sources' THEN 'plan-source' WHEN 'markers' THEN 'marker' WHEN 'protectedElements' THEN 'protected-element'
   WHEN 'transitions' THEN 'transition' ELSE 'track' END;
  fields := CASE key WHEN 'overlayTracks' THEN '{"clipId":"clip","variantId":"variant"}'::jsonb
   WHEN 'effectTracks' THEN '{"clipId":"clip","trackId":"track"}'::jsonb WHEN 'markers' THEN '{"clipId":"clip"}'::jsonb
   WHEN 'protectedElements' THEN '{"clipId":"clip","cueId":"cue","trackId":"track"}'::jsonb
   WHEN 'transitions' THEN '{"fromClipId":"clip","toClipId":"clip"}'::jsonb ELSE '{}'::jsonb END;
  tracks := '[]'::jsonb;
  FOR item IN SELECT outer_items.element FROM jsonb_array_elements(p_document->key) AS outer_items(element) LOOP
   track := w66_fork_container_v2(item,m,member_kind,fields);
   IF key IN ('videoTracks','subtitleTracks') THEN
    items := '[]'::jsonb;
    FOR item IN SELECT inner_items.element FROM jsonb_array_elements(item->(CASE key WHEN 'videoTracks' THEN 'clips' ELSE 'cues' END)) AS inner_items(element) LOOP
     items := items || jsonb_build_array(w66_fork_container_v2(item,m,CASE key WHEN 'videoTracks' THEN 'clip' ELSE 'cue' END,
      CASE key WHEN 'videoTracks' THEN '{"sourceId":"plan-source","trackId":"track"}'::jsonb ELSE '{"clipId":"clip","trackId":"track"}'::jsonb END));
    END LOOP;
    track := track || jsonb_build_object(CASE key WHEN 'videoTracks' THEN 'clips' ELSE 'cues' END,items);
   END IF;
   IF key='audioTracks' AND track->>'kind' IS DISTINCT FROM 'background-music' THEN
    RAISE EXCEPTION 'W66v2 audio container unsupported' USING ERRCODE='23514'; END IF;
   tracks := tracks || jsonb_build_array(track);
  END LOOP;
  result := jsonb_set(result,ARRAY[key],tracks);
 END LOOP;
 IF p_document ? 'formatVariantRefs' THEN
  SELECT coalesce(jsonb_agg(to_jsonb(w66_fork_id_v2(m,'variant',variants.source_id))), '[]'::jsonb) INTO items FROM jsonb_array_elements_text(p_document->'formatVariantRefs') AS variants(source_id);
  result := result || jsonb_build_object('formatVariantRefs',items);
 END IF;
 FOREACH key IN ARRAY ARRAY['storyPlanId','treatmentPlanId'] LOOP
  IF EXISTS(SELECT 1 FROM jsonb_array_elements(m) AS map_items(element) WHERE map_items.element->>'kind'='snapshot' AND map_items.element->>'sourceId'=p_document->>key) THEN
   result := result || jsonb_build_object(key,w66_fork_id_v2(m,'snapshot',p_document->>key)); END IF;
 END LOOP;
 result := result - ARRAY['critic','qualityReport','quality','qualityScore','acceptance','approval','proxyReview','manualEditing'];
 IF compiled OR p_document ? 'directorRunId' THEN
  result := result - ARRAY['directorRunId','storyPlanId','treatmentPlanId','director'];
  result := result || jsonb_build_object('sourceDirectionLineage',
   jsonb_build_object('snapshotId',source_row->>'id','planId',p_document->>'id','planHash',source_row->>'planHash',
    'directorRunId',p_document->>'directorRunId','storyPlanId',p_document->>'storyPlanId','treatmentPlanId',p_document->>'treatmentPlanId','director',p_document->'director') ||
   CASE WHEN compiled THEN jsonb_build_object('origin',source_row->>'origin','sourceId',source_row->>'sourceId','sourceHash',source_row->>'sourceHash','sourceVersion',source_row->'sourceVersion') ELSE '{}'::jsonb END);
 END IF;
 IF NOT compiled AND p_document ? 'manualEditing' THEN
  result := result || jsonb_build_object('sourceEditingLineage',jsonb_build_object('sourceVersionId',source_row->>'projectVersionId',
   'sourcePlanId',p_document->>'id','sourcePlanHash',source_row->>'planHash','manualEditing',p_document->'manualEditing')); END IF;
 result := result || jsonb_build_object('forkDerivationRef',ref);
 IF compiled THEN result := result || jsonb_build_object('reviewStatus','requires-target-materialization'); END IF;
 RETURN result;
END $$;
-- No recursive key rewriting. These are exclusively the contracts' owning
-- containers. Anonymous markers, text and content-addressed action refs remain
-- untouched even when their strings resemble an owned ID.
CREATE FUNCTION w66_fork_plan_members_v2(p_document jsonb, compiled boolean) RETURNS TABLE(kind text,id text)
 LANGUAGE sql IMMUTABLE AS $$
 SELECT CASE WHEN compiled THEN 'renderable-plan' ELSE 'edit-plan' END,p_document->>'id'
 UNION SELECT 'plan-source',elements.entry->>'id' FROM jsonb_array_elements(p_document->'sources') AS elements(entry)
 UNION SELECT 'track',elements.entry->>'id' FROM jsonb_array_elements(coalesce(p_document->'videoTracks','[]') || coalesce(p_document->'subtitleTracks','[]') ||
  coalesce(p_document->'audioTracks','[]') || coalesce(p_document->'overlayTracks','[]') || coalesce(p_document->'effectTracks','[]')) AS elements(entry)
 UNION SELECT 'clip',clips.entry->>'id' FROM jsonb_array_elements(p_document->'videoTracks') AS tracks(entry) CROSS JOIN LATERAL jsonb_array_elements(tracks.entry->'clips') AS clips(entry)
 UNION SELECT 'cue',cues.entry->>'id' FROM jsonb_array_elements(p_document->'subtitleTracks') AS tracks(entry) CROSS JOIN LATERAL jsonb_array_elements(tracks.entry->'cues') AS cues(entry)
 UNION SELECT 'marker',elements.entry->>'id' FROM jsonb_array_elements(coalesce(p_document->'markers','[]')) AS elements(entry) WHERE elements.entry ? 'id'
 UNION SELECT 'protected-element',elements.entry->>'id' FROM jsonb_array_elements(coalesce(p_document->'protectedElements','[]')) AS elements(entry) WHERE elements.entry ? 'id'
 UNION SELECT 'transition',elements.entry->>'id' FROM jsonb_array_elements(coalesce(p_document->'transitions','[]')) AS elements(entry) WHERE elements.entry ? 'id'
 $$;


-- Source audio text is anchored to the factual source audioTimelineHash. JSON
-- (not jsonb) retains original numeric/string lexemes. This function remints
-- only direct musicTracks[].id, never arbitrary metadata or other ID-like text.
CREATE FUNCTION w66_v2_rebind_audio_text(p_input text, m jsonb) RETURNS text LANGUAGE plpgsql IMMUTABLE AS $$
DECLARE answer text; tracks text; BEGIN
 SELECT '['||coalesce(string_agg('{'||(SELECT string_agg(to_json(music_fields.field_key)::text||':'||
   CASE WHEN music_fields.field_key='id' THEN to_json(w66_fork_id_v2(m,'track',music_fields.field_value::jsonb #>> '{}'))::text ELSE music_fields.field_value::text END,',' ORDER BY music_fields.ordinal)
   FROM json_each(track_items.document) WITH ORDINALITY AS music_fields(field_key,field_value,ordinal))||'}',',' ORDER BY track_items.ordinal),'')||']'
 INTO tracks FROM json_array_elements((p_input::json)->'musicTracks') WITH ORDINALITY AS track_items(document,ordinal);
 SELECT '{'||string_agg(to_json(top_fields.field_key)::text||':'||CASE WHEN top_fields.field_key='musicTracks' THEN tracks ELSE top_fields.field_value::text END,',' ORDER BY top_fields.ordinal)||'}'
 INTO answer FROM json_each(p_input::json) WITH ORDINALITY AS top_fields(field_key,field_value,ordinal);
 RETURN answer;
END $$;
CREATE FUNCTION w66_v2_exact_json(p_document jsonb, keys text[]) RETURNS boolean LANGUAGE plpgsql IMMUTABLE AS $$
DECLARE actual text[]; expected text[]; BEGIN
 IF jsonb_typeof(p_document) IS DISTINCT FROM 'object' THEN RETURN false; END IF;
 SELECT array_agg(actual_keys.field_key ORDER BY actual_keys.field_key COLLATE "C") INTO actual FROM jsonb_object_keys(p_document) AS actual_keys(field_key);
 SELECT array_agg(expected_keys.field_key ORDER BY expected_keys.field_key COLLATE "C") INTO expected FROM unnest(keys) AS expected_keys(field_key);
 RETURN actual IS NOT DISTINCT FROM expected;
END $$;
CREATE FUNCTION w66_assert_creation_bundle_v2(state_id text) RETURNS void LANGUAGE plpgsql AS $$
DECLARE s project_output_states%ROWTYPE; v project_versions%ROWTYPE; c project_creation_commands%ROWTYPE;
 p projects%ROWTYPE; src projects%ROWTYPE; sv project_versions%ROWTYPE; ss project_output_states%ROWTYPE;
 d project_fork_derivations%ROWTYPE; r project_snapshots%ROWTYPE; candidate project_fork_renderable_candidates%ROWTYPE;
 revision output_spec_revisions%ROWTYPE; member project_output_state_entries%ROWTYPE;
 b jsonb; command jsonb; payload jsonb; derivation jsonb; kernel jsonb; source jsonb; target jsonb; map jsonb;
 item jsonb; source_item jsonb; expected jsonb; expected_plan jsonb; ref jsonb; source_plan jsonb; source_row jsonb;
 source_doc jsonb; authority jsonb; audio jsonb; speech_body jsonb; source_ids jsonb; mapped_ids jsonb; key text; actor jsonb; actual_count integer;
BEGIN
 SELECT * INTO s FROM project_output_states WHERE id=state_id;
 IF NOT FOUND OR s."schemaVersion" IS DISTINCT FROM 'project-output-state/v2' THEN
  RAISE EXCEPTION 'W66v2 exact State absent' USING ERRCODE='23514'; END IF;
 SELECT * INTO STRICT v FROM project_versions WHERE id=s."resultVersionId" AND "projectId"=s."projectId" AND "workspaceId"=s."workspaceId";
 SELECT * INTO STRICT c FROM project_creation_commands WHERE id=s."creationCommandV2Id" AND "projectId"=s."projectId" AND "workspaceId"=s."workspaceId";
 SELECT * INTO STRICT p FROM projects WHERE id=s."projectId" AND "workspaceId"=s."workspaceId";
 b:=s."stateJson"::jsonb; command:=c."commandJson"::jsonb; payload:=c."payloadJson"::jsonb;
 IF NOT w66_v2_exact_json(command,ARRAY['schemaVersion','canonicalPolicyVersion','id','workspaceId','projectId','versionId','actorContextHash','audit','author','createdAt','payload','payloadHash','requestFingerprint','commandHash'])
  OR NOT w66_v2_exact_json(payload,ARRAY['schemaVersion','canonicalPolicyVersion','callerIntent','allocations','snapshots','forkDerivation','renderableCandidate'])
  OR NOT w66_v2_exact_json(b,ARRAY['schemaVersion','canonicalPolicyVersion','transitionPolicyVersion','id','workspaceId','projectId','resultVersionId','parentVersionId','parentStateId','parentStateHash','transition','provenance','producer','editPlan','renderablePlan','entries','overlays','invalidations','sourceDependencies','consumption','createdAt']) THEN
  RAISE EXCEPTION 'W66v2 document shape or circular result authority invalid' USING ERRCODE='23514'; END IF;
 IF v."outputContractVersion" IS DISTINCT FROM 2 OR c."schemaVersion" IS DISTINCT FROM 2 OR p."creationContractVersion" IS DISTINCT FROM 2
  OR p."currentVersionId" IS DISTINCT FROM v.id OR v."outputStateId" IS DISTINCT FROM s.id OR v."outputStateHash" IS DISTINCT FROM s."stateHash"
  OR c."versionId" IS DISTINCT FROM v.id OR v.sequence<>1 OR v."parentVersionId" IS NOT NULL OR v."commandId" IS NOT NULL
  OR v."createdBy" IS DISTINCT FROM c."actorClientId" OR v."createdAt" IS DISTINCT FROM c."createdAt" OR s."createdAt" IS DISTINCT FROM c."createdAt"
  OR p."createdAt" IS DISTINCT FROM c."createdAt" OR p."createdByType" IS DISTINCT FROM 'api-client' OR p."createdById" IS DISTINCT FROM c."actorClientId"
  OR p."ownerId" IS DISTINCT FROM c."actorClientId" OR p.name IS DISTINCT FROM payload #>> '{callerIntent,name}' OR p.status IS DISTINCT FROM 'draft' THEN
  RAISE EXCEPTION 'W66v2 project/Version/State/Creation reciprocity mismatch' USING ERRCODE='23514'; END IF;
 actor:=command->'audit';
 IF command->>'canonicalPolicyVersion' IS DISTINCT FROM 'output-canonical-json/v1' OR command->>'schemaVersion' IS DISTINCT FROM '2'
  OR command->>'id' IS DISTINCT FROM c.id OR command->>'workspaceId' IS DISTINCT FROM c."workspaceId" OR command->>'projectId' IS DISTINCT FROM c."projectId"
  OR command->>'versionId' IS DISTINCT FROM v.id OR command->>'commandHash' IS DISTINCT FROM c."commandHash"
  OR command->>'payloadHash' IS DISTINCT FROM c."payloadHash" OR command->>'actorContextHash' IS DISTINCT FROM c."actorContextHash"
  OR command->>'requestFingerprint' IS DISTINCT FROM c."requestFingerprint" OR command->>'createdAt' IS DISTINCT FROM w66_v2_iso(c."createdAt")
  OR command->'payload' IS DISTINCT FROM payload OR actor->>'workspaceId' IS DISTINCT FROM c."workspaceId"
  OR actor->>'clientId' IS DISTINCT FROM c."actorClientId" OR actor->>'credentialId' IS DISTINCT FROM c."actorCredentialId"
  OR actor->>'environment' IS DISTINCT FROM c."actorEnvironment" OR actor->>'authenticationKind' IS DISTINCT FROM c."actorAuthenticationKind"
  OR actor->>'contextHash' IS DISTINCT FROM c."actorContextHash" OR actor->>'delegatedUserId' IS DISTINCT FROM c."actorDelegatedUserId"
  OR actor->>'delegatedIdentityId' IS DISTINCT FROM c."actorDelegatedIdentityId" OR actor->>'workspaceRole' IS DISTINCT FROM c."actorWorkspaceRole"
  OR command->'author' IS DISTINCT FROM jsonb_strip_nulls(jsonb_build_object('type','api-client','id',c."actorClientId",'delegatedUserId',c."actorDelegatedUserId")) THEN
  RAISE EXCEPTION 'W66v2 Command actor/row/body mismatch' USING ERRCODE='23514'; END IF;
 expected:=jsonb_build_object('canonicalPolicyVersion','output-canonical-json/v1','schemaVersion',2,'id',c.id,'workspaceId',c."workspaceId",'projectId',c."projectId",
  'versionId',v.id,'actorContextHash',c."actorContextHash",'payloadHash',c."payloadHash",'requestFingerprint',c."requestFingerprint",'createdAt',w66_v2_iso(c."createdAt"));
 IF c."commandBodyJson"::jsonb IS DISTINCT FROM expected OR payload->>'schemaVersion' IS DISTINCT FROM 'project-creation-output-payload/v2'
  OR payload->>'canonicalPolicyVersion' IS DISTINCT FROM 'output-canonical-json/v1'
  OR b->>'schemaVersion' IS DISTINCT FROM 'project-output-state/v2' OR b->>'transitionPolicyVersion' IS DISTINCT FROM 'project-output-transition/v2'
  OR b->>'canonicalPolicyVersion' IS DISTINCT FROM 'output-canonical-json/v1' OR b->>'id' IS DISTINCT FROM s.id
  OR b->>'workspaceId' IS DISTINCT FROM s."workspaceId" OR b->>'projectId' IS DISTINCT FROM s."projectId" OR b->>'resultVersionId' IS DISTINCT FROM v.id
  OR b->'parentVersionId' IS DISTINCT FROM 'null'::jsonb OR b->'parentStateId' IS DISTINCT FROM 'null'::jsonb OR b->'parentStateHash' IS DISTINCT FROM 'null'::jsonb
  OR b->>'transition' IS DISTINCT FROM s.transition OR s.transition IS DISTINCT FROM payload #>> '{callerIntent,kind}'
  OR b->>'createdAt' IS DISTINCT FROM w66_v2_iso(s."createdAt") OR payload #>> '{allocations,stateId}' IS DISTINCT FROM s.id
  OR b->'provenance' IS DISTINCT FROM jsonb_build_object('kind','creation-command-v2','id',c.id,'hash',c."commandHash")
  OR s."producerId" IS DISTINCT FROM c.id OR s."provenanceHash" IS DISTINCT FROM c."commandHash"
  OR b->'consumption' IS DISTINCT FROM s."consumptionJson"::jsonb OR b #>> '{consumption,status}' IS DISTINCT FROM 'blocked' THEN
  RAISE EXCEPTION 'W66v2 Command/State sealed fields mismatch' USING ERRCODE='23514'; END IF;
 expected:=jsonb_build_object('canonicalPolicyVersion','output-canonical-json/v1','schemaVersion','project-creation-output-producer/v2',
  'commandId',c.id,'commandHash',c."commandHash",'payloadHash',c."payloadHash",'requestFingerprint',c."requestFingerprint",'actorContextHash',c."actorContextHash");
 IF s."producerJson"::jsonb IS DISTINCT FROM expected OR b->'producer' IS DISTINCT FROM jsonb_build_object('document',expected,'hash',s."producerHash") THEN
  RAISE EXCEPTION 'W66v2 producer exact Command seal mismatch' USING ERRCODE='23514'; END IF;
 expected:=jsonb_build_object('canonicalPolicyVersion','output-canonical-json/v1','schemaVersion','project-output-bound-version-hash/v2',
  'workspaceId',s."workspaceId",'projectId',s."projectId",'resultVersionId',v.id,'parentVersionId',NULL,'previousBaseHash',NULL,
  'producerHash',s."producerHash",'outputStateId',s.id,'outputStateHash',s."stateHash");
 IF v."outputBaseHashJson"::jsonb IS DISTINCT FROM expected THEN RAISE EXCEPTION 'W66v2 Version base authority mismatch' USING ERRCODE='23514'; END IF;
 expected:=jsonb_strip_nulls(jsonb_build_object('canonicalPolicyVersion','output-canonical-json/v1','schemaVersion',1,'outputContractVersion',2,
  'id',v.id,'workspaceId',v."workspaceId",'projectId',v."projectId",'sequence',1,'snapshotRefs',jsonb_strip_nulls(jsonb_build_object('brief',v."briefSnapshotId",'policies',v."policiesSnapshotId",
   'editPlan',v."editPlanSnapshotId",'treatment',v."treatmentSnapshotId",'story',v."storySnapshotId")),
  'forkedFromProjectId',v."forkedFromProjectId",'forkedFromVersionId',v."forkedFromVersionId",'baseHash',v."baseHash",'outputStateId',s.id,'outputStateHash',s."stateHash",'createdBy',v."createdBy",'createdAt',w66_v2_iso(v."createdAt")));
 IF v."outputVersionJson"::jsonb IS DISTINCT FROM expected THEN RAISE EXCEPTION 'W66v2 Version row/document mismatch' USING ERRCODE='23514'; END IF;
 IF jsonb_typeof(payload->'snapshots') IS DISTINCT FROM 'array' OR jsonb_array_length(payload->'snapshots') NOT BETWEEN 3 AND 5
  OR jsonb_array_length(payload->'snapshots')<>(SELECT count(DISTINCT x->>'kind') FROM jsonb_array_elements(payload->'snapshots') x)
  OR (SELECT count(*) FROM project_snapshots WHERE "projectId"=p.id AND "workspaceId"=p."workspaceId")<>jsonb_array_length(payload->'snapshots') THEN
  RAISE EXCEPTION 'W66v2 target snapshots membership mismatch' USING ERRCODE='23514'; END IF;
 FOR item IN SELECT x FROM jsonb_array_elements(payload->'snapshots') x LOOP
  SELECT * INTO r FROM project_snapshots WHERE id=item->>'id' AND "projectId"=p.id AND "workspaceId"=p."workspaceId";
  IF NOT FOUND OR r.kind NOT IN ('brief','policies','edit-plan','treatment','story') OR r."schemaVersion"<1 OR r."createdAt"<>c."createdAt"
   OR item IS DISTINCT FROM jsonb_build_object('schemaVersion',1,'id',r.id,'workspaceId',r."workspaceId",'projectId',r."projectId",'kind',r.kind,
    'contentSchemaVersion',r."schemaVersion",'contentJson',r."contentJson",'contentHash',r."contentHash",'createdAt',w66_v2_iso(r."createdAt"))
   OR r."contentHash" IS DISTINCT FROM w66_v2_sha(r."contentJson")
   OR payload #>> ARRAY['allocations','snapshotRefs',r.kind] IS DISTINCT FROM r.id THEN
   RAISE EXCEPTION 'W66v2 target snapshot actual row/hash/schema mismatch' USING ERRCODE='23514'; END IF;
 END LOOP;
 IF payload #>> '{allocations,snapshotRefs,brief}' IS DISTINCT FROM v."briefSnapshotId" OR payload #>> '{allocations,snapshotRefs,policies}' IS DISTINCT FROM v."policiesSnapshotId"
  OR payload #>> '{allocations,snapshotRefs,edit-plan}' IS DISTINCT FROM v."editPlanSnapshotId" OR payload #>> '{allocations,snapshotRefs,treatment}' IS DISTINCT FROM v."treatmentSnapshotId"
  OR payload #>> '{allocations,snapshotRefs,story}' IS DISTINCT FROM v."storySnapshotId" OR s."editPlanSnapshotId"<>v."editPlanSnapshotId" THEN
  RAISE EXCEPTION 'W66v2 snapshot allocations/Version binding mismatch' USING ERRCODE='23514'; END IF;
 SELECT * INTO STRICT r FROM project_snapshots WHERE id=s."editPlanSnapshotId" AND "projectId"=p.id AND "workspaceId"=p."workspaceId";
 authority:=s."editPlanAuthorityJson"::jsonb;
 IF s."editPlanHash" IS DISTINCT FROM r."contentHash" OR authority->>'schemaVersion' IS DISTINCT FROM 'output-plan-authority/v1'
  OR authority->>'canonicalPolicyVersion' IS DISTINCT FROM 'output-canonical-json/v1' OR authority->>'kind' IS DISTINCT FROM 'project-edit-plan'
  OR authority->>'legacyCanonicalJson' IS DISTINCT FROM r."contentJson" OR authority->>'legacyHash' IS DISTINCT FROM r."contentHash"
  OR b->'editPlan' IS DISTINCT FROM jsonb_build_object('snapshotId',r.id,'hash',r."contentHash",'authority',jsonb_build_object('schemaVersion','output-plan-authority/v1','document',authority,'hash',s."editPlanAuthorityHash"))
  OR r."contentJson"::jsonb->>'projectVersionId' IS DISTINCT FROM v.id THEN
  RAISE EXCEPTION 'W66v2 target EditPlan authority mismatch' USING ERRCODE='23514'; END IF;
 IF s.transition='initialize-empty' THEN
  IF c.action IS DISTINCT FROM 'create' OR c."sourceProjectId" IS NOT NULL OR c."sourceVersionId" IS NOT NULL OR c."forkDerivationId" IS NOT NULL
   OR p."duplicatedFromProjectId" IS NOT NULL OR v."forkedFromProjectId" IS NOT NULL OR v."forkedFromVersionId" IS NOT NULL
   OR p.format IS NOT NULL OR p.objective IS DISTINCT FROM payload #>> '{callerIntent,objective}' OR p.locale IS DISTINCT FROM payload #>> '{callerIntent,locale}'
   OR payload->'forkDerivation' IS DISTINCT FROM 'null'::jsonb OR payload->'renderableCandidate' IS DISTINCT FROM 'null'::jsonb
   OR payload #> '{allocations,renderablePlanSnapshotId}' IS DISTINCT FROM 'null'::jsonb OR b->'renderablePlan' IS DISTINCT FROM 'null'::jsonb
   OR b->'sourceDependencies' IS DISTINCT FROM 'null'::jsonb OR b->'entries' IS DISTINCT FROM '[]'::jsonb OR b->'overlays' IS DISTINCT FROM '[]'::jsonb OR b->'invalidations' IS DISTINCT FROM '[]'::jsonb
   OR b->'consumption' IS DISTINCT FROM '{"status":"blocked","reasons":["empty-project"]}'::jsonb
   OR r."contentJson"::jsonb->>'durationFrames' IS DISTINCT FROM '0'
   OR EXISTS(SELECT 1 FROM jsonb_each(r."contentJson"::jsonb) x WHERE x.key IN ('sources','videoTracks','audioTracks','subtitleTracks','overlayTracks','effectTracks','markers','protectedElements','transitions') AND x.value IS DISTINCT FROM '[]'::jsonb)
   OR EXISTS(SELECT 1 FROM project_media_assets WHERE "projectId"=p.id) THEN
   RAISE EXCEPTION 'W66v2 initialize requires an actual empty project and explicit caller intent' USING ERRCODE='23514'; END IF;
  SELECT "contentJson"::jsonb INTO source_doc FROM project_snapshots WHERE id=v."briefSnapshotId";
  IF source_doc->>'objective' IS DISTINCT FROM p.objective OR source_doc->'desiredAction' IS DISTINCT FROM payload #> '{callerIntent,desiredAction}'
   OR source_doc->>'createdAt' IS DISTINCT FROM w66_v2_iso(c."createdAt") THEN RAISE EXCEPTION 'W66v2 root brief caller intent mismatch' USING ERRCODE='23514'; END IF;
  IF c."requestJson"::jsonb IS DISTINCT FROM jsonb_build_object('canonicalPolicyVersion','output-canonical-json/v1','schemaVersion','project-creation-output-request/v2',
   'workspaceId',c."workspaceId",'callerIntent',payload->'callerIntent','actorContextHash',c."actorContextHash",'sourceBaseline',NULL) THEN
   RAISE EXCEPTION 'W66v2 request fingerprint body mismatch' USING ERRCODE='23514'; END IF;
 ELSE
  IF s.transition IS DISTINCT FROM 'fork-with-content' THEN RAISE EXCEPTION 'W66v2 unsupported transition' USING ERRCODE='23514'; END IF;
  SELECT * INTO STRICT d FROM project_fork_derivations WHERE id=c."forkDerivationId" AND "targetProjectId"=p.id AND "workspaceId"=p."workspaceId";
  derivation:=d."derivationJson"::jsonb; kernel:=derivation #> '{kernel,document}'; source:=kernel->'source'; target:=kernel->'target'; map:=kernel->'identityMap';
  IF NOT w66_v2_exact_json(derivation,ARRAY['schemaVersion','canonicalPolicyVersion','id','kernel','kernelCanonicalJson','sourceEditPlanSnapshot','sourceReferences','sourceProject'])
   OR (derivation->>'kernelCanonicalJson')::jsonb IS DISTINCT FROM kernel OR w66_v2_sha(derivation->>'kernelCanonicalJson') IS DISTINCT FROM derivation #>> '{kernel,derivationHash}'
   OR source->>'previousBaseHash' IS DISTINCT FROM (SELECT parent."baseHash" FROM project_versions vsource JOIN project_versions parent ON parent.id=vsource."parentVersionId" WHERE vsource.id=d."sourceVersionId") THEN
   RAISE EXCEPTION 'W66v2 derivation kernel/source parent text seal mismatch' USING ERRCODE='23514'; END IF;
  SELECT * INTO STRICT src FROM projects WHERE id=d."sourceProjectId" AND "workspaceId"=p."workspaceId";
  SELECT * INTO STRICT sv FROM project_versions WHERE id=d."sourceVersionId" AND "projectId"=src.id AND "workspaceId"=p."workspaceId";
  SELECT * INTO STRICT ss FROM project_output_states WHERE id=d."sourceStateId" AND "resultVersionId"=sv.id AND "projectId"=src.id AND "workspaceId"=p."workspaceId";
  PERFORM w66_assert_output_state(ss.id);
  IF sv."outputContractVersion" IS DISTINCT FROM 1 OR src."currentVersionId" IS DISTINCT FROM sv.id OR sv."baseHash" IS DISTINCT FROM d."sourceBaseHash"
   OR ss."stateHash" IS DISTINCT FROM d."sourceStateHash" OR source #> '{state,document}' IS DISTINCT FROM ss."stateJson"::jsonb
   OR source #>> '{state,stateHash}' IS DISTINCT FROM ss."stateHash" OR source->>'outputBaseHashJson' IS DISTINCT FROM sv."outputBaseHashJson"
   OR d."targetVersionId" IS DISTINCT FROM v.id OR d."targetStateId" IS DISTINCT FROM s.id OR d."creationCommandId" IS DISTINCT FROM c.id
   OR d."derivationHash" IS DISTINCT FROM c."forkDerivationHash" OR d."createdAt" IS DISTINCT FROM c."createdAt"
   OR payload->'forkDerivation' IS DISTINCT FROM jsonb_build_object('schemaVersion','project-fork-derivation/v2','document',derivation,'derivationHash',d."derivationHash")
   OR derivation->>'id' IS DISTINCT FROM d.id OR derivation->>'schemaVersion' IS DISTINCT FROM d."schemaVersion" OR derivation->>'canonicalPolicyVersion' IS DISTINCT FROM d."canonicalPolicyVersion"
   OR kernel->>'id' IS DISTINCT FROM d.id OR kernel->'audit' IS DISTINCT FROM actor OR kernel->'callerIntent' IS DISTINCT FROM payload->'callerIntent'
   OR kernel->>'compilePolicyVersion' IS DISTINCT FROM 'project-fork-typed-remap/2026-10-12-v1'
   OR target IS DISTINCT FROM jsonb_build_object('commandId',c.id,'workspaceId',p."workspaceId",'projectId',p.id,'resultVersionId',v.id,'stateId',s.id,
    'parentVersionId',NULL,'sequence',1,'createdBy',c."actorClientId",'createdAt',w66_v2_iso(c."createdAt"))
   OR c.action IS DISTINCT FROM 'duplicate' OR c."sourceProjectId" IS DISTINCT FROM src.id OR c."sourceVersionId" IS DISTINCT FROM sv.id
   OR v."forkedFromProjectId" IS DISTINCT FROM src.id OR v."forkedFromVersionId" IS DISTINCT FROM sv.id OR p."duplicatedFromProjectId" IS DISTINCT FROM src.id
   OR p.objective IS DISTINCT FROM src.objective OR p.locale IS DISTINCT FROM src.locale OR p.format IS DISTINCT FROM src.format
   OR derivation->'sourceProject' IS DISTINCT FROM jsonb_build_object('id',src.id,'workspaceId',src."workspaceId",'currentVersionId',sv.id,
    'name',src.name,'status',src.status,'format',src.format,'ownerId',src."ownerId",'administrationRevision',src."administrationRevision",'updatedAt',w66_v2_iso(src."updatedAt"),'objective',src.objective,'locale',src.locale,'createdByType',src."createdByType",'createdById',src."createdById",'createdAt',w66_v2_iso(src."createdAt")) THEN
   RAISE EXCEPTION 'W66v2 fork source/target facts or head authority mismatch' USING ERRCODE='23514'; END IF;

  expected:=jsonb_strip_nulls(jsonb_build_object('canonicalPolicyVersion','output-canonical-json/v1','schemaVersion',1,'outputContractVersion',1,
   'id',sv.id,'workspaceId',sv."workspaceId",'projectId',sv."projectId",'sequence',sv.sequence,'parentVersionId',sv."parentVersionId",'commandId',sv."commandId",
   'forkedFromProjectId',sv."forkedFromProjectId",'forkedFromVersionId',sv."forkedFromVersionId",'snapshotRefs',jsonb_strip_nulls(jsonb_build_object('brief',sv."briefSnapshotId",'policies',sv."policiesSnapshotId",
   'editPlan',sv."editPlanSnapshotId",'treatment',sv."treatmentSnapshotId",'story',sv."storySnapshotId")),'baseHash',sv."baseHash",'outputStateId',ss.id,'outputStateHash',ss."stateHash",'createdBy',sv."createdBy",'createdAt',w66_v2_iso(sv."createdAt")));
  IF source->'version' IS DISTINCT FROM expected OR source #> '{facts,editPlanDocument}' IS DISTINCT FROM (derivation #>> '{sourceEditPlanSnapshot,contentJson}')::jsonb
   OR (source #> '{facts,renderablePlanDocument}') IS DISTINCT FROM (CASE WHEN kernel->'sourceRenderablePlanSnapshot'='null'::jsonb THEN 'null'::jsonb ELSE (kernel #>> '{sourceRenderablePlanSnapshot,planJson}')::jsonb END) THEN
   RAISE EXCEPTION 'W66v2 source Version/plan facts mismatch' USING ERRCODE='23514'; END IF;
  IF jsonb_array_length(derivation->'sourceReferences')<>(SELECT count(*) FROM project_media_assets WHERE "projectId"=src.id AND "workspaceId"=src."workspaceId")
   OR jsonb_array_length(derivation->'sourceReferences')<>(SELECT count(*) FROM project_media_assets WHERE "projectId"=p.id AND "workspaceId"=p."workspaceId")
   OR jsonb_array_length(derivation->'sourceReferences')<>(SELECT count(DISTINCT x->>'sourceLinkId') FROM jsonb_array_elements(derivation->'sourceReferences') x)
   OR jsonb_array_length(derivation->'sourceReferences')<>(SELECT count(DISTINCT x->>'targetLinkId') FROM jsonb_array_elements(derivation->'sourceReferences') x) THEN
   RAISE EXCEPTION 'W66v2 media-link complete bijection mismatch' USING ERRCODE='23514'; END IF;
  -- Every typed media reference, including separate speech audio, requires
  -- its own actual link/manifest/current-rights fact. sources[] is not exhaustive.
  IF EXISTS(WITH plans AS (
    SELECT kernel #> '{source,facts,editPlanDocument}' AS plan
    UNION ALL SELECT kernel #> '{source,facts,renderablePlanDocument}'
   ), referenced AS (
    SELECT x->>'artifactId' AS id FROM plans,LATERAL jsonb_array_elements(coalesce(plan->'sources','[]'::jsonb)) x
    UNION SELECT clip->>'sourceArtifactId' FROM plans,LATERAL jsonb_array_elements(coalesce(plan->'videoTracks','[]'::jsonb)) track,LATERAL jsonb_array_elements(track->'clips') clip
    UNION SELECT clip->>'audioSourceArtifactId' FROM plans,LATERAL jsonb_array_elements(coalesce(plan->'videoTracks','[]'::jsonb)) track,LATERAL jsonb_array_elements(track->'clips') clip WHERE clip ? 'audioSourceArtifactId'
    UNION SELECT x->>'artifactId' FROM plans,LATERAL jsonb_array_elements(coalesce(plan->'audioTracks','[]'::jsonb)) x WHERE x ? 'artifactId'
   ) SELECT 1 FROM referenced WHERE id IS NULL OR NOT EXISTS(
    SELECT 1 FROM jsonb_array_elements(derivation->'sourceReferences') fact WHERE fact->>'artifactId'=referenced.id)) THEN
   RAISE EXCEPTION 'W66v2 referenced media artifact facts incomplete' USING ERRCODE='23514'; END IF;
  FOR item IN SELECT x FROM jsonb_array_elements(derivation->'sourceReferences') x LOOP
   IF item->>'purpose' IS DISTINCT FROM (CASE WHEN item->>'role'='selected-insert' THEN 'editorial-reuse' ELSE 'editing' END)
    OR item->>'sourceLinkId'=item->>'targetLinkId' OR item->>'workspaceId'<>src."workspaceId" OR item->>'sourceProjectId'<>src.id
    OR NOT EXISTS(SELECT 1 FROM project_media_assets l JOIN media_artifacts a ON a.id=l."artifactId" AND a."workspaceId"=l."workspaceId"
     WHERE l.id=(item->>'sourceLinkId')::uuid AND l."projectId"=src.id AND l."workspaceId"=src."workspaceId" AND l.role=item->>'role'
      AND l."artifactId"=item->>'artifactId' AND l."originalFileName"=item->>'originalFileName' AND w66_v2_iso(l."createdAt")=item->>'sourceLinkCreatedAt'
      AND a."artifactKey"=item->>'artifactKey' AND a.sha256=item->>'artifactSha256' AND a."byteSize"::text=item->>'artifactByteSize' AND a."mediaType"=item->>'artifactMediaType'
      AND a.container=item->>'artifactContainer' AND a.status='available' AND a."lifecycleRevision"=(item->>'artifactLifecycleRevision')::integer)
    OR NOT EXISTS(SELECT 1 FROM media_artifact_manifests mf WHERE mf.id=item #>> '{manifestFacts,id}' AND mf."artifactId"=item->>'artifactId' AND mf."workspaceId"=src."workspaceId"
     AND item->'manifestFacts' IS NOT DISTINCT FROM w66_fork_manifest_facts_v2(mf.id,mf."workspaceId")
     AND mf."manifestJson"::jsonb #>> '{artifact,artifactKey}'=item->>'artifactKey'
     AND mf."manifestJson"::jsonb->>'schemaVersion'=mf."schemaVersion" AND mf."manifestJson"::jsonb->>'manifestHash'=mf."manifestHash"
     AND mf."manifestJson"::jsonb #>> '{recipe,id}'=mf."recipeId" AND mf."manifestJson"::jsonb #>> '{recipe,version}'=mf."recipeVersion"
     AND mf."manifestJson"::jsonb #>> '{recipe,parametersHash}'=mf."parametersHash"
     AND ((mf."schemaVersion" IN ('media-artifact-manifest/v3','media-artifact-manifest/v4') AND
      mf."recipeParametersRef"=mf."manifestJson"::jsonb #>> '{recipe,parametersRef}' AND mf."recipeParametersRef"='recipe-parameters/sha256/'||mf."parametersHash"
      AND EXISTS(SELECT 1 FROM recipe_parameter_payloads rp WHERE rp.ref=mf."recipeParametersRef" AND rp."workspaceId"=mf."workspaceId" AND rp."parametersHash"=mf."parametersHash"
       AND rp."canonicalByteSize">0 AND rp."canonicalByteSize"<=1048576 AND rp.algorithm='aes-256-gcm' AND rp."keyId" ~ '^[a-z0-9][a-z0-9._-]{0,63}$'
       AND rp.nonce ~ '^[A-Za-z0-9_-]{16}$' AND rp."authTag" ~ '^[A-Za-z0-9_-]{22}$' AND length(rp.ciphertext)>0)) OR
      (mf."schemaVersion" NOT IN ('media-artifact-manifest/v3','media-artifact-manifest/v4') AND mf."recipeParametersRef" IS NULL))
     AND ((mf."schemaVersion"='media-artifact-manifest/v4' AND mf."renderInputRef"=mf."manifestJson"::jsonb #>> '{renderInput,ref}'
      AND mf."renderInputHash"=mf."manifestJson"::jsonb #>> '{renderInput,inputHash}' AND mf."renderInputRef"='render-input/sha256/'||mf."renderInputHash"
      AND EXISTS(SELECT 1 FROM render_input_payloads ri WHERE ri.ref=mf."renderInputRef" AND ri."workspaceId"=mf."workspaceId" AND ri."inputHash"=mf."renderInputHash"
       AND ri."canonicalByteSize">0 AND ri."canonicalByteSize"<=4194304 AND ri.algorithm='aes-256-gcm' AND ri."keyId" ~ '^[a-z0-9][a-z0-9._-]{0,63}$'
       AND ri.nonce ~ '^[A-Za-z0-9_-]{16}$' AND ri."authTag" ~ '^[A-Za-z0-9_-]{22}$' AND length(ri.ciphertext)>0)) OR
      (mf."schemaVersion"<>'media-artifact-manifest/v4' AND mf."renderInputRef" IS NULL AND mf."renderInputHash" IS NULL))
     AND mf."manifestJson"::jsonb #>> '{artifact,sha256}'=item->>'artifactSha256' AND mf."manifestJson"::jsonb #>> '{artifact,byteSize}'=item->>'artifactByteSize')
    OR NOT EXISTS(SELECT 1 FROM project_media_assets l WHERE l.id=(item->>'targetLinkId')::uuid AND l."projectId"=p.id AND l."workspaceId"=p."workspaceId"
      AND l."artifactId"=item->>'artifactId' AND l.role=item->>'role' AND l."originalFileName"=item->>'originalFileName' AND l."uploadId" IS NULL AND l."createdAt"=c."createdAt") THEN
    RAISE EXCEPTION 'W66v2 actual media source/target link facts mismatch' USING ERRCODE='23514'; END IF;
  END LOOP;
  source_ids := jsonb_build_array(jsonb_build_object('kind','version','id',sv.id),jsonb_build_object('kind','state','id',ss.id));
  FOR r IN SELECT * FROM project_snapshots WHERE id IN(sv."briefSnapshotId",sv."policiesSnapshotId",sv."editPlanSnapshotId",sv."treatmentSnapshotId",sv."storySnapshotId") LOOP
   item:=jsonb_build_object('schemaVersion',1,'id',r.id,'workspaceId',r."workspaceId",'projectId',r."projectId",'kind',r.kind,'contentSchemaVersion',r."schemaVersion",
    'contentJson',r."contentJson",'contentHash',r."contentHash",'createdAt',w66_v2_iso(r."createdAt"));
   IF r."projectId"<>src.id OR r."workspaceId"<>p."workspaceId" OR r."contentHash"<>w66_v2_sha(r."contentJson") OR
    (CASE WHEN r.kind='edit-plan' THEN derivation->'sourceEditPlanSnapshot' ELSE source #> ARRAY['nonOutputSnapshotFacts',r.kind] END) IS DISTINCT FROM item THEN
    RAISE EXCEPTION 'W66v2 actual source snapshot facts mismatch' USING ERRCODE='23514'; END IF;
   source_ids:=source_ids||jsonb_build_array(jsonb_build_object('kind','snapshot','id',r.id));
   SELECT x INTO STRICT item FROM jsonb_array_elements(payload->'snapshots') x WHERE x->>'kind'=r.kind;
   IF item->>'id' IS DISTINCT FROM w66_fork_id_v2(map,'snapshot',r.id) THEN RAISE EXCEPTION 'W66v2 snapshot bijection mismatch' USING ERRCODE='23514'; END IF;
   source_plan:=r."contentJson"::jsonb;
   IF r.kind='edit-plan' THEN
    source_row:=jsonb_build_object('id',r.id,'projectVersionId',sv.id,'planHash',r."contentHash");
    ref:=jsonb_build_object('canonicalPolicyVersion','output-canonical-json/v1','schemaVersion','project-fork-derivation-ref/v2','id',d.id,'hash',d."derivationHash",'compilePolicyVersion',kernel->>'compilePolicyVersion');
    expected_plan:=w66_fork_plan_v2(source_plan,map,target,ref,source_row,false);
    SELECT source_ids||coalesce(jsonb_agg(jsonb_build_object('kind',members.kind,'id',members.id)),'[]') INTO source_ids FROM w66_fork_plan_members_v2(source_plan,false) members;
   ELSE
    expected_plan:=source_plan;
    IF source_plan ? 'projectId' THEN expected_plan:=expected_plan||jsonb_build_object('projectId',p.id); END IF;
    IF source_plan ? 'projectVersionId' THEN expected_plan:=expected_plan||jsonb_build_object('projectVersionId',v.id); END IF;
   END IF;
   IF (item->>'contentJson')::jsonb IS DISTINCT FROM expected_plan THEN RAISE EXCEPTION 'W66v2 typed snapshot remap mismatch' USING ERRCODE='23514'; END IF;
  END LOOP;
  FOR source_item IN SELECT x FROM jsonb_array_elements(ss."stateJson"::jsonb->'entries') x LOOP
   source_ids:=source_ids||jsonb_build_array(jsonb_build_object('kind','variant','id',source_item->>'variantId'),jsonb_build_object('kind','revision','id',source_item->>'outputSpecRevisionId'));
  END LOOP;
  FOR source_item IN SELECT x FROM jsonb_array_elements(ss."stateJson"::jsonb->'overlays') x LOOP
   source_ids:=source_ids||jsonb_build_array(jsonb_build_object('kind','overlay','id',source_item->>'id'));
  END LOOP;
  FOR source_item IN SELECT x FROM jsonb_array_elements(ss."stateJson"::jsonb->'invalidations') x LOOP
   source_ids:=source_ids||jsonb_build_array(jsonb_build_object('kind','invalidation','id',source_item->>'id'));
  END LOOP;
  source_row:=kernel->'sourceRenderablePlanSnapshot';
  IF source_row IS DISTINCT FROM 'null'::jsonb THEN
   IF source_row->>'id' IS DISTINCT FROM ss."renderablePlanSnapshotId" OR source_row->>'planHash' IS DISTINCT FROM ss."renderablePlanHash" THEN
    RAISE EXCEPTION 'W66v2 Renderable source State anchor mismatch' USING ERRCODE='23514'; END IF;
   IF NOT EXISTS(SELECT 1 FROM renderable_plan_snapshots rs WHERE rs.id=source_row->>'id' AND rs."workspaceId"=src."workspaceId" AND rs."projectId"=src.id AND rs."projectVersionId"=sv.id
    AND source_row IS NOT DISTINCT FROM jsonb_build_object('id',rs.id,'workspaceId',rs."workspaceId",'projectId',rs."projectId",'projectVersionId',rs."projectVersionId",'planId',rs."planId",'origin',rs.origin,
     'sourceId',rs."sourceId",'sourceHash',rs."sourceHash",'sourceVersion',rs."sourceVersion",'fps',rs.fps,'durationFrames',rs."durationFrames",'clipCount',rs."clipCount",'planJson',rs."planJson",'planHash',rs."planHash",'createdAt',w66_v2_iso(rs."createdAt"))) THEN
    RAISE EXCEPTION 'W66v2 actual Renderable snapshot facts mismatch' USING ERRCODE='23514'; END IF;
   source_plan:=(source_row->>'planJson')::jsonb;
   SELECT source_ids||coalesce(jsonb_agg(jsonb_build_object('kind',members.kind,'id',members.id)),'[]') INTO source_ids FROM w66_fork_plan_members_v2(source_plan,true) members;
   source_ids:=source_ids||jsonb_build_array(jsonb_build_object('kind','renderable-snapshot','id',source_row->>'id'));
   SELECT * INTO STRICT candidate FROM project_fork_renderable_candidates WHERE id=s."forkRenderableCandidateId" AND "projectVersionId"=v.id AND "projectId"=p.id AND "workspaceId"=p."workspaceId";
   item:=candidate."candidateJson"::jsonb;
   expected_plan:=w66_fork_plan_v2(source_plan,map,target,ref,source_row,true);
   audio:=item->'audioAuthority';
   SELECT jsonb_build_object('schemaVersion','editorial-audio-timeline/v1','fps',((audio->>'sourceSpeechCanonicalJson')::jsonb->'fps'),'segments',jsonb_agg(jsonb_build_object(
    'artifactId',coalesce(clip->>'audioSourceArtifactId',clip->>'sourceArtifactId'),'audioSourceInFrame',coalesce(clip->'audioSourceInFrame',clip->'sourceInFrame'),
    'audioSourceOutFrame',coalesce(clip->'audioSourceOutFrame',clip->'sourceOutFrame'),'timelineInFrame',clip->'timelineInFrame','timelineOutFrame',clip->'timelineOutFrame','rate',clip->'rate') ORDER BY ordinal))
   INTO speech_body FROM jsonb_array_elements(source_plan->'videoTracks') track,LATERAL jsonb_array_elements(track->'clips') WITH ORDINALITY AS clips(clip,ordinal) WHERE track->>'kind'='base-video';
   IF NOT w66_v2_exact_json(audio,ARRAY['schemaVersion','sourceSpeechCanonicalJson','sourceSpeechHash','sourceMixedCanonicalJson','targetMixedCanonicalJson'])
    OR audio->>'schemaVersion' IS DISTINCT FROM 'fork-audio-projection/v1' OR (audio->>'sourceSpeechCanonicalJson')::jsonb IS DISTINCT FROM speech_body
    OR w66_v2_sha(audio->>'sourceSpeechCanonicalJson') IS DISTINCT FROM audio->>'sourceSpeechHash' THEN
    RAISE EXCEPTION 'W66v2 audio speech projection/source text mismatch' USING ERRCODE='23514'; END IF;
   IF source_plan->'audioTracks'='[]'::jsonb THEN
    IF audio->'sourceMixedCanonicalJson' IS DISTINCT FROM 'null'::jsonb OR audio->'targetMixedCanonicalJson' IS DISTINCT FROM 'null'::jsonb
     OR audio->>'sourceSpeechHash' IS DISTINCT FROM source_plan->>'audioTimelineHash' THEN RAISE EXCEPTION 'W66v2 audio no-music source anchor mismatch' USING ERRCODE='23514'; END IF;
    expected_plan:=expected_plan||jsonb_build_object('audioTimelineHash',audio->>'sourceSpeechHash');
   ELSE
    IF w66_v2_sha(audio->>'sourceMixedCanonicalJson') IS DISTINCT FROM source_plan->>'audioTimelineHash'
     OR (audio->>'sourceMixedCanonicalJson')::jsonb IS DISTINCT FROM jsonb_build_object('schemaVersion','directed-audio-timeline/v1','speechHash',audio->>'sourceSpeechHash','musicTracks',source_plan->'audioTracks')
     OR audio->>'targetMixedCanonicalJson' IS DISTINCT FROM w66_v2_rebind_audio_text(audio->>'sourceMixedCanonicalJson',map) THEN
     RAISE EXCEPTION 'W66v2 pinned audio source/mapped text mismatch' USING ERRCODE='23514'; END IF;
    expected_plan:=expected_plan||jsonb_build_object('audioTimelineHash',w66_v2_sha(audio->>'targetMixedCanonicalJson'));
   END IF;
   IF (item->>'planJson')::jsonb IS DISTINCT FROM expected_plan
    OR item IS DISTINCT FROM payload->'renderableCandidate' OR candidate.id IS DISTINCT FROM w66_fork_id_v2(map,'renderable-snapshot',source_row->>'id')
    OR candidate."derivationId"<>d.id OR candidate."derivationHash"<>d."derivationHash" OR candidate."planId" IS DISTINCT FROM expected_plan->>'id'
    OR candidate."planHash" IS DISTINCT FROM item->>'planHash' OR candidate."planHashJson" IS DISTINCT FROM item->>'planHashJson'
    OR candidate."planHashJson"::jsonb IS DISTINCT FROM jsonb_build_object('canonicalPolicyVersion','output-canonical-json/v1','schemaVersion','project-fork-renderable-plan-hash/v2','compilePolicyVersion',kernel->>'compilePolicyVersion','plan',expected_plan) OR item->>'projectVersionId' IS DISTINCT FROM v.id OR candidate."createdAt"<>c."createdAt"
    OR b->'renderablePlan' IS DISTINCT FROM jsonb_build_object('status','blocked','candidateId',candidate.id,'planId',candidate."planId",'planHash',candidate."planHash",'derivationId',d.id,'derivationHash',d."derivationHash",'reason','fork-target-materialization-required') THEN
    RAISE EXCEPTION 'W66v2 candidate typed content or reciprocal State mismatch' USING ERRCODE='23514'; END IF;
  ELSE
   IF s."forkRenderableCandidateId" IS NOT NULL OR b->'renderablePlan' IS DISTINCT FROM 'null'::jsonb OR payload->'renderableCandidate' IS DISTINCT FROM 'null'::jsonb THEN
    RAISE EXCEPTION 'W66v2 fabricated target Renderable candidate' USING ERRCODE='23514'; END IF;
  END IF;
  SELECT coalesce(jsonb_agg(DISTINCT x),'[]') INTO source_ids FROM jsonb_array_elements(source_ids) x;
  SELECT coalesce(jsonb_agg(jsonb_build_object('kind',x->>'kind','id',x->>'sourceId')),'[]') INTO mapped_ids FROM jsonb_array_elements(map) x;
  IF jsonb_array_length(source_ids)<>jsonb_array_length(map) OR NOT source_ids @> mapped_ids OR NOT mapped_ids @> source_ids
   OR (SELECT count(DISTINCT x->>'targetId') FROM jsonb_array_elements(map) x)<>jsonb_array_length(map)
   OR EXISTS(SELECT 1 FROM jsonb_array_elements(map) x WHERE NOT x ?& ARRAY['kind','sourceId','targetId'] OR
    x->>'targetId'=x->>'sourceId' OR EXISTS(SELECT 1 FROM jsonb_array_elements(source_ids) a WHERE a->>'id'=x->>'targetId'))
   OR w66_fork_id_v2(map,'version',sv.id)<>v.id OR w66_fork_id_v2(map,'state',ss.id)<>s.id THEN
   RAISE EXCEPTION 'W66v2 complete typed bijection mismatch' USING ERRCODE='23514'; END IF;
  IF jsonb_array_length(b->'entries')<>jsonb_array_length(ss."stateJson"::jsonb->'entries')
   OR jsonb_array_length(b->'overlays')<>jsonb_array_length(ss."stateJson"::jsonb->'overlays')
   OR jsonb_array_length(kernel->'cropDecisions')<>jsonb_array_length(ss."stateJson"::jsonb->'overlays')
   OR jsonb_array_length(b->'invalidations')<>jsonb_array_length(ss."stateJson"::jsonb->'invalidations') THEN
   RAISE EXCEPTION 'W66v2 fork lost source member or intent lineage' USING ERRCODE='23514'; END IF;
  SELECT jsonb_agg(x ORDER BY (x->>'kind') COLLATE "C",(x->>'id') COLLATE "C") INTO source_ids FROM jsonb_array_elements(source_ids) x;
  SELECT coalesce(jsonb_agg(jsonb_build_object('kind',x->>'kind','id',x->>'id','hash',x->>'contentHash')),'[]') INTO expected
   FROM jsonb_array_elements(jsonb_build_array(source #> '{nonOutputSnapshotFacts,brief}',source #> '{nonOutputSnapshotFacts,policies}',
    source #> '{nonOutputSnapshotFacts,treatment}',source #> '{nonOutputSnapshotFacts,story}',derivation->'sourceEditPlanSnapshot')) x WHERE x<>'null'::jsonb;
  expected:=jsonb_build_object('workspaceId',src."workspaceId",'projectId',src.id,'versionId',sv.id,'baseHash',sv."baseHash",'stateId',ss.id,'stateHash',ss."stateHash",
   'snapshots',expected,'renderablePlanSnapshot',source_row,'ownedIdentities',source_ids,'sourceProject',derivation->'sourceProject',
   'sourceReferences',(SELECT coalesce(jsonb_agg(x-'targetLinkId'),'[]') FROM jsonb_array_elements(derivation->'sourceReferences') x));
  IF c."requestJson"::jsonb IS DISTINCT FROM jsonb_build_object('canonicalPolicyVersion','output-canonical-json/v1','schemaVersion','project-creation-output-request/v2',
   'workspaceId',c."workspaceId",'callerIntent',payload->'callerIntent','actorContextHash',c."actorContextHash",'sourceBaseline',expected) THEN
   RAISE EXCEPTION 'W66v2 fork request fingerprint actual source baseline mismatch' USING ERRCODE='23514'; END IF;
  IF b->'sourceDependencies' IS DISTINCT FROM jsonb_build_object('status','blocked-source-lineage-only','sourceProjectId',src.id,'sourceVersionId',sv.id,'policy','no-target-transcript-or-perception-authority/v1')
   OR b->'consumption' IS DISTINCT FROM '{"status":"blocked","reasons":["fork-target-materialization-required"]}'::jsonb THEN
   RAISE EXCEPTION 'W66v2 fork cannot inherit acceptance or materialization' USING ERRCODE='23514'; END IF;
 END IF;
 -- Physical members must exactly equal the sealed State, including no extras.
 IF (SELECT count(*) FROM project_output_state_entries WHERE "stateId"=s.id)<>jsonb_array_length(b->'entries')
  OR (SELECT count(*) FROM output_variants WHERE "projectId"=p.id AND "workspaceId"=p."workspaceId")<>jsonb_array_length(b->'entries')
  OR (SELECT count(*) FROM output_spec_revisions WHERE "projectId"=p.id AND "workspaceId"=p."workspaceId")<>jsonb_array_length(b->'entries') THEN
  RAISE EXCEPTION 'W66v2 entry membership mismatch' USING ERRCODE='23514'; END IF;
 FOR item IN SELECT x FROM jsonb_array_elements(b->'entries') x LOOP
  SELECT * INTO STRICT member FROM project_output_state_entries WHERE "stateId"=s.id AND "variantId"=item->>'variantId';
  SELECT * INTO STRICT revision FROM output_spec_revisions WHERE id=member."outputSpecRevisionId";
  IF member."canonicalPolicyVersion" IS DISTINCT FROM 'output-canonical-json/v1'
   OR member."entryJson"::jsonb->>'canonicalPolicyVersion' IS DISTINCT FROM member."canonicalPolicyVersion"
   OR revision."canonicalPolicyVersion" IS DISTINCT FROM 'output-canonical-json/v1'
   OR revision."specJson"::jsonb->>'canonicalPolicyVersion' IS DISTINCT FROM revision."canonicalPolicyVersion" THEN
   RAISE EXCEPTION 'W66v2 entry/revision canonical policy binding mismatch' USING ERRCODE='23514'; END IF;
  IF member."entryJson"::jsonb IS DISTINCT FROM item OR member."entryHash"<>w66_v2_sha(member."entryJson") OR member."geometryStatus"<>'blocked-v2' OR member."geometryProjectionHash" IS NOT NULL
   OR member."projectId"<>s."projectId" OR member."workspaceId"<>s."workspaceId" OR member."specHash"<>item->>'specHash' OR member."outputSpecRevisionId"<>item->>'outputSpecRevisionId'
   OR revision."specJson"::jsonb IS DISTINCT FROM item->'spec' OR revision."specHash"<>member."specHash" OR revision."specHash"<>w66_v2_sha(revision."specJson")
   OR revision."createdCommandKind"<>'creation-command-v2' OR revision."createdCommandId"<>c.id OR revision."createdCommandHash"<>c."commandHash" OR revision."createdAt"<>c."createdAt"
   OR revision."schemaVersion"<>'output-spec-revision/v2' OR revision."revisionNumber"<>1 OR revision."variantId"<>member."variantId"
   OR item->'consumption' IS DISTINCT FROM '{"status":"blocked","reason":"fork-target-geometry-unmaterialized"}'::jsonb THEN
   RAISE EXCEPTION 'W66v2 entry/revision consumption or seal mismatch' USING ERRCODE='23514'; END IF;
  SELECT x INTO STRICT source_item FROM jsonb_array_elements(ss."stateJson"::jsonb->'entries') x WHERE w66_fork_id_v2(map,'variant',x->>'variantId')=member."variantId";
  expected:=jsonb_build_object('canonicalPolicyVersion','output-canonical-json/v1','schemaVersion','output-spec-revision/v2','id',revision.id,'variantId',revision."variantId",
   'workspaceId',s."workspaceId",'projectId',s."projectId",'revisionNumber',1,'createdAt',w66_v2_iso(c."createdAt"),'source',jsonb_build_object('projectId',ss."projectId",'variantId',source_item->>'variantId',
    'revisionId',source_item->>'outputSpecRevisionId','specHash',source_item->>'specHash'),'effectiveSpec',(source_item->'spec')||jsonb_build_object('id',revision.id,'variantId',revision."variantId",'workspaceId',s."workspaceId",'projectId',s."projectId",'revisionNumber',1,'createdAt',w66_v2_iso(c."createdAt"),
    'output',(source_item #> '{spec,output}')||jsonb_build_object('id',revision."variantId")),'consumption',item->'consumption');
  IF item->'spec' IS DISTINCT FROM expected OR revision.id<>w66_fork_id_v2(map,'revision',source_item->>'outputSpecRevisionId') OR NOT EXISTS(
   SELECT 1 FROM output_variants ov WHERE ov.id=member."variantId" AND ov."projectId"=s."projectId" AND ov."workspaceId"=s."workspaceId"
    AND ov."createdCommandKind"='creation-command-v2' AND ov."createdCommandId"=c.id AND ov."createdCommandHash"=c."commandHash" AND ov."createdAt"=c."createdAt") THEN
   RAISE EXCEPTION 'W66v2 output revision source/effective spec mismatch' USING ERRCODE='23514'; END IF;
 END LOOP;
 IF (SELECT count(*) FROM project_fork_crop_decisions WHERE "stateId"=s.id)<>jsonb_array_length(b->'overlays')
  OR (SELECT count(*) FROM project_fork_invalidation_lineage WHERE "stateId"=s.id)<>jsonb_array_length(b->'invalidations') THEN
  RAISE EXCEPTION 'W66v2 inactive lineage membership mismatch' USING ERRCODE='23514'; END IF;
 FOR item IN SELECT x FROM jsonb_array_elements(b->'overlays') x LOOP
  SELECT x INTO STRICT source_item FROM jsonb_array_elements(kernel->'cropDecisions') x WHERE x->>'newOverlayId'=item->>'id';
  IF source_item->>'newOverlayId' IS DISTINCT FROM w66_fork_id_v2(map,'overlay',source_item->>'sourceOverlayId')
   OR source_item->>'newVariantId' IS DISTINCT FROM w66_fork_id_v2(map,'variant',(SELECT x->>'variantId' FROM jsonb_array_elements(ss."stateJson"::jsonb->'overlays') x WHERE x->>'id'=source_item->>'sourceOverlayId'))
   OR source_item->>'newClipId' IS DISTINCT FROM w66_fork_id_v2(map,'clip',(SELECT x->>'clipId' FROM jsonb_array_elements(ss."stateJson"::jsonb->'overlays') x WHERE x->>'id'=source_item->>'sourceOverlayId'))
   OR source_item->'author' IS DISTINCT FROM command->'author' OR source_item->>'createdAt' IS DISTINCT FROM w66_v2_iso(c."createdAt")
   OR source_item->>'geometryStatus' IS DISTINCT FROM 'requires-target-materialization'
   OR NOT EXISTS(SELECT 1 FROM project_output_state_overlays o WHERE o."stateId"=ss.id AND o.id=source_item->>'sourceOverlayId'
    AND o."overlayHash"=source_item->>'sourceOverlayHash' AND o."overlayJson"::jsonb->'document'=source_item->'copiedDocument') THEN
   RAISE EXCEPTION 'W66v2 crop source/map/new audit facts mismatch' USING ERRCODE='23514'; END IF;
  expected:=jsonb_build_object('id',source_item->>'newOverlayId','variantId',source_item->>'newVariantId','clipId',source_item->>'newClipId','status','inactive-requires-target-materialization',
   'sourceOverlayId',source_item->>'sourceOverlayId','sourceOverlayHash',source_item->>'sourceOverlayHash','author',command->'author','audit',actor,'createdAt',w66_v2_iso(c."createdAt"),'document',source_item->'copiedDocument');
  IF item IS DISTINCT FROM expected OR NOT EXISTS(SELECT 1 FROM project_fork_crop_decisions x WHERE x.id=item->>'id' AND x."stateId"=s.id AND x."projectId"=s."projectId" AND x."workspaceId"=s."workspaceId"
   AND x."creationCommandId"=c.id AND x."variantId"=item->>'variantId' AND x."clipId"=item->>'clipId' AND x."decisionJson"::jsonb=item
   AND x."sourceOverlayId"=item->>'sourceOverlayId' AND x."sourceOverlayHash"=item->>'sourceOverlayHash' AND x.status=item->>'status' AND x."createdAt"=c."createdAt") THEN
   RAISE EXCEPTION 'W66v2 inactive crop audit lineage mismatch' USING ERRCODE='23514'; END IF;
 END LOOP;
 FOR item IN SELECT x FROM jsonb_array_elements(b->'invalidations') x LOOP
  IF item->>'id' IS DISTINCT FROM w66_fork_id_v2(map,'invalidation',item->>'sourceId')
   OR NOT EXISTS(SELECT 1 FROM project_output_state_invalidations i WHERE i."stateId"=ss.id AND i.id=item->>'sourceId' AND i."invalidationHash"=item->>'sourceHash'
    AND w66_fork_id_v2(map,'variant',i."variantId")=item->>'variantId' AND i.kind=item->>'kind')
   OR item->>'status' IS DISTINCT FROM 'source-lineage-only' OR NOT EXISTS(SELECT 1 FROM project_fork_invalidation_lineage x WHERE x.id=item->>'id' AND x."stateId"=s.id
   AND x."projectId"=s."projectId" AND x."workspaceId"=s."workspaceId" AND x."lineageJson"::jsonb=item AND x."variantId"=item->>'variantId'
   AND x."sourceId"=item->>'sourceId' AND x."sourceHash"=item->>'sourceHash') THEN RAISE EXCEPTION 'W66v2 invalidation lineage mismatch' USING ERRCODE='23514'; END IF;
 END LOOP;
END $$;

-- The v1 trigger FUNCTION is unchanged. Explicit WHEN dispatches exclude v2
-- rows; v2 gets a separate validator on every participating surface.
DO $$ DECLARE t text; gate text; BEGIN
 FOREACH t IN ARRAY ARRAY['output_variants','output_spec_revisions','project_output_states','project_versions','project_output_state_entries'] LOOP
  gate:=CASE t WHEN 'output_variants' THEN 'NEW."createdCommandKind" IS DISTINCT FROM ''creation-command-v2'''
   WHEN 'output_spec_revisions' THEN 'NEW."schemaVersion" IS DISTINCT FROM ''output-spec-revision/v2'''
   WHEN 'project_output_states' THEN 'NEW."schemaVersion" IS DISTINCT FROM ''project-output-state/v2'''
   WHEN 'project_versions' THEN 'NEW."outputContractVersion" IS DISTINCT FROM 2'
   ELSE 'NEW."geometryStatus" IS DISTINCT FROM ''blocked-v2''' END;
  EXECUTE format('DROP TRIGGER %I ON %I',t||'_w66_commit_check',t);
  EXECUTE format('CREATE CONSTRAINT TRIGGER %I AFTER INSERT ON %I DEFERRABLE INITIALLY DEFERRED FOR EACH ROW WHEN (%s) EXECUTE FUNCTION w66_output_deferred_check()',t||'_w66_commit_check',t,gate);
 END LOOP;
END $$;
CREATE FUNCTION w66_renderable_dispatch_v2() RETURNS trigger LANGUAGE plpgsql AS $$
DECLARE version project_versions%ROWTYPE; BEGIN
 SELECT * INTO STRICT version FROM project_versions WHERE id=NEW."projectVersionId";
 IF version."outputContractVersion"=2 THEN
  RAISE EXCEPTION 'W66v2 Creation renderable is a blocked candidate, not a factual rendered plan' USING ERRCODE='23514'; END IF;
 IF version."outputContractVersion" IS DISTINCT FROM 1 OR NOT EXISTS(SELECT 1 FROM project_output_states s WHERE s.id=version."outputStateId"
  AND s."renderablePlanSnapshotId"=NEW.id AND s."renderablePlanId"=NEW."planId" AND s."renderablePlanHash"=NEW."planHash") THEN
  RAISE EXCEPTION 'W66 new renderable snapshot lacks reciprocal state binding' USING ERRCODE='23514'; END IF;
 PERFORM w66_assert_output_state(version."outputStateId"); RETURN NULL;
END $$;
DROP TRIGGER renderable_plan_snapshots_w66_commit_check ON renderable_plan_snapshots;
CREATE CONSTRAINT TRIGGER renderable_plan_snapshots_w66_commit_check AFTER INSERT ON renderable_plan_snapshots
 DEFERRABLE INITIALLY DEFERRED FOR EACH ROW EXECUTE FUNCTION w66_renderable_dispatch_v2();
CREATE FUNCTION w66_creation_bundle_deferred_v2() RETURNS trigger LANGUAGE plpgsql AS $$
DECLARE state_id text; contract integer; final_project projects%ROWTYPE; BEGIN
 CASE TG_TABLE_NAME
 WHEN 'project_output_states' THEN IF NEW."schemaVersion"<>'project-output-state/v2' THEN RETURN NULL; END IF; state_id:=NEW.id;
 WHEN 'project_versions' THEN IF NEW."outputContractVersion"<>2 THEN RETURN NULL; END IF; state_id:=NEW."outputStateId";
 WHEN 'project_creation_commands' THEN IF NEW."schemaVersion"<>2 THEN RETURN NULL; END IF;
  SELECT s.id INTO STRICT state_id FROM project_output_states s WHERE s."creationCommandV2Id"=NEW.id;
 WHEN 'output_variants' THEN IF NEW."createdCommandKind"<>'creation-command-v2' THEN RETURN NULL; END IF;
  SELECT s.id INTO STRICT state_id FROM project_output_states s WHERE s."creationCommandV2Id"=NEW."createdCommandId";
 WHEN 'output_spec_revisions' THEN IF NEW."schemaVersion"<>'output-spec-revision/v2' THEN RETURN NULL; END IF;
  SELECT s.id INTO STRICT state_id FROM project_output_states s WHERE s."creationCommandV2Id"=NEW."createdCommandId";
 WHEN 'project_output_state_entries' THEN IF NEW."geometryStatus"<>'blocked-v2' THEN RETURN NULL; END IF; state_id:=NEW."stateId";
 WHEN 'project_fork_derivations' THEN state_id:=NEW."targetStateId";
 WHEN 'project_fork_renderable_candidates' THEN SELECT v."outputStateId" INTO STRICT state_id FROM project_versions v WHERE v.id=NEW."projectVersionId";
 WHEN 'project_fork_crop_decisions','project_fork_invalidation_lineage' THEN state_id:=NEW."stateId";
 WHEN 'project_snapshots','project_media_assets','projects' THEN
  IF TG_TABLE_NAME='projects' THEN
   -- A deferred INSERT event retains its original null head. Only identity and
   -- scope locate the final row; the later head CAS must still be present.
   SELECT p.* INTO STRICT final_project FROM projects p WHERE p.id=NEW.id AND p."workspaceId"=NEW."workspaceId";
   IF final_project."creationContractVersion"<>2 THEN
    IF NEW."creationContractVersion"=2 OR EXISTS(SELECT 1 FROM project_versions v WHERE v.id=final_project."currentVersionId" AND v."outputContractVersion"=2) THEN
     RAISE EXCEPTION 'W66v2 head requires explicit Project discriminator' USING ERRCODE='23514'; END IF;
    RETURN NULL;
   END IF;
   SELECT v."outputStateId",v."outputContractVersion" INTO STRICT state_id,contract FROM project_versions v JOIN project_output_states s
    ON s.id=v."outputStateId" AND s."resultVersionId"=v.id AND s."projectId"=v."projectId" AND s."workspaceId"=v."workspaceId" AND s."stateHash"=v."outputStateHash"
    WHERE v.id=final_project."currentVersionId" AND v."projectId"=final_project.id AND v."workspaceId"=final_project."workspaceId"
     AND v."outputContractVersion"=2 AND s."schemaVersion"='project-output-state/v2';
  ELSE
   SELECT p."creationContractVersion" INTO STRICT contract FROM projects p WHERE p.id=NEW."projectId" AND p."workspaceId"=NEW."workspaceId";
   IF contract<>2 THEN RETURN NULL; END IF;
   SELECT v."outputStateId" INTO STRICT state_id FROM projects p JOIN project_versions v ON v.id=p."currentVersionId"
    WHERE p.id=NEW."projectId" AND p."workspaceId"=NEW."workspaceId";
  END IF;
 ELSE RAISE EXCEPTION 'W66v2 unsupported deferred surface' USING ERRCODE='23514';
 END CASE;
 PERFORM w66_assert_creation_bundle_v2(state_id); RETURN NULL;
EXCEPTION WHEN no_data_found THEN RAISE EXCEPTION 'W66v2 reciprocal bundle missing at COMMIT' USING ERRCODE='23514';
END $$;

CREATE FUNCTION w66_creation_project_head_v2() RETURNS trigger LANGUAGE plpgsql AS $$
DECLARE final_project projects%ROWTYPE;
BEGIN
 SELECT p.* INTO STRICT final_project FROM projects p WHERE p.id=NEW.id AND p."workspaceId"=NEW."workspaceId";
 IF final_project."creationContractVersion"=2 THEN
  IF NOT EXISTS(SELECT 1 FROM project_versions v JOIN project_output_states s
   ON s.id=v."outputStateId" AND s."stateHash"=v."outputStateHash" AND s."resultVersionId"=v.id AND s."projectId"=v."projectId" AND s."workspaceId"=v."workspaceId"
   JOIN project_creation_commands c ON c.id=s."creationCommandV2Id" AND c."projectId"=s."projectId" AND c."workspaceId"=s."workspaceId"
    AND c."versionId"=v.id AND c."commandHash"=s."provenanceHash" AND c."schemaVersion"=2
   WHERE v.id=final_project."currentVersionId" AND v."projectId"=final_project.id AND v."workspaceId"=final_project."workspaceId" AND v."outputContractVersion"=2 AND s."schemaVersion"='project-output-state/v2'
    AND s."consumptionStatus"='blocked' AND final_project."ownerId" IS NOT DISTINCT FROM c."actorClientId"
    AND ((s.transition='initialize-empty' AND final_project.format IS NULL) OR
     (s.transition='fork-with-content' AND final_project.format IS NOT DISTINCT FROM (c."payloadJson"::jsonb #>> '{forkDerivation,document,sourceProject,format}')))) THEN
   RAISE EXCEPTION 'W66v2 Project format/head/State discriminator mismatch' USING ERRCODE='23514'; END IF;
 ELSE
  IF OLD."creationContractVersion"=2 OR NEW."creationContractVersion"=2 OR EXISTS(SELECT 1 FROM project_versions v WHERE v.id=final_project."currentVersionId" AND v."outputContractVersion"=2) THEN
   RAISE EXCEPTION 'W66v2 head requires explicit Project discriminator' USING ERRCODE='23514'; END IF;
 END IF;
 RETURN NULL;
EXCEPTION WHEN no_data_found THEN RAISE EXCEPTION 'W66v2 Project format/head/State discriminator mismatch' USING ERRCODE='23514';
END $$;
DO $$ DECLARE t text; BEGIN
 FOREACH t IN ARRAY ARRAY['projects','project_versions','project_creation_commands','project_snapshots','project_media_assets','output_variants','output_spec_revisions',
  'project_output_states','project_output_state_entries','project_fork_derivations','project_fork_renderable_candidates','project_fork_crop_decisions','project_fork_invalidation_lineage'] LOOP
  EXECUTE format('CREATE CONSTRAINT TRIGGER %I AFTER INSERT ON %I DEFERRABLE INITIALLY DEFERRED FOR EACH ROW EXECUTE FUNCTION w66_creation_bundle_deferred_v2()',t||'_creation_v2_commit_check',t);
 END LOOP;
 CREATE CONSTRAINT TRIGGER projects_creation_v2_head_check AFTER UPDATE ON projects DEFERRABLE INITIALLY DEFERRED
  FOR EACH ROW WHEN (OLD."currentVersionId" IS DISTINCT FROM NEW."currentVersionId" OR OLD."creationContractVersion" IS DISTINCT FROM NEW."creationContractVersion" OR OLD.format IS DISTINCT FROM NEW.format OR OLD."ownerId" IS DISTINCT FROM NEW."ownerId")
  EXECUTE FUNCTION w66_creation_project_head_v2();
 FOREACH t IN ARRAY ARRAY['project_fork_derivations','project_fork_renderable_candidates','project_fork_crop_decisions','project_fork_invalidation_lineage'] LOOP
  EXECUTE format('CREATE TRIGGER %I BEFORE UPDATE OR DELETE ON %I FOR EACH ROW EXECUTE FUNCTION w66_output_immutable()',t||'_immutable',t);
 END LOOP;
END $$;
