-- Explicit editorial derivation, no new models/columns/client. Historical
-- functions remain byte-identical under historical names; dispatch is by
-- discriminator, never catch/fallback or conversion of source authority.
-- Payload3 has its own declared shape; its canonical policy lives in the
-- source-binding document, not an invented field on the historical Command.
-- NULL output seals remain legitimate only for historical/non-output payloads.
ALTER TABLE "edit_commands" DROP CONSTRAINT "edit_commands_output_payload_seal_check";
ALTER TABLE "edit_commands" ADD CONSTRAINT "edit_commands_output_payload_seal_check" CHECK (
  ("type" NOT IN ('create-output-variant', 'revise-output-spec') AND "outputPayloadJson" IS NULL AND "outputPayloadHash" IS NULL
    AND ("type" <> 'remove-spoken-content' OR ("payloadJson"::jsonb -> 'schemaVersion') IS DISTINCT FROM '3'::jsonb)) OR
  ("type" IN ('create-output-variant', 'revise-output-spec') AND "commandHash" IS NOT NULL AND "commandJson" IS NOT NULL
    AND "outputPayloadJson" IS NOT NULL AND "outputPayloadHash" IS NOT NULL AND "outputPayloadHash" ~ '^[a-f0-9]{64}$'
    AND "outputPayloadHash" = encode(sha256(convert_to("outputPayloadJson", 'UTF8')), 'hex')
    AND ("outputPayloadJson"::jsonb ->> 'canonicalPolicyVersion') IS NOT DISTINCT FROM 'output-canonical-json/v1'
    AND ("commandJson"::jsonb -> 'payload') IS NOT DISTINCT FROM "outputPayloadJson"::jsonb) OR
  COALESCE(("type" = 'remove-spoken-content' AND ("payloadJson"::jsonb -> 'schemaVersion') IS NOT DISTINCT FROM '3'::jsonb
    AND "commandHash" IS NOT NULL AND "commandJson" IS NOT NULL AND "commandHash" ~ '^[a-f0-9]{64}$'
    AND "commandHash" = w66_v2_sha("commandJson")
    AND "outputPayloadJson" IS NOT NULL AND "outputPayloadHash" IS NOT NULL AND "outputPayloadHash" ~ '^[a-f0-9]{64}$'
    AND "outputPayloadHash" = w66_v2_sha("outputPayloadJson")
    AND "outputPayloadJson"::jsonb IS NOT DISTINCT FROM "payloadJson"::jsonb
    AND ("commandJson"::jsonb -> 'payload') IS NOT DISTINCT FROM "outputPayloadJson"::jsonb
    AND w66_v2_exact_json("outputPayloadJson"::jsonb,ARRAY['schemaVersion','sourceTranscriptId','sourceArtifactId','variantId','rules','exclusions','sourceBinding','editPlanHash','audioProjection','impact'] ||
      CASE WHEN "outputPayloadJson"::jsonb ? 'exclusionOverrides' THEN ARRAY['exclusionOverrides'] ELSE ARRAY[]::text[] END)
    AND jsonb_typeof("outputPayloadJson"::jsonb -> 'rules') IS NOT DISTINCT FROM 'array'
    AND jsonb_typeof("outputPayloadJson"::jsonb -> 'exclusions') IS NOT DISTINCT FROM 'array'
    AND (NOT ("outputPayloadJson"::jsonb ? 'exclusionOverrides') OR jsonb_typeof("outputPayloadJson"::jsonb -> 'exclusionOverrides') IS NOT DISTINCT FROM 'array')
    AND jsonb_typeof("outputPayloadJson"::jsonb -> 'sourceBinding') IS NOT DISTINCT FROM 'object'
    AND jsonb_typeof("outputPayloadJson"::jsonb -> 'impact') IS NOT DISTINCT FROM 'object'
    AND jsonb_typeof("outputPayloadJson"::jsonb -> 'audioProjection') IN ('null','object')
    AND jsonb_typeof("outputPayloadJson"::jsonb -> 'sourceTranscriptId') IS NOT DISTINCT FROM 'string'
    AND jsonb_typeof("outputPayloadJson"::jsonb -> 'sourceArtifactId') IS NOT DISTINCT FROM 'string'
    AND jsonb_typeof("outputPayloadJson"::jsonb -> 'variantId') IS NOT DISTINCT FROM 'string'
    AND jsonb_typeof("outputPayloadJson"::jsonb -> 'editPlanHash') IS NOT DISTINCT FROM 'string'
    AND jsonb_typeof("outputPayloadJson"::jsonb #> '{sourceBinding,bindingHash}') IS NOT DISTINCT FROM 'string'
    AND jsonb_typeof("outputPayloadJson"::jsonb #> '{sourceBinding,document}') IS NOT DISTINCT FROM 'object'
    AND ("outputPayloadJson"::jsonb ->> 'sourceTranscriptId') ~ '^[A-Za-z0-9][A-Za-z0-9._:-]{2,127}$'
    AND ("outputPayloadJson"::jsonb ->> 'sourceArtifactId') ~ '^[A-Za-z0-9][A-Za-z0-9._:-]{2,127}$'
    AND ("outputPayloadJson"::jsonb ->> 'variantId') ~ '^[A-Za-z0-9][A-Za-z0-9._:-]{2,127}$'
    AND ("outputPayloadJson"::jsonb ->> 'editPlanHash') ~ '^[a-f0-9]{64}$'
    AND ("outputPayloadJson"::jsonb #>> '{impact,schemaVersion}') IS NOT DISTINCT FROM 'editorial-cut-impact/v2'
    AND ("outputPayloadJson"::jsonb #>> '{sourceBinding,document,schemaVersion}') IS NOT DISTINCT FROM 'editorial-source-binding/v1'
    AND ("outputPayloadJson"::jsonb #>> '{sourceBinding,document,canonicalPolicyVersion}') IS NOT DISTINCT FROM 'output-canonical-json/v1'
    AND ("outputPayloadJson"::jsonb #>> '{sourceBinding,document,projectId}') IS NOT DISTINCT FROM "projectId"
    AND ("outputPayloadJson"::jsonb #>> '{sourceBinding,document,workspaceId}') IS NOT DISTINCT FROM "workspaceId"
    AND ("outputPayloadJson"::jsonb #>> '{sourceBinding,document,parentVersionId}') IS NOT DISTINCT FROM "baseVersionId"
    AND ("outputPayloadJson"::jsonb #>> '{sourceBinding,bindingHash}') IS NOT NULL
    AND ("outputPayloadJson"::jsonb #>> '{sourceBinding,bindingHash}') = w66_v2_sha((("outputPayloadJson"::json -> 'sourceBinding') -> 'document')::text)
    AND "actorType" = 'api-client' AND "actorCredentialId" IS NOT NULL AND "actorEnvironment" IS NOT NULL
    AND "actorAuthenticationKind" IS NOT NULL AND "actorContextHash" IS NOT NULL
    AND "actorContextHash" = w66_v2_sha('{"authenticationKind":'||to_json("actorAuthenticationKind")::text||
      ',"clientId":'||to_json("actorId")::text||',"credentialId":'||to_json("actorCredentialId")::text||
      ',"delegatedIdentityId":'||coalesce(to_json("actorDelegatedIdentityId")::text,'null')||
      ',"delegatedUserId":'||coalesce(to_json("delegatedUserId")::text,'null')||
      ',"environment":'||to_json("actorEnvironment")::text||',"workspaceId":'||to_json("workspaceId")::text||
      ',"workspaceRole":'||coalesce(to_json("actorWorkspaceRole")::text,'null')||'}')
    AND "scopeJson"::jsonb IS NOT DISTINCT FROM '{"project":true}'::jsonb
    AND "commandJson"::jsonb IS NOT DISTINCT FROM (jsonb_build_object('schemaVersion',1,'id',"id",'workspaceId',"workspaceId",'projectId',"projectId",
      'baseVersionId',"baseVersionId",'baseHash',"baseHash",'type',"type",'scope',"scopeJson"::jsonb,'payload',"outputPayloadJson"::jsonb,
      'idempotencyKey',"idempotencyKey",'createdAt',w66_v2_iso("createdAt"),'author',jsonb_build_object('type',"actorType",'id',"actorId") ||
        CASE WHEN "delegatedUserId" IS NULL THEN '{}'::jsonb ELSE jsonb_build_object('delegatedUserId',"delegatedUserId") END) ||
      CASE WHEN "reason" IS NULL THEN '{}'::jsonb ELSE jsonb_build_object('reason',"reason") END)),false)
);

ALTER FUNCTION w66_assert_materialization_v3(text,text,text) RENAME TO w66_assert_materialization_v3_historical;
ALTER FUNCTION w66_assert_operational_state_v3(text) RENAME TO w66_assert_operational_state_v3_historical;
DO $$ DECLARE c record; BEGIN
 FOR c IN SELECT conname,pg_get_expr(conbin,conrelid) AS expression FROM pg_constraint
 WHERE contype='c' AND conrelid='output_materializations'::regclass LOOP
  IF position('output-materialization/v3' in c.expression)>0 THEN
   EXECUTE format('ALTER TABLE output_materializations DROP CONSTRAINT %I',c.conname);
   EXECUTE format('ALTER TABLE output_materializations ADD CONSTRAINT %I CHECK ((%s) OR (("materializationJson"::jsonb->>''schemaVersion'')=''editorial-derived-materialization/v1''))',c.conname,c.expression);
  END IF;
 END LOOP;
END $$;
CREATE FUNCTION w66_editorial_id_v1(p_kind text,p_command text,p_id text,p_start bigint,p_end bigint) RETURNS text LANGUAGE sql IMMUTABLE AS $$
 SELECT 'editorial-'||p_kind||'-'||left(w66_v2_sha('{"commandId":'||to_json(p_command)::text||',"end":'||p_end::text||',"id":'||to_json(p_id)::text||',"start":'||p_start::text||'}'),48)
$$;
CREATE FUNCTION w66_editorial_round_v1(p_value double precision) RETURNS bigint LANGUAGE sql IMMUTABLE AS $$
 SELECT floor(p_value)::bigint+CASE WHEN p_value-floor(p_value)>=.5 THEN 1 ELSE 0 END
$$;
CREATE FUNCTION w66_editorial_boundary_v1(p_ranges jsonb,p_frame bigint) RETURNS bigint LANGUAGE sql IMMUTABLE AS $$
 SELECT coalesce(sum(greatest(0,least(p_frame,(r.element->>'endFrame')::bigint)-(r.element->>'startFrame')::bigint)),0)::bigint
 FROM jsonb_array_elements(p_ranges) AS r(element)
$$;
-- Per-invocation parsing only. Split the existing OR guards before the first
-- body/version cast so an earlier factual rejection keeps its primary23514.
-- No successful-validation result is cached and every caller remains intact.
CREATE OR REPLACE FUNCTION w66_assert_creation_anchor_v3(p_state text) RETURNS void LANGUAGE plpgsql AS $$
DECLARE s project_output_states%ROWTYPE;v project_versions%ROWTYPE;c project_creation_commands%ROWTYPE;p projects%ROWTYPE;
 payload jsonb;command_doc jsonb;command_body_doc jsonb;version_doc jsonb;actor jsonb;expected_body jsonb;snap record;row_snapshot project_snapshots%ROWTYPE;entry_record record;entry_row project_output_state_entries%ROWTYPE;
BEGIN
 SELECT * INTO STRICT s FROM project_output_states WHERE id=p_state AND "schemaVersion"='project-output-state/v2';
 SELECT * INTO STRICT v FROM project_versions WHERE id=s."resultVersionId" AND "projectId"=s."projectId" AND "workspaceId"=s."workspaceId" AND "outputContractVersion"=2;
 SELECT * INTO STRICT c FROM project_creation_commands WHERE id=s."creationCommandV2Id" AND "projectId"=v."projectId" AND "workspaceId"=v."workspaceId" AND "versionId"=v.id AND "schemaVersion"=2;
 SELECT * INTO STRICT p FROM projects WHERE id=v."projectId" AND "workspaceId"=v."workspaceId" AND "creationContractVersion"=2;
 payload:=c."payloadJson"::jsonb;command_doc:=c."commandJson"::jsonb;actor:=command_doc->'audit';
 -- The sealed body excludes the three full-document attachments. Reuse the
 -- Creation2 factual reconstruction; no mutable historical head/status test.
 expected_body:=jsonb_build_object('canonicalPolicyVersion','output-canonical-json/v1','schemaVersion',2,'id',c.id,'workspaceId',c."workspaceId",'projectId',c."projectId",
  'versionId',v.id,'actorContextHash',c."actorContextHash",'payloadHash',c."payloadHash",'requestFingerprint',c."requestFingerprint",'createdAt',w66_v2_iso(c."createdAt"));
 IF NOT w66_v2_exact_json(command_doc,ARRAY['schemaVersion','canonicalPolicyVersion','id','workspaceId','projectId','versionId','actorContextHash','audit','author','createdAt','payload','payloadHash','requestFingerprint','commandHash']) THEN
  RAISE EXCEPTION 'W66v3 Creation2 Command actor/row/body differs' USING ERRCODE='23514'; END IF;
 command_body_doc:=c."commandBodyJson"::jsonb;
 IF command_body_doc IS DISTINCT FROM expected_body
 OR command_doc-ARRAY['audit','author','payload'] IS DISTINCT FROM expected_body||jsonb_build_object('commandHash',c."commandHash")
 OR command_doc->'payload' IS DISTINCT FROM payload OR actor->>'workspaceId' IS DISTINCT FROM c."workspaceId"
 OR actor->>'clientId' IS DISTINCT FROM c."actorClientId" OR actor->>'credentialId' IS DISTINCT FROM c."actorCredentialId"
 OR actor->>'environment' IS DISTINCT FROM c."actorEnvironment" OR actor->>'authenticationKind' IS DISTINCT FROM c."actorAuthenticationKind"
 OR actor->>'contextHash' IS DISTINCT FROM c."actorContextHash" OR actor->>'delegatedUserId' IS DISTINCT FROM c."actorDelegatedUserId"
 OR actor->>'delegatedIdentityId' IS DISTINCT FROM c."actorDelegatedIdentityId" OR actor->>'workspaceRole' IS DISTINCT FROM c."actorWorkspaceRole"
 OR command_doc->'author' IS DISTINCT FROM jsonb_strip_nulls(jsonb_build_object('type','api-client','id',c."actorClientId",'delegatedUserId',c."actorDelegatedUserId")) THEN
  RAISE EXCEPTION 'W66v3 Creation2 Command actor/row/body differs' USING ERRCODE='23514'; END IF;
 IF v."outputStateId" IS DISTINCT FROM s.id OR v."outputStateHash" IS DISTINCT FROM s."stateHash" OR s."stateHash" IS DISTINCT FROM w66_v2_sha(s."stateJson")
 OR s."provenanceHash" IS DISTINCT FROM c."commandHash" OR c."commandHash" IS DISTINCT FROM w66_v2_sha(c."commandBodyJson")
 OR command_doc-ARRAY['audit','author','payload'] IS DISTINCT FROM command_body_doc||jsonb_build_object('commandHash',c."commandHash")
 OR c."payloadHash" IS DISTINCT FROM w66_v2_sha(c."payloadJson") OR command_doc->'payload' IS DISTINCT FROM payload
 OR s."consumptionStatus" IS DISTINCT FROM 'blocked' OR v."baseHash" IS DISTINCT FROM w66_v2_sha(v."outputBaseHashJson") THEN
  RAISE EXCEPTION 'W66v3 Creation2 factual anchor differs' USING ERRCODE='23514'; END IF;
 version_doc:=v."outputVersionJson"::jsonb;
 IF version_doc->>'id' IS DISTINCT FROM v.id OR version_doc->>'baseHash' IS DISTINCT FROM v."baseHash"
 OR version_doc->>'outputStateId' IS DISTINCT FROM s.id OR version_doc->>'outputStateHash' IS DISTINCT FROM s."stateHash"
 OR version_doc->>'workspaceId' IS DISTINCT FROM v."workspaceId" OR version_doc->>'projectId' IS DISTINCT FROM v."projectId"
 OR p."ownerId" IS DISTINCT FROM c."actorClientId" OR (payload#>>'{callerIntent,kind}'='initialize-empty' AND p.format IS NOT NULL)
 OR (payload#>>'{callerIntent,kind}'='fork-with-content' AND p.format IS DISTINCT FROM payload#>>'{forkDerivation,document,sourceProject,format}') THEN
  RAISE EXCEPTION 'W66v3 Creation2 factual anchor differs' USING ERRCODE='23514'; END IF;
 FOR snap IN SELECT si.element FROM jsonb_array_elements(payload->'snapshots') AS si(element) LOOP
  SELECT * INTO STRICT row_snapshot FROM project_snapshots WHERE id=snap.element->>'id' AND "projectId"=v."projectId" AND "workspaceId"=v."workspaceId";
  IF snap.element->>'workspaceId' IS DISTINCT FROM row_snapshot."workspaceId" OR snap.element->>'projectId' IS DISTINCT FROM row_snapshot."projectId"
  OR snap.element->>'kind' IS DISTINCT FROM row_snapshot.kind OR (snap.element->>'contentSchemaVersion')::integer IS DISTINCT FROM row_snapshot."schemaVersion"
  OR snap.element->>'contentJson' IS DISTINCT FROM row_snapshot."contentJson" OR snap.element->>'contentHash' IS DISTINCT FROM row_snapshot."contentHash"
  OR row_snapshot."contentHash" IS DISTINCT FROM w66_v2_sha(row_snapshot."contentJson") OR snap.element->>'createdAt' IS DISTINCT FROM w66_v2_iso(row_snapshot."createdAt") THEN
   RAISE EXCEPTION 'W66v3 Creation2 snapshot factual anchor differs' USING ERRCODE='23514'; END IF;
 END LOOP;
 FOR entry_record IN SELECT ei.element FROM jsonb_array_elements(s."stateJson"::jsonb->'entries') AS ei(element) LOOP
  SELECT * INTO STRICT entry_row FROM project_output_state_entries WHERE "stateId"=s.id AND "variantId"=entry_record.element->>'variantId';
  IF entry_row."entryJson"::jsonb IS DISTINCT FROM entry_record.element OR entry_row."entryHash" IS DISTINCT FROM w66_v2_sha(entry_row."entryJson") THEN
   RAISE EXCEPTION 'W66v3 Creation2 member factual anchor differs' USING ERRCODE='23514'; END IF;
 END LOOP;
EXCEPTION WHEN no_data_found OR too_many_rows THEN RAISE EXCEPTION 'W66v3 Creation2 factual anchor missing/ambiguous' USING ERRCODE='23514';
END $$;

-- Equivalent range coverage with one expansion of each persisted array. Exact
-- rational inequalities are hoisted out of the per-frame loop. The selected
-- ordinal stream/prefix maximum retains overlap, duplicate slots and gap order;
-- output JSON arrays are aggregated once rather than concatenating every prefix.
-- No observation or authority result is cached, and all boundary checks remain.
CREATE OR REPLACE FUNCTION w66_range_coverage_v3(p_probe jsonb,p_start jsonb,p_end jsonb) RETURNS jsonb LANGUAGE plpgsql AS $$
DECLARE frames_doc jsonb;ends_doc jsonb;first_frame integer;last_frame integer;covered_end numeric;first_pts text;
 segments jsonb;gaps jsonb;start_multiplier numeric;start_limit numeric;end_multiplier numeric;end_limit numeric;
BEGIN
 IF w66_pts_compare_v3(p_probe->>'endPts',p_probe,p_end)<0 OR w66_pts_compare_v3(p_probe#>>'{frames,0,pts}',p_probe,p_start)>0 THEN
  RAISE EXCEPTION 'W66v3 range exceeds measured initial/terminal coverage' USING ERRCODE='23514'; END IF;
 frames_doc:=p_probe->'frames';ends_doc:=p_probe->'frameEndPts';
 start_multiplier:=(p_probe#>>'{timeBase,numerator}')::numeric*(p_probe#>>'{originSeconds,denominator}')::numeric*(p_start->>'denominator')::numeric;
 start_limit:=(p_start->>'numerator')::numeric*(p_probe#>>'{timeBase,denominator}')::numeric*(p_probe#>>'{originSeconds,denominator}')::numeric+
  (p_probe#>>'{originSeconds,numerator}')::numeric*(p_probe#>>'{timeBase,denominator}')::numeric*(p_start->>'denominator')::numeric;
 end_multiplier:=(p_probe#>>'{timeBase,numerator}')::numeric*(p_probe#>>'{originSeconds,denominator}')::numeric*(p_end->>'denominator')::numeric;
 end_limit:=(p_end->>'numerator')::numeric*(p_probe#>>'{timeBase,denominator}')::numeric*(p_probe#>>'{originSeconds,denominator}')::numeric+
  (p_probe#>>'{originSeconds,numerator}')::numeric*(p_probe#>>'{timeBase,denominator}')::numeric*(p_end->>'denominator')::numeric;
 WITH selected AS MATERIALIZED (
  SELECT frame_slot.ordinal,frame_slot.element->>'pts' AS start_pts,end_slot.element AS end_pts
  FROM jsonb_array_elements(frames_doc) WITH ORDINALITY AS frame_slot(element,ordinal)
  LEFT JOIN jsonb_array_elements_text(CASE WHEN jsonb_typeof(ends_doc)='array' THEN ends_doc ELSE '[]'::jsonb END)
   WITH ORDINALITY AS end_slot(element,ordinal) ON end_slot.ordinal=frame_slot.ordinal
  WHERE CASE WHEN end_slot.element::numeric*start_multiplier>start_limit
   THEN (frame_slot.element->>'pts')::numeric*end_multiplier<end_limit ELSE false END
 ), covered AS (
  SELECT selected.*,max(end_pts::numeric) OVER(ORDER BY ordinal ROWS BETWEEN UNBOUNDED PRECEDING AND 1 PRECEDING) AS covered_before
  FROM selected
 )
 SELECT min(ordinal)-1,max(ordinal)-1,max(end_pts::numeric),
  coalesce(jsonb_agg(jsonb_build_object('frame',ordinal-1,'startPts',start_pts,'endPts',end_pts) ORDER BY ordinal),'[]'::jsonb),
  coalesce(jsonb_agg(jsonb_build_object('startPts',trunc(covered_before)::text,'endPts',start_pts) ORDER BY ordinal)
   FILTER(WHERE start_pts::numeric>covered_before),'[]'::jsonb)
 INTO first_frame,last_frame,covered_end,segments,gaps FROM covered;
 first_pts:=segments#>>'{0,startPts}';
 IF first_frame IS NULL OR w66_pts_compare_v3(first_pts,p_probe,p_start)>0
 OR w66_pts_compare_v3(trunc(covered_end)::text,p_probe,p_end)<0 THEN
  RAISE EXCEPTION 'W66v3 range boundary lies in an observed gap' USING ERRCODE='23514'; END IF;
 RETURN jsonb_build_object('originSeconds',p_probe->'originSeconds','firstFrame',first_frame,'lastFrame',last_frame,
  'endExclusivePts',trunc(covered_end)::text,'timeBase',p_probe->'timeBase','coverage',CASE WHEN jsonb_array_length(gaps)=0 THEN 'complete' ELSE 'contains-measured-gaps' END,
  'segments',segments,'gaps',gaps);
END $$;

CREATE FUNCTION w66_assert_editorial_binding_v1(p_binding json,p_project text,p_workspace text,p_parent text,p_result text) RETURNS void LANGUAGE plpgsql AS $$
DECLARE d jsonb:=p_binding->'document';a jsonb:=d->'authority';sv project_versions%ROWTYPE;ss project_output_states%ROWTYPE;
 root project_versions%ROWTYPE;root_s project_output_states%ROWTYPE;der project_fork_derivations%ROWTYPE;t media_transcripts%ROWTYPE;
 item record;n output_normalization_receipts%ROWTYPE;i jsonb;mf media_artifact_manifests%ROWTYPE;ar media_artifacts%ROWTYPE;rs asset_rights_snapshots%ROWTYPE;
 source_state_doc jsonb;derivation_doc jsonb;
BEGIN
 IF NOT w66_v2_exact_json(p_binding::jsonb,ARRAY['document','bindingHash']) OR p_binding->>'bindingHash' IS DISTINCT FROM w66_v2_sha((p_binding->'document')::text)
 OR NOT w66_v2_exact_json(d,ARRAY['schemaVersion','canonicalPolicyVersion','id','workspaceId','projectId','parentVersionId','parentStateId','parentStateHash','resultVersionId','authority','transcript','normalizationRefs','inventory','createdAt'])
 OR d->>'schemaVersion'<>'editorial-source-binding/v1' OR d->>'canonicalPolicyVersion'<>'output-canonical-json/v1'
 OR d->>'projectId' IS DISTINCT FROM p_project OR d->>'workspaceId' IS DISTINCT FROM p_workspace OR d->>'parentVersionId' IS DISTINCT FROM p_parent
 OR d->>'resultVersionId' IS DISTINCT FROM p_result OR d->>'id' !~ '^[A-Za-z0-9][A-Za-z0-9._:-]{2,127}$'
 OR NOT EXISTS(SELECT 1 FROM project_versions v WHERE v.id=p_result AND v."projectId"=p_project AND v."workspaceId"=p_workspace AND d->>'createdAt'=w66_v2_iso(v."createdAt"))
 OR NOT EXISTS(SELECT 1 FROM project_versions pv WHERE pv.id=p_parent AND pv."projectId"=p_project AND pv."workspaceId"=p_workspace
  AND pv."outputStateId"=d->>'parentStateId' AND pv."outputStateHash"=d->>'parentStateHash') THEN
  RAISE EXCEPTION 'W66 editorial binding seal/parent/target differs' USING ERRCODE='23514'; END IF;
 SELECT * INTO STRICT sv FROM project_versions WHERE id=a->>'sourceVersionId' AND "projectId"=a->>'sourceProjectId' AND "workspaceId"=p_workspace
  AND "baseHash"=a->>'sourceBaseHash' AND "outputStateId"=a->>'sourceStateId' AND "outputStateHash"=a->>'sourceStateHash' AND "outputContractVersion"=3;
 SELECT * INTO STRICT ss FROM project_output_states WHERE id=sv."outputStateId" AND "resultVersionId"=sv.id AND "stateHash"=sv."outputStateHash";
 -- Per-invocation parsed values only. Every factual/hash/authority guard still
 -- runs independently; no validation outcome is stored or reused across calls.
 source_state_doc:=ss."stateJson"::jsonb;
 -- Source head may have advanced. Only this exact immutable State is reused.
 IF a->>'kind'='fork-derivation3' THEN
  SELECT * INTO STRICT root FROM project_versions WHERE id=a->>'forkRootVersionId' AND "projectId"=p_project AND "workspaceId"=p_workspace AND sequence=1 AND "outputContractVersion"=2;
  SELECT * INTO STRICT root_s FROM project_output_states WHERE id=root."outputStateId" AND id=a->>'forkRootStateId' AND "stateHash"=a->>'forkRootStateHash';
  PERFORM w66_assert_creation_anchor_v3(root_s.id);
  SELECT * INTO STRICT der FROM project_fork_derivations WHERE id=a->>'derivationId' AND "derivationHash"=a->>'derivationHash'
   AND "targetVersionId"=root.id AND "targetProjectId"=p_project AND "workspaceId"=p_workspace AND "schemaVersion"='project-fork-derivation/v3';
  derivation_doc:=der."derivationJson"::jsonb;
  IF derivation_doc#>>'{kernel,document,source,version,id}' IS DISTINCT FROM sv.id OR
   derivation_doc#>>'{kernel,document,source,state,stateHash}' IS DISTINCT FROM ss."stateHash" THEN
   RAISE EXCEPTION 'W66 editorial fork derivation source differs' USING ERRCODE='23514'; END IF;
  PERFORM w66_assert_fork_source_v3(derivation_doc#>'{kernel,document,source}',false);
  IF jsonb_array_length(d->'inventory')<>jsonb_array_length(derivation_doc->'sourceReferences') OR EXISTS(
   SELECT 1 FROM jsonb_array_elements(d->'inventory') AS inventory_entry(element) WHERE NOT EXISTS(SELECT 1 FROM jsonb_array_elements(derivation_doc->'sourceReferences') AS r(element)
    WHERE r.element->>'targetLinkId'=inventory_entry.element->>'linkId' AND r.element->>'artifactId'=inventory_entry.element->>'artifactId' AND r.element->>'role'=inventory_entry.element->>'role')) THEN
   RAISE EXCEPTION 'W66 editorial inventory escapes immutable fork derivation' USING ERRCODE='23514';END IF;
 ELSIF a->>'kind'='same-project-state3' THEN
  IF sv."projectId" IS DISTINCT FROM p_project OR a->'forkRootVersionId' IS DISTINCT FROM 'null'::jsonb OR a->'derivationId' IS DISTINCT FROM 'null'::jsonb THEN
   RAISE EXCEPTION 'W66 editorial same-project source differs' USING ERRCODE='23514'; END IF;
 ELSE RAISE EXCEPTION 'W66 editorial authority discriminator differs' USING ERRCODE='23514';END IF;
 IF EXISTS(SELECT 1 FROM project_versions pv WHERE pv.id=p_parent AND pv."outputContractVersion"=3) AND sv.id<>p_parent AND NOT EXISTS(
  SELECT 1 FROM output_operational_bundles pb WHERE pb."versionId"=p_parent AND pb."projectId"=p_project AND pb."workspaceId"=p_workspace
   AND pb."originJson"::jsonb->>'kind'='editorial-cut-command' AND pb."originJson"::jsonb#>'{command,payload,sourceBinding,document,authority}'=a) THEN
  RAISE EXCEPTION 'W66 editorial source authority is not explicit parent continuity' USING ERRCODE='23514';END IF;
 SELECT * INTO STRICT t FROM media_transcripts WHERE id=d#>>'{transcript,id}' AND "projectId"=sv."projectId" AND "workspaceId"=p_workspace;
 IF d->'transcript' IS DISTINCT FROM jsonb_build_object('id',t.id,'workspaceId',t."workspaceId",'projectId',t."projectId",'sourceArtifactId',t."sourceArtifactId",
  'sourceManifestId',t."sourceManifestId",'document',t."transcriptJson"::jsonb,'createdAt',w66_v2_iso(t."createdAt")) OR
  d#>>'{transcript,document,transcriptHash}' IS DISTINCT FROM t."transcriptHash" THEN
  RAISE EXCEPTION 'W66 editorial original transcript scope/receipt differs' USING ERRCODE='23514';END IF;
 IF jsonb_array_length(d->'normalizationRefs')=0 OR jsonb_array_length(d->'normalizationRefs')<>(SELECT count(DISTINCT r.element->>'id') FROM jsonb_array_elements(d->'normalizationRefs') AS r(element)) THEN
  RAISE EXCEPTION 'W66 editorial normalization refs missing/ambiguous' USING ERRCODE='23514';END IF;
 IF jsonb_array_length(d->'normalizationRefs')<>(SELECT count(DISTINCT nr.element#>>'{document,id}') FROM jsonb_array_elements(source_state_doc->'entries') AS e(element)
  CROSS JOIN LATERAL jsonb_array_elements(coalesce(e.element#>'{consumption,materialization,document,normalizations}','[]'::jsonb)) AS nr(element)) THEN
  RAISE EXCEPTION 'W66 editorial exact source observation inventory differs' USING ERRCODE='23514';END IF;
 FOR item IN SELECT r.element FROM jsonb_array_elements(d->'normalizationRefs') AS r(element) LOOP
  SELECT * INTO STRICT n FROM output_normalization_receipts WHERE id=item.element->>'id' AND "projectId"=item.element->>'projectId' AND "workspaceId"=p_workspace AND "receiptHash"=item.element->>'receiptHash';
  PERFORM w66_assert_normalization_v3(n.id,n."projectId",p_workspace);
  IF NOT EXISTS(SELECT 1 FROM jsonb_array_elements(source_state_doc->'entries') AS e(element)
   CROSS JOIN LATERAL jsonb_array_elements(coalesce(e.element#>'{consumption,materialization,document,normalizations}','[]'::jsonb)) AS nr(element)
   WHERE nr.element#>>'{document,id}'=n.id AND nr.element->>'receiptHash'=n."receiptHash") THEN
   RAISE EXCEPTION 'W66 editorial receipt escapes exact immutable source State' USING ERRCODE='23514';END IF;
 END LOOP;
 IF jsonb_array_length(d->'inventory')=0 OR jsonb_array_length(d->'inventory')<>(SELECT count(DISTINCT r.element->>'linkId') FROM jsonb_array_elements(d->'inventory') AS r(element)) THEN
  RAISE EXCEPTION 'W66 editorial target inventory missing/ambiguous' USING ERRCODE='23514';END IF;
 FOR item IN SELECT r.element FROM jsonb_array_elements(d->'inventory') AS r(element) LOOP
  i:=item.element;
  SELECT * INTO STRICT ar FROM media_artifacts WHERE id=i->>'artifactId' AND "workspaceId"=p_workspace;
  SELECT * INTO STRICT mf FROM media_artifact_manifests WHERE id=i->>'manifestId' AND "artifactId"=ar.id AND "workspaceId"=p_workspace AND "manifestHash"=i->>'manifestHash';
  IF ar.sha256 IS DISTINCT FROM i->>'artifactSha256' OR NOT EXISTS(SELECT 1 FROM project_media_assets l WHERE l.id::text=i->>'linkId' AND l."artifactId"=ar.id AND l.role=i->>'role' AND l."projectId"=p_project AND l."workspaceId"=p_workspace) THEN
   RAISE EXCEPTION 'W66 editorial target reference/manifest bytes differ' USING ERRCODE='23514';END IF;
  IF i->>'rightsSnapshotId' IS NOT NULL THEN
   SELECT * INTO STRICT rs FROM asset_rights_snapshots WHERE id=i->>'rightsSnapshotId' AND "artifactId"=ar.id AND "workspaceId"=p_workspace AND "snapshotHash"=i->>'rightsHash';
   IF rs.sequence>(i->>'rightsRevision')::integer OR NOT EXISTS(SELECT 1 FROM asset_rights_changes rc WHERE rc."artifactId"=ar.id AND rc."workspaceId"=p_workspace
    AND rc.sequence=(i->>'rightsRevision')::integer AND rc."snapshotId"=rs.id AND rc."snapshotHash"=rs."snapshotHash") THEN
    RAISE EXCEPTION 'W66 editorial sealed audited rights binding differs' USING ERRCODE='23514';END IF;
  END IF;
 END LOOP;
EXCEPTION WHEN no_data_found OR too_many_rows THEN RAISE EXCEPTION 'W66 editorial source authority missing/ambiguous' USING ERRCODE='23514';
END $$;


-- Independent recomposition of typed editorial content. JSON comparison covers
-- all retained unknown data, not just hashes or the newly changed range fields.
CREATE FUNCTION w66_editorial_plan_v1(p_before jsonb,p_binding jsonb,p_command text,p_version text,p_plan text,p_created text,p_exclusions jsonb) RETURNS jsonb LANGUAGE plpgsql AS $$
DECLARE fps double precision:=(p_before->>'fps')::double precision;duration bigint:=(p_before->>'durationFrames')::bigint;
 removed jsonb:='[]';merged jsonb:='[]';kept jsonb:='[]';cursor bigint:=0;total bigint:=0;last_end bigint:=0;last_start bigint:=0;
 item record;track record;clip record;ex record;r record;word record;cue record;idx record;row_item record;
 start_frame bigint;end_frame bigint;source_start bigint;source_end bigint;target_start bigint;target_end bigint;piece_number integer;
 rate double precision;doc jsonb;next_doc jsonb;tracks jsonb:='[]';clips jsonb;pieces jsonb:='[]';words jsonb:='[]';old_words jsonb:=p_before#>'{retimedTranscript,words}';
 subtitle_tracks jsonb:='[]';cues jsonb;selected jsonb;cue_text text;ref jsonb;container text;rows jsonb;music jsonb:='[]';markers jsonb:='[]';transitions jsonb:='[]';retired jsonb:='[]';
 source_ranges jsonb:='[]';original jsonb;from_clip jsonb;to_clip jsonb;parent_ranges jsonb;source_clips jsonb;planned_ranges jsonb:='[]';range_row record;range_start double precision;range_end double precision;
BEGIN
 IF p_before->>'schemaVersion'<>'2' OR p_before->>'state'<>'compiled' OR fps<=0 OR duration<=0 OR jsonb_typeof(old_words)<>'array' THEN
  RAISE EXCEPTION 'W66 editorial parent timing/alignment unavailable' USING ERRCODE='23514';END IF;
 FOR track IN SELECT x.element FROM jsonb_array_elements(p_before->'videoTracks') AS x(element) WHERE x.element->>'kind'='base-video' LOOP
  FOR clip IN SELECT x.element FROM jsonb_array_elements(track.element->'clips') AS x(element) WHERE x.element->>'sourceArtifactId'=p_binding#>>'{document,transcript,sourceArtifactId}' LOOP
   FOR ex IN SELECT x.element FROM jsonb_array_elements(p_exclusions) AS x(element) LOOP
    source_start:=greatest((clip.element->>'sourceInFrame')::bigint,floor((ex.element->>'sourceStartSeconds')::double precision*fps+1e-7)::bigint);
    source_end:=least((clip.element->>'sourceOutFrame')::bigint,ceil((ex.element->>'sourceEndSeconds')::double precision*fps-1e-7)::bigint);
    IF source_end>source_start THEN
     start_frame:=greatest((clip.element->>'timelineInFrame')::bigint,least((clip.element->>'timelineOutFrame')::bigint,(clip.element->>'timelineInFrame')::bigint+
      w66_editorial_round_v1((source_start-(clip.element->>'sourceInFrame')::bigint)/(clip.element->>'rate')::double precision)));
     end_frame:=greatest((clip.element->>'timelineInFrame')::bigint,least((clip.element->>'timelineOutFrame')::bigint,(clip.element->>'timelineInFrame')::bigint+
      w66_editorial_round_v1((source_end-(clip.element->>'sourceInFrame')::bigint)/(clip.element->>'rate')::double precision)));
     IF end_frame<=start_frame OR start_frame<0 OR end_frame>duration THEN RAISE EXCEPTION 'W66 editorial exclusion boundary invalid' USING ERRCODE='23514';END IF;
     removed:=removed||jsonb_build_array(jsonb_build_object('startFrame',start_frame,'endFrame',end_frame));
    END IF;
   END LOOP;
  END LOOP;
 END LOOP;
 SELECT coalesce(jsonb_agg(c.element ORDER BY t.ordinal,c.ordinal),'[]'::jsonb) INTO source_clips FROM jsonb_array_elements(p_before->'videoTracks') WITH ORDINALITY AS t(element,ordinal)
  CROSS JOIN LATERAL jsonb_array_elements(t.element->'clips') WITH ORDINALITY AS c(element,ordinal) WHERE t.element->>'kind'='base-video' AND c.element->>'sourceArtifactId'=p_binding#>>'{document,transcript,sourceArtifactId}';
 parent_ranges:=p_before#>'{editorial,retainedSourceRanges}';
 IF parent_ranges IS NULL THEN SELECT coalesce(jsonb_agg(jsonb_build_object('sourceStartSeconds',(c.element->>'sourceInFrame')::bigint/fps,
  'sourceEndSeconds',(c.element->>'sourceOutFrame')::bigint/fps) ORDER BY c.ordinal),'[]'::jsonb) INTO parent_ranges FROM jsonb_array_elements(source_clips) WITH ORDINALITY AS c(element,ordinal);END IF;
 IF jsonb_array_length(parent_ranges)<>jsonb_array_length(source_clips) OR EXISTS(SELECT 1 FROM jsonb_array_elements(parent_ranges) WITH ORDINALITY AS x(element,ordinal)
  WHERE ceil((x.element->>'sourceStartSeconds')::double precision*fps-1e-7)::bigint IS DISTINCT FROM (source_clips->(x.ordinal::integer-1)->>'sourceInFrame')::bigint OR
   floor((x.element->>'sourceEndSeconds')::double precision*fps+1e-7)::bigint IS DISTINCT FROM (source_clips->(x.ordinal::integer-1)->>'sourceOutFrame')::bigint) THEN
  RAISE EXCEPTION 'W66 editorial parent planned ranges contradict frame geometry' USING ERRCODE='23514';END IF;
 FOR range_row IN SELECT x.element FROM jsonb_array_elements(parent_ranges) AS x(element) LOOP
  range_start:=(range_row.element->>'sourceStartSeconds')::double precision;range_end:=(range_row.element->>'sourceEndSeconds')::double precision;
  FOR ex IN SELECT x.element FROM jsonb_array_elements(p_exclusions) AS x(element) LOOP
   IF (ex.element->>'sourceEndSeconds')::double precision<=range_start OR (ex.element->>'sourceStartSeconds')::double precision>=range_end THEN CONTINUE;END IF;
   IF (ex.element->>'sourceStartSeconds')::double precision>range_start THEN planned_ranges:=planned_ranges||jsonb_build_array(jsonb_build_object('sourceStartSeconds',range_start,
    'sourceEndSeconds',least((ex.element->>'sourceStartSeconds')::double precision,range_end)));END IF;
   range_start:=greatest(range_start,least((ex.element->>'sourceEndSeconds')::double precision,range_end));
  END LOOP;
  IF range_start<range_end THEN planned_ranges:=planned_ranges||jsonb_build_array(jsonb_build_object('sourceStartSeconds',range_start,'sourceEndSeconds',range_end));END IF;
 END LOOP;
 IF jsonb_array_length(removed)=0 THEN RAISE EXCEPTION 'W66 editorial excludes no actual source range' USING ERRCODE='23514';END IF;
 FOR r IN SELECT x.element FROM jsonb_array_elements(removed) AS x(element) ORDER BY (x.element->>'startFrame')::bigint,(x.element->>'endFrame')::bigint LOOP
  start_frame:=(r.element->>'startFrame')::bigint;end_frame:=(r.element->>'endFrame')::bigint;
  IF last_end=0 THEN last_start:=start_frame;last_end:=end_frame;
  ELSIF start_frame<=last_end THEN last_end:=greatest(last_end,end_frame);
  ELSE merged:=merged||jsonb_build_array(jsonb_build_object('startFrame',last_start,'endFrame',last_end));last_start:=start_frame;last_end:=end_frame;END IF;
 END LOOP;
 merged:=merged||jsonb_build_array(jsonb_build_object('startFrame',last_start,'endFrame',last_end));
 FOR r IN SELECT x.element FROM jsonb_array_elements(merged) AS x(element) LOOP
  start_frame:=(r.element->>'startFrame')::bigint;end_frame:=(r.element->>'endFrame')::bigint;
  IF start_frame>cursor THEN kept:=kept||jsonb_build_array(jsonb_build_object('startFrame',cursor,'endFrame',start_frame,'targetStartFrame',total));total:=total+start_frame-cursor;END IF;
  cursor:=end_frame;
 END LOOP;
 IF cursor<duration THEN kept:=kept||jsonb_build_array(jsonb_build_object('startFrame',cursor,'endFrame',duration,'targetStartFrame',total));total:=total+duration-cursor;END IF;
 IF total<=0 THEN RAISE EXCEPTION 'W66 editorial removes entire timeline' USING ERRCODE='23514';END IF;
 FOR track IN SELECT x.element FROM jsonb_array_elements(p_before->'videoTracks') AS x(element) LOOP
  clips:='[]';
  FOR clip IN SELECT x.element FROM jsonb_array_elements(track.element->'clips') AS x(element) LOOP
   piece_number:=0;rate:=(clip.element->>'rate')::double precision;
   FOR r IN SELECT x.element FROM jsonb_array_elements(kept) AS x(element) LOOP
    start_frame:=greatest((clip.element->>'timelineInFrame')::bigint,(r.element->>'startFrame')::bigint);end_frame:=least((clip.element->>'timelineOutFrame')::bigint,(r.element->>'endFrame')::bigint);
    IF end_frame<=start_frame THEN CONTINUE;END IF;
    source_start:=(clip.element->>'sourceInFrame')::bigint+w66_editorial_round_v1((start_frame-(clip.element->>'timelineInFrame')::bigint)*rate);
    source_end:=(clip.element->>'sourceInFrame')::bigint+w66_editorial_round_v1((end_frame-(clip.element->>'timelineInFrame')::bigint)*rate);
    IF source_start<(clip.element->>'sourceInFrame')::bigint OR source_end>(clip.element->>'sourceOutFrame')::bigint OR source_end<=source_start OR
     w66_editorial_round_v1((source_end-source_start)/rate)<>end_frame-start_frame THEN RAISE EXCEPTION 'W66 editorial exact rate map unavailable' USING ERRCODE='23514';END IF;
    target_start:=(r.element->>'targetStartFrame')::bigint+start_frame-(r.element->>'startFrame')::bigint;target_end:=target_start+end_frame-start_frame;
    next_doc:=clip.element||jsonb_build_object('id',CASE WHEN piece_number=0 THEN clip.element->>'id' ELSE w66_editorial_id_v1('clip',p_command,clip.element->>'id',start_frame,end_frame) END,
     'sourceInFrame',source_start,'sourceOutFrame',source_end,'timelineInFrame',target_start,'timelineOutFrame',target_end);
    IF clip.element ? 'audioSourceArtifactId' THEN
     IF NOT (clip.element ? 'audioSourceInFrame' AND clip.element ? 'audioSourceOutFrame') THEN RAISE EXCEPTION 'W66 editorial audio range authority missing' USING ERRCODE='23514';END IF;
     next_doc:=next_doc||jsonb_build_object('audioSourceInFrame',(clip.element->>'audioSourceInFrame')::bigint+source_start-(clip.element->>'sourceInFrame')::bigint,
      'audioSourceOutFrame',(clip.element->>'audioSourceInFrame')::bigint+source_end-(clip.element->>'sourceInFrame')::bigint);
     IF (next_doc->>'audioSourceOutFrame')::bigint>(clip.element->>'audioSourceOutFrame')::bigint THEN RAISE EXCEPTION 'W66 editorial audio boundary differs' USING ERRCODE='23514';END IF;
    END IF;
    clips:=clips||jsonb_build_array(next_doc);pieces:=pieces||jsonb_build_array(jsonb_build_object('sourceClipId',clip.element->>'id','document',next_doc));piece_number:=piece_number+1;
    IF track.element->>'kind'='base-video' AND clip.element->>'sourceArtifactId'=p_binding#>>'{document,transcript,sourceArtifactId}' THEN
     source_ranges:=source_ranges||jsonb_build_array(jsonb_build_object('sourceStartSeconds',source_start/fps,'sourceEndSeconds',source_end/fps));END IF;
   END LOOP;
  END LOOP;
  tracks:=tracks||jsonb_build_array(track.element||jsonb_build_object('clips',clips));
 END LOOP;
 SELECT coalesce(jsonb_agg(c.element ORDER BY t.ordinal,c.ordinal),'[]'::jsonb) INTO source_clips FROM jsonb_array_elements(tracks) WITH ORDINALITY AS t(element,ordinal)
  CROSS JOIN LATERAL jsonb_array_elements(t.element->'clips') WITH ORDINALITY AS c(element,ordinal) WHERE t.element->>'kind'='base-video' AND c.element->>'sourceArtifactId'=p_binding#>>'{document,transcript,sourceArtifactId}';
 IF jsonb_array_length(planned_ranges)<>jsonb_array_length(source_clips) OR EXISTS(SELECT 1 FROM jsonb_array_elements(planned_ranges) WITH ORDINALITY AS x(element,ordinal)
  WHERE ceil((x.element->>'sourceStartSeconds')::double precision*fps-1e-7)::bigint IS DISTINCT FROM (source_clips->(x.ordinal::integer-1)->>'sourceInFrame')::bigint OR
   floor((x.element->>'sourceEndSeconds')::double precision*fps+1e-7)::bigint IS DISTINCT FROM (source_clips->(x.ordinal::integer-1)->>'sourceOutFrame')::bigint) THEN
  RAISE EXCEPTION 'W66 editorial planned source ranges contradict preserved rate map' USING ERRCODE='23514';END IF;
 FOR word IN SELECT x.element FROM jsonb_array_elements(old_words) AS x(element) LOOP
  FOR r IN SELECT x.element FROM jsonb_array_elements(kept) AS x(element) LOOP
   IF (word.element->>'timelineStartFrame')::bigint>=(r.element->>'startFrame')::bigint AND (word.element->>'timelineEndFrame')::bigint<=(r.element->>'endFrame')::bigint THEN
    words:=words||jsonb_build_array(word.element||jsonb_build_object('timelineStartFrame',w66_editorial_boundary_v1(kept,(word.element->>'timelineStartFrame')::bigint),
     'timelineEndFrame',w66_editorial_boundary_v1(kept,(word.element->>'timelineEndFrame')::bigint)));EXIT;END IF;
  END LOOP;
 END LOOP;
 FOR track IN SELECT x.element FROM jsonb_array_elements(p_before->'subtitleTracks') AS x(element) LOOP
  cues:='[]';
  FOR cue IN SELECT x.element FROM jsonb_array_elements(track.element->'cues') AS x(element) LOOP
   piece_number:=0;
   FOR r IN SELECT x.element FROM jsonb_array_elements(kept) AS x(element) LOOP
    start_frame:=greatest((cue.element->>'startFrame')::bigint,(r.element->>'startFrame')::bigint);end_frame:=least((cue.element->>'endFrame')::bigint,(r.element->>'endFrame')::bigint);IF end_frame<=start_frame THEN CONTINUE;END IF;
    selected:=cue.element->'sourceWordIndices';cue_text:=cue.element->>'text';
    IF start_frame<>(cue.element->>'startFrame')::bigint OR end_frame<>(cue.element->>'endFrame')::bigint THEN
     IF track.element->>'schemaVersion' IS DISTINCT FROM 'source-transcript-cue-track/v1' OR track.element->>'sourceTranscriptId' IS DISTINCT FROM p_binding#>>'{document,transcript,id}' OR
      track.element->>'sourceTranscriptHash' IS DISTINCT FROM p_binding#>>'{document,transcript,document,transcriptHash}' OR jsonb_typeof(selected) IS DISTINCT FROM 'array' THEN
      RAISE EXCEPTION 'W66 editorial partial cue alignment unavailable' USING ERRCODE='23514';END IF;
     selected:='[]';cue_text:='';
     FOR idx IN SELECT x.element FROM jsonb_array_elements(cue.element->'sourceWordIndices') AS x(element) LOOP
      original:=p_binding#>'{document,transcript,document,words}'->(idx.element::text)::integer;
      IF EXISTS(SELECT 1 FROM jsonb_array_elements(old_words) AS w(element) WHERE w.element->>'text'=original->>'word' AND w.element->'sourceStartSeconds'=original->'start' AND
       w.element->'sourceEndSeconds'=original->'end' AND (w.element->>'timelineStartFrame')::bigint>=start_frame AND (w.element->>'timelineEndFrame')::bigint<=end_frame) THEN
       selected:=selected||jsonb_build_array(idx.element);cue_text:=cue_text||CASE WHEN cue_text='' THEN '' ELSE ' ' END||(original->>'word');END IF;
     END LOOP;
     IF jsonb_array_length(selected)=0 THEN CONTINUE;END IF;
    END IF;
    target_start:=w66_editorial_boundary_v1(kept,start_frame);target_end:=w66_editorial_boundary_v1(kept,end_frame);
    next_doc:=cue.element||jsonb_build_object('id',CASE WHEN piece_number=0 THEN cue.element->>'id' ELSE w66_editorial_id_v1('cue',p_command,cue.element->>'id',start_frame,end_frame) END,
     'startFrame',target_start,'endFrame',target_end,'text',cue_text);
    IF selected IS NOT NULL THEN next_doc:=next_doc||jsonb_build_object('sourceWordIndices',selected);END IF;
    IF cue.element ? 'clipId' THEN
     SELECT x.element->'document' INTO STRICT ref FROM jsonb_array_elements(pieces) AS x(element) WHERE x.element->>'sourceClipId'=cue.element->>'clipId' AND
      (x.element#>>'{document,timelineInFrame}')::bigint<=target_start AND (x.element#>>'{document,timelineOutFrame}')::bigint>=target_end;
     next_doc:=next_doc||jsonb_build_object('clipId',ref->>'id');END IF;
    cues:=cues||jsonb_build_array(next_doc);piece_number:=piece_number+1;
   END LOOP;
  END LOOP;
  subtitle_tracks:=subtitle_tracks||jsonb_build_array(track.element||jsonb_build_object('cues',cues));
 END LOOP;
 doc:=p_before-ARRAY['directorRunId','director','manualEditing','qualityReport','approval'];
 FOR container IN SELECT unnest(ARRAY['overlayTracks','effectTracks','protectedElements']) LOOP
  rows:='[]';
  FOR row_item IN SELECT x.element FROM jsonb_array_elements(coalesce(p_before->container,'[]'::jsonb)) AS x(element) LOOP
   IF NOT (row_item.element ? 'startFrame' OR row_item.element ? 'endFrame') THEN rows:=rows||jsonb_build_array(row_item.element);CONTINUE;END IF;
   piece_number:=0;
   FOR r IN SELECT x.element FROM jsonb_array_elements(kept) AS x(element) LOOP
    start_frame:=greatest((row_item.element->>'startFrame')::bigint,(r.element->>'startFrame')::bigint);end_frame:=least((row_item.element->>'endFrame')::bigint,(r.element->>'endFrame')::bigint);IF end_frame<=start_frame THEN CONTINUE;END IF;
    target_start:=w66_editorial_boundary_v1(kept,start_frame);target_end:=w66_editorial_boundary_v1(kept,end_frame);
    next_doc:=row_item.element||jsonb_build_object('id',CASE WHEN piece_number=0 THEN row_item.element->>'id' ELSE w66_editorial_id_v1('element',p_command,row_item.element->>'id',start_frame,end_frame) END,
     'startFrame',target_start,'endFrame',target_end);
    IF row_item.element ? 'clipId' THEN
     SELECT x.element->'document' INTO STRICT ref FROM jsonb_array_elements(pieces) AS x(element) WHERE x.element->>'sourceClipId'=row_item.element->>'clipId' AND
      (x.element#>>'{document,timelineInFrame}')::bigint<=target_start AND (x.element#>>'{document,timelineOutFrame}')::bigint>=target_end;
     next_doc:=next_doc||jsonb_build_object('clipId',ref->>'id');END IF;
    rows:=rows||jsonb_build_array(next_doc);piece_number:=piece_number+1;
   END LOOP;
  END LOOP;
  doc:=doc||jsonb_build_object(container,rows);
 END LOOP;
 FOR row_item IN SELECT x.element FROM jsonb_array_elements(coalesce(p_before->'audioTracks','[]'::jsonb)) AS x(element) LOOP
  IF row_item.element->>'kind'<>'background-music' OR (row_item.element->>'timelineInFrame')::bigint<>0 OR
   (row_item.element->>'timelineOutFrame')::bigint<>duration OR (row_item.element->>'sourceOutFrame')::bigint-(row_item.element->>'sourceInFrame')::bigint<total THEN
   RAISE EXCEPTION 'W66 editorial music capacity unavailable' USING ERRCODE='23514';END IF;
  music:=music||jsonb_build_array(row_item.element||jsonb_build_object('timelineOutFrame',total,'fadeInFrames',least((row_item.element->>'fadeInFrames')::bigint,total),
   'fadeOutFrames',least((row_item.element->>'fadeOutFrames')::bigint,total)));
 END LOOP;
 FOR row_item IN SELECT x.element FROM jsonb_array_elements(coalesce(p_before->'markers','[]'::jsonb)) AS x(element) LOOP
  next_doc:=row_item.element;
  IF row_item.element ? 'atFrame' THEN next_doc:=next_doc||jsonb_build_object('atFrame',w66_editorial_boundary_v1(kept,(row_item.element->>'atFrame')::bigint));END IF;
  markers:=markers||jsonb_build_array(next_doc);
 END LOOP;
 IF p_before ? 'transitions' THEN
  FOR row_item IN SELECT x.element FROM jsonb_array_elements(p_before->'transitions') AS x(element) LOOP
   SELECT x.element->'document' INTO from_clip FROM jsonb_array_elements(pieces) WITH ORDINALITY AS x(element,ordinal) WHERE x.element->>'sourceClipId'=row_item.element->>'fromClipId' ORDER BY x.ordinal DESC LIMIT 1;
   SELECT x.element->'document' INTO to_clip FROM jsonb_array_elements(pieces) WITH ORDINALITY AS x(element,ordinal) WHERE x.element->>'sourceClipId'=row_item.element->>'toClipId' ORDER BY x.ordinal LIMIT 1;
   IF from_clip IS NULL OR to_clip IS NULL THEN retired:=retired||jsonb_build_array(row_item.element||jsonb_build_object('reasonCode','editorial-endpoint-removed'));
   ELSE
    IF from_clip->'timelineOutFrame' IS DISTINCT FROM to_clip->'timelineInFrame' THEN RAISE EXCEPTION 'W66 editorial transition endpoint capacity unavailable' USING ERRCODE='23514';END IF;
    transitions:=transitions||jsonb_build_array(row_item.element||jsonb_build_object('fromClipId',from_clip->>'id','toClipId',to_clip->>'id','atFrame',to_clip->'timelineInFrame'));
   END IF;
  END LOOP;
  doc:=doc||jsonb_build_object('transitions',transitions);
 END IF;
 doc:=doc||jsonb_build_object('id',p_plan,'projectVersionId',p_version,'createdAt',p_created,'durationFrames',total,'videoTracks',tracks,'subtitleTracks',subtitle_tracks,'audioTracks',music,'markers',markers,
  'retimedTranscript',p_before->'retimedTranscript'||jsonb_build_object('sourceTranscriptId',p_binding#>>'{document,transcript,id}',
   'sourceTranscriptHash',p_binding#>>'{document,transcript,document,transcriptHash}','sourceBindingRef',jsonb_build_object('schemaVersion','editorial-source-binding-ref/v1',
    'id',p_binding#>>'{document,id}','hash',p_binding->>'bindingHash','projectId',p_binding#>>'{document,projectId}'),'words',words),
  'editorial',coalesce(p_before->'editorial','{}'::jsonb)||jsonb_build_object('commandType','remove-spoken-content','exclusions',p_exclusions,
   'retainedSourceRanges',planned_ranges,'retainedTimelineRanges',kept,'retiredTransitions',retired));
 IF p_before#>>'{sourceTranscriptCueProjection,status}'='available' THEN doc:=jsonb_set(doc,'{sourceTranscriptCueProjection,cueCount}',
  to_jsonb((SELECT count(*) FROM jsonb_array_elements(subtitle_tracks) AS t(element) CROSS JOIN LATERAL jsonb_array_elements(t.element->'cues') AS c(element))));END IF;
 -- Audio hashes have their own literal historical serializer. Content is
 -- checked above; the producer guard separately authenticates the exact hash.
 IF p_before ? 'audioTimelineHash' THEN doc:=doc-'audioTimelineHash';END IF;
 RETURN doc;
EXCEPTION WHEN no_data_found OR too_many_rows THEN RAISE EXCEPTION 'W66 editorial typed reference missing/ambiguous' USING ERRCODE='23514';
END $$;
CREATE FUNCTION w66_assert_editorial_materialization_v1(p_id text,p_project text,p_workspace text) RETURNS void LANGUAGE plpgsql AS $$
DECLARE m output_materializations%ROWTYPE;d jsonb;p jsonb;sp project_snapshots%ROWTYPE;re output_spec_revisions%ROWTYPE;item record;clip_doc jsonb;track_doc jsonb;
 n output_normalization_receipts%ROWTYPE;normalized jsonb;audio_n output_normalization_receipts%ROWTYPE;span double precision;rounded_span bigint;audio_source jsonb;audio_derivative jsonb;expected_audio jsonb;music_track jsonb;analysis music_analyses%ROWTYPE;
BEGIN
 SELECT * INTO STRICT m FROM output_materializations WHERE id=p_id AND "projectId"=p_project AND "workspaceId"=p_workspace;
 SELECT * INTO STRICT sp FROM project_snapshots WHERE id=m."planSnapshotId" AND "projectId"=p_project AND "workspaceId"=p_workspace AND "contentHash"=m."planHash" AND kind='edit-plan';
 SELECT * INTO STRICT re FROM output_spec_revisions WHERE id=m."outputSpecRevisionId" AND "variantId"=m."variantId" AND "specHash"=m."specHash" AND "projectId"=p_project AND "workspaceId"=p_workspace;
 d:=m."materializationJson"::jsonb;p:=sp."contentJson"::jsonb;
 PERFORM w66_assert_editorial_binding_v1((m."materializationJson"::json)->'sourceBinding',p_project,p_workspace,
  (SELECT "parentVersionId" FROM project_versions WHERE id=m."resultVersionId" AND "projectId"=p_project AND "workspaceId"=p_workspace),m."resultVersionId");
 IF NOT w66_v2_exact_json(d,ARRAY['schemaVersion','canonicalPolicyVersion','id','workspaceId','projectId','resultVersionId','variantId','outputSpecRevisionId','specHash',
  'planSnapshotId','planHash','fps','durationFrames','videoTracks','clips','audioTracks','music','overlayTracks','subtitleTracks','composition','normalizations','emission','createdAt','sourceBinding'])
 OR d->>'id' IS DISTINCT FROM m.id OR d->>'workspaceId' IS DISTINCT FROM p_workspace OR d->>'projectId' IS DISTINCT FROM p_project
 OR d->>'resultVersionId' IS DISTINCT FROM m."resultVersionId" OR d->>'variantId' IS DISTINCT FROM m."variantId"
 OR d->>'outputSpecRevisionId' IS DISTINCT FROM m."outputSpecRevisionId" OR d->>'specHash' IS DISTINCT FROM m."specHash"
 OR d->>'planSnapshotId' IS DISTINCT FROM sp.id OR d->>'planHash' IS DISTINCT FROM sp."contentHash"
 OR d->>'createdAt' IS DISTINCT FROM w66_v2_iso(m."createdAt") OR p->>'projectVersionId' IS DISTINCT FROM m."resultVersionId"
 OR d->'fps' IS DISTINCT FROM p->'fps' OR d->'durationFrames' IS DISTINCT FROM p->'durationFrames'
 OR d->'audioTracks' IS DISTINCT FROM p->'audioTracks' OR d->'overlayTracks' IS DISTINCT FROM p->'overlayTracks'
 OR d->'subtitleTracks' IS DISTINCT FROM p->'subtitleTracks' OR d->'composition' IS DISTINCT FROM coalesce(p->'composition','null'::jsonb)
 OR d->'emission' IS DISTINCT FROM '{"subtitles":"suppressed-missing-visual-clock-authority","cta":"suppressed-missing-visual-clock-authority"}'::jsonb THEN
  RAISE EXCEPTION 'W66v3 materialization plan/revision/containers differ' USING ERRCODE='23514'; END IF;
 IF d->>'schemaVersion'<>'editorial-derived-materialization/v1' OR jsonb_array_length(d->'normalizations')<>(SELECT count(DISTINCT normalization_entry.element#>>'{document,id}') FROM jsonb_array_elements(d->'normalizations') AS normalization_entry(element)) OR jsonb_array_length(d->'normalizations')<>jsonb_array_length(d#>'{sourceBinding,document,normalizationRefs}') OR EXISTS(SELECT 1 FROM output_materialization_normalizations mn WHERE mn."materializationId"=m.id)
 OR jsonb_array_length(d->'clips')<>(SELECT count(*) FROM jsonb_array_elements(p->'videoTracks') AS pt(element)
   CROSS JOIN LATERAL jsonb_array_elements(pt.element->'clips') AS pc(element)) THEN
  RAISE EXCEPTION 'W66v3 materialization membership differs' USING ERRCODE='23514'; END IF;
 FOR item IN SELECT nx.element FROM jsonb_array_elements(d->'normalizations') AS nx(element) LOOP
  SELECT nr.* INTO STRICT n FROM output_normalization_receipts nr WHERE nr.id=item.element#>>'{document,id}'
   AND nr."projectId"=item.element#>>'{document,projectId}' AND nr."workspaceId"=p_workspace AND EXISTS(
    SELECT 1 FROM jsonb_array_elements(d#>'{sourceBinding,document,normalizationRefs}') AS ref(element)
    WHERE ref.element->>'id'=nr.id AND ref.element->>'projectId'=nr."projectId" AND ref.element->>'receiptHash'=nr."receiptHash");
  IF item.element IS DISTINCT FROM jsonb_build_object('document',n."receiptJson"::jsonb,'receiptHash',n."receiptHash") THEN
   RAISE EXCEPTION 'W66v3 materialization normalization seal differs' USING ERRCODE='23514'; END IF;
  -- binding_v1 above already validates every scoped normalizationRef in THIS
  -- invocation. Distinct IDs/count, the ref join and full document+receiptHash
  -- equality above bind this item to the SAME immutable validated row. No
  -- validation result is cached across entries, calls, transactions or updates.
 END LOOP;
 FOR item IN SELECT cx.element FROM jsonb_array_elements(d->'clips') AS cx(element) LOOP
  SELECT pc.element,pt.element INTO STRICT clip_doc,track_doc FROM jsonb_array_elements(p->'videoTracks') AS pt(element)
   CROSS JOIN LATERAL jsonb_array_elements(pt.element->'clips') AS pc(element) WHERE pc.element->>'id'=item.element->>'id';
  IF item.element->>'trackId' IS DISTINCT FROM track_doc->>'id' OR item.element->>'trackKind' IS DISTINCT FROM track_doc->>'kind'
   OR item.element->>'sourceArtifactId' IS DISTINCT FROM clip_doc->>'sourceArtifactId'
   OR item.element->'sourceInFrame' IS DISTINCT FROM clip_doc->'sourceInFrame' OR item.element->'sourceOutFrame' IS DISTINCT FROM clip_doc->'sourceOutFrame'
   OR item.element->'timelineInFrame' IS DISTINCT FROM clip_doc->'timelineInFrame' OR item.element->'timelineOutFrame' IS DISTINCT FROM clip_doc->'timelineOutFrame'
   OR item.element->'rate' IS DISTINCT FROM clip_doc->'rate' OR item.element->'crop' IS DISTINCT FROM coalesce(clip_doc->'crop','null'::jsonb) THEN
    RAISE EXCEPTION 'W66v3 clip/track/rate/crop differs' USING ERRCODE='23514'; END IF;
  IF (clip_doc->>'rate')::double precision NOT BETWEEN .25 AND 4 OR (clip_doc->>'sourceInFrame')::bigint<0
   OR (clip_doc->>'sourceOutFrame')::bigint<=(clip_doc->>'sourceInFrame')::bigint OR (clip_doc->>'timelineInFrame')::bigint<0
   OR (clip_doc->>'timelineOutFrame')::bigint>(p->>'durationFrames')::bigint THEN
    RAISE EXCEPTION 'W66v3 clip range/rate invalid' USING ERRCODE='23514'; END IF;
  span:=((clip_doc->>'sourceOutFrame')::bigint-(clip_doc->>'sourceInFrame')::bigint)::double precision/(clip_doc->>'rate')::double precision;
  rounded_span:=floor(span)::bigint+CASE WHEN span-floor(span)>=.5 THEN 1 ELSE 0 END;
  IF rounded_span IS DISTINCT FROM (clip_doc->>'timelineOutFrame')::bigint-(clip_doc->>'timelineInFrame')::bigint THEN
    RAISE EXCEPTION 'W66v3 shared rate map differs' USING ERRCODE='23514'; END IF;
  SELECT * INTO STRICT n FROM output_normalization_receipts WHERE id=item.element->>'videoNormalizationId' AND "receiptHash"=item.element->>'videoNormalizationHash'
   AND "workspaceId"=p_workspace AND id IN (SELECT nr.element#>>'{document,id}' FROM jsonb_array_elements(d->'normalizations') AS nr(element)) AND "sourceArtifactId"=clip_doc->>'sourceArtifactId';
  IF NOT EXISTS(SELECT 1 FROM project_media_assets l WHERE l."projectId"=p_project AND l."workspaceId"=p_workspace AND l."artifactId"=n."sourceArtifactId"
   AND l.role IN ('source-master','selected-insert')) THEN
    RAISE EXCEPTION 'W66v3 clip source role/range facts differ' USING ERRCODE='23514'; END IF;
  normalized:=n."receiptJson"::jsonb;
  IF NOT w66_v2_exact_json(item.element,ARRAY['id','trackId','trackKind','sourceArtifactId','sourceInFrame','sourceOutFrame','timelineInFrame','timelineOutFrame','rate','crop','videoNormalizationId','videoNormalizationHash','range','renderSource','audio'])
  OR item.element->'range' IS DISTINCT FROM w66_observed_range_v3(normalized->'sourceProbe',normalized->'derivativeProbe',
    (clip_doc->>'sourceInFrame')::bigint,(clip_doc->>'sourceOutFrame')::bigint,(p->>'fps')::double precision)
  OR item.element->'renderSource' IS DISTINCT FROM jsonb_build_object('artifactId',n."derivativeArtifactId",'manifestId',n."derivativeManifestId",'manifestHash',n."derivativeManifestHash",
    'artifactKey',normalized#>>'{derivative,manifest,artifact,artifactKey}','sha256',normalized#>>'{derivative,manifest,artifact,sha256}',
    'byteSize',normalized#>'{derivative,manifest,artifact,byteSize}') THEN
   RAISE EXCEPTION 'W66v3 observed range/derivative consumption binding differs' USING ERRCODE='23514'; END IF;
  SELECT * INTO STRICT audio_n FROM output_normalization_receipts WHERE "sourceArtifactId"=coalesce(clip_doc->>'audioSourceArtifactId',clip_doc->>'sourceArtifactId')
   AND "workspaceId"=p_workspace AND id IN (SELECT nr.element#>>'{document,id}' FROM jsonb_array_elements(d->'normalizations') AS nr(element));
  normalized:=audio_n."receiptJson"::jsonb;
  audio_source:=CASE WHEN normalized->>'kind'='ffprobe-original-audio' THEN normalized->'sourceProbe' ELSE normalized#>'{audioProbes,source}' END;
  audio_derivative:=CASE WHEN normalized->>'kind'='ffprobe-original-audio' THEN normalized->'derivativeProbe' ELSE normalized#>'{audioProbes,derivative}' END;
  IF audio_source='null'::jsonb OR audio_derivative='null'::jsonb THEN
   IF clip_doc ? 'audioSourceArtifactId' OR item.element->'audio' IS DISTINCT FROM 'null'::jsonb THEN
    RAISE EXCEPTION 'W66v3 explicit audio authority missing' USING ERRCODE='23514'; END IF;
  ELSE
   expected_audio:=jsonb_build_object('artifactId',audio_n."sourceArtifactId",'sourceInFrame',coalesce(clip_doc->'audioSourceInFrame',clip_doc->'sourceInFrame'),
    'sourceOutFrame',coalesce(clip_doc->'audioSourceOutFrame',clip_doc->'sourceOutFrame'),'normalizationId',audio_n.id,'normalizationHash',audio_n."receiptHash",'renderSource',jsonb_build_object('artifactId',audio_n."derivativeArtifactId",'manifestId',audio_n."derivativeManifestId",'manifestHash',audio_n."derivativeManifestHash",
     'artifactKey',normalized#>>'{derivative,manifest,artifact,artifactKey}','sha256',normalized#>>'{derivative,manifest,artifact,sha256}',
     'byteSize',normalized#>'{derivative,manifest,artifact,byteSize}'),'range',
    w66_observed_range_v3(audio_source,audio_derivative,coalesce(clip_doc->>'audioSourceInFrame',clip_doc->>'sourceInFrame')::bigint,
      coalesce(clip_doc->>'audioSourceOutFrame',clip_doc->>'sourceOutFrame')::bigint,(p->>'fps')::double precision));
   IF item.element->'audio' IS DISTINCT FROM expected_audio OR NOT EXISTS(SELECT 1 FROM project_media_assets l WHERE l."projectId"=p_project AND l."workspaceId"=p_workspace
     AND l."artifactId"=audio_n."sourceArtifactId" AND l.role IN ('source-master','source-audio','selected-insert')) THEN
    RAISE EXCEPTION 'W66v3 primary/secondary audio facts differ' USING ERRCODE='23514'; END IF;
  END IF;
 END LOOP;
 IF jsonb_array_length(d->'music')<>jsonb_array_length(p->'audioTracks') THEN RAISE EXCEPTION 'W66v3 music membership differs' USING ERRCODE='23514'; END IF;
 FOR item IN SELECT mi.element FROM jsonb_array_elements(d->'music') AS mi(element) LOOP
  SELECT mt.element INTO STRICT music_track FROM jsonb_array_elements(p->'audioTracks') AS mt(element) WHERE mt.element->>'id'=item.element->>'trackId';
  SELECT * INTO STRICT audio_n FROM output_normalization_receipts WHERE id=item.element->>'normalizationId' AND "receiptHash"=item.element->>'normalizationHash'
   AND "workspaceId"=p_workspace AND id IN (SELECT nr.element#>>'{document,id}' FROM jsonb_array_elements(d->'normalizations') AS nr(element)) AND "sourceArtifactId"=music_track->>'artifactId';
  SELECT ma.* INTO STRICT analysis FROM music_analyses ma JOIN project_versions av ON av.id=ma."projectVersionId" AND av."workspaceId"=ma."workspaceId"
   WHERE ma.id=music_track->>'analysisId' AND ma."analysisHash"=music_track->>'analysisHash' AND ma."workspaceId"=p_workspace AND av."projectId"=d#>>'{sourceBinding,document,authority,sourceProjectId}';
  normalized:=audio_n."receiptJson"::jsonb;
  IF music_track->>'kind' IS DISTINCT FROM 'background-music' OR normalized->>'kind' IS DISTINCT FROM 'ffprobe-original-audio'
  OR analysis."sourceArtifactId" IS DISTINCT FROM audio_n."sourceArtifactId" OR analysis."sourceSha256" IS DISTINCT FROM normalized#>>'{source,manifest,artifact,sha256}'
  OR analysis."sourceByteSize" IS DISTINCT FROM (normalized#>>'{source,manifest,artifact,byteSize}')::bigint OR analysis."rightsSnapshotId" IS DISTINCT FROM music_track->>'rightsSnapshotId'
  OR (music_track->>'gainDb')::double precision NOT BETWEEN -60 AND -12 OR (music_track->>'timelineInFrame')::bigint<>0
  OR music_track->'timelineOutFrame' IS DISTINCT FROM p->'durationFrames' OR (music_track->>'sourceInFrame')::bigint<0
  OR (music_track->>'sourceOutFrame')::bigint-(music_track->>'sourceInFrame')::bigint<(p->>'durationFrames')::bigint
  OR item.element IS DISTINCT FROM jsonb_build_object('trackId',music_track->>'id','artifactId',audio_n."sourceArtifactId",'normalizationId',audio_n.id,
    'normalizationHash',audio_n."receiptHash",'renderSource',jsonb_build_object('artifactId',audio_n."derivativeArtifactId",'manifestId',audio_n."derivativeManifestId",'manifestHash',audio_n."derivativeManifestHash",
     'artifactKey',normalized#>>'{derivative,manifest,artifact,artifactKey}','sha256',normalized#>>'{derivative,manifest,artifact,sha256}',
     'byteSize',normalized#>'{derivative,manifest,artifact,byteSize}'),'range',w66_observed_range_v3(normalized->'sourceProbe',normalized->'derivativeProbe',
      (music_track->>'sourceInFrame')::bigint,(music_track->>'sourceOutFrame')::bigint,(p->>'fps')::double precision)) THEN
   RAISE EXCEPTION 'W66v3 music source/analysis/range binding differs' USING ERRCODE='23514'; END IF;
 END LOOP;
 IF d->'videoTracks' IS DISTINCT FROM (SELECT coalesce(jsonb_agg(jsonb_build_object('id',pt.element->>'id','kind',pt.element->>'kind',
   'clipIds',(SELECT coalesce(jsonb_agg(pc.element->'id' ORDER BY pc.ordinal),'[]'::jsonb) FROM jsonb_array_elements(pt.element->'clips') WITH ORDINALITY AS pc(element,ordinal)))
   ORDER BY pt.ordinal),'[]'::jsonb) FROM jsonb_array_elements(p->'videoTracks') WITH ORDINALITY AS pt(element,ordinal)) THEN
  RAISE EXCEPTION 'W66v3 complete track inventory differs' USING ERRCODE='23514'; END IF;
EXCEPTION WHEN no_data_found OR too_many_rows THEN RAISE EXCEPTION 'W66v3 materialization factual membership missing/ambiguous' USING ERRCODE='23514';
END $$;

CREATE FUNCTION w66_assert_materialization_v3(p_id text,p_project text,p_workspace text) RETURNS void LANGUAGE plpgsql AS $$
DECLARE contract text;BEGIN
 SELECT "materializationJson"::jsonb->>'schemaVersion' INTO STRICT contract FROM output_materializations WHERE id=p_id AND "projectId"=p_project AND "workspaceId"=p_workspace;
 IF contract='output-materialization/v3' THEN PERFORM w66_assert_materialization_v3_historical(p_id,p_project,p_workspace);
 ELSIF contract='editorial-derived-materialization/v1' THEN PERFORM w66_assert_editorial_materialization_v1(p_id,p_project,p_workspace);
 ELSE RAISE EXCEPTION 'W66 unknown materialization contract' USING ERRCODE='23514';END IF;
END $$;

CREATE FUNCTION w66_assert_editorial_impact_v2(cmd edit_commands,b project_versions,v project_versions,bs project_output_states,bp jsonb,pj jsonb) RETURNS void LANGUAGE plpgsql AS $$
DECLARE payload jsonb:=cmd."outputPayloadJson"::jsonb;impact jsonb:=payload->'impact';expected jsonb;ranges jsonb;outputs jsonb;variants jsonb;raw_body text;affected record;ai command_artifact_invalidations%ROWTYPE;identity_text text;
BEGIN
 SELECT jsonb_agg(pe."variantId" ORDER BY pe."variantId" COLLATE "C") INTO variants FROM project_output_state_entries pe WHERE pe."stateId"=bs.id;
 ranges:=jsonb_build_array(jsonb_build_object('startFrame',0,'endFrame',greatest((bp->>'durationFrames')::bigint,(pj->>'durationFrames')::bigint)));
 IF EXISTS(SELECT 1 FROM project_final_export_operations fe JOIN public_operations po ON po.id=fe."operationId" AND po."workspaceId"=fe."workspaceId"
  WHERE fe."projectVersionId"=b.id AND fe."projectId"=v."projectId" AND fe."workspaceId"=v."workspaceId" AND po.status='succeeded') THEN
  RAISE EXCEPTION 'W66 editorial final output lacks stable variant authority' USING ERRCODE='23514';END IF;
 IF EXISTS(SELECT 1 FROM project_proxy_render_operations pr JOIN public_operations po ON po.id=pr."operationId" AND po."workspaceId"=pr."workspaceId"
  WHERE pr."projectVersionId"=b.id AND pr."projectId"=v."projectId" AND pr."workspaceId"=v."workspaceId" AND po.status='succeeded' AND
   (pr."renderableVariantId" IS NULL OR pr."renderableVariantId"='' OR NOT EXISTS(SELECT 1 FROM project_output_state_entries pe WHERE pe."stateId"=bs.id AND pe."variantId"=pr."renderableVariantId"))) THEN
  RAISE EXCEPTION 'W66 editorial proxy lacks exact State variant authority' USING ERRCODE='23514';END IF;
 SELECT coalesce(jsonb_agg(jsonb_build_object('artifactId',pr."outputArtifactId",'kind','proxy','sourceVersionId',b.id,'variantId',pr."renderableVariantId")
  ORDER BY pr."outputArtifactId" COLLATE "C"),'[]'::jsonb) INTO outputs FROM project_proxy_render_operations pr JOIN public_operations po ON po.id=pr."operationId" AND po."workspaceId"=pr."workspaceId"
  WHERE pr."projectVersionId"=b.id AND pr."projectId"=v."projectId" AND pr."workspaceId"=v."workspaceId" AND po.status='succeeded';
 IF impact->'affectedArtifacts' IS DISTINCT FROM outputs THEN RAISE EXCEPTION 'W66 editorial output membership differs' USING ERRCODE='23514';END IF;
 expected:=jsonb_build_object('schemaVersion','editorial-cut-impact/v2','commandId',cmd.id,'commandType','remove-spoken-content','baseVersionId',b.id,'resultVersionId',v.id,
  'sourceTranscriptId',payload->>'sourceTranscriptId','sourceTranscriptHash',payload#>>'{sourceBinding,document,transcript,document,transcriptHash}',
  'changeKinds','["spoken-content-removal"]'::jsonb,'dependencyTypes','["audio","content","timing","visual"]'::jsonb,'affectedRanges',ranges,'affectedVariantIds',variants,'affectedArtifacts',outputs,
  'minimalRenders',jsonb_build_array(jsonb_build_object('kind','proxy','variantId',payload->>'variantId','ranges',jsonb_build_array(jsonb_build_object('startFrame',0,'endFrame',(pj->>'durationFrames')::bigint)))),
  'renderSemanticsChanged',true);
 SELECT '{'||string_agg('"'||field.name||'":'||((cmd."outputPayloadJson"::json->'impact')->field.name)::text,',' ORDER BY field.ordinal)||'}' INTO raw_body
  FROM unnest(ARRAY['affectedArtifacts','affectedRanges','affectedVariantIds','baseVersionId','changeKinds','commandId','commandType','dependencyTypes','minimalRenders',
   'renderSemanticsChanged','resultVersionId','schemaVersion','sourceTranscriptHash','sourceTranscriptId']) WITH ORDINALITY AS field(name,ordinal);
 IF NOT w66_v2_exact_json(impact,ARRAY['schemaVersion','commandId','commandType','baseVersionId','resultVersionId','sourceTranscriptId','sourceTranscriptHash','changeKinds','dependencyTypes',
  'affectedRanges','affectedVariantIds','affectedArtifacts','minimalRenders','renderSemanticsChanged','impactHash']) OR impact-'impactHash' IS DISTINCT FROM expected OR
  impact->>'impactHash' IS DISTINCT FROM w66_v2_sha(raw_body) THEN RAISE EXCEPTION 'W66 editorial impact differs from actual global effect' USING ERRCODE='23514';END IF;
 FOR affected IN SELECT x.element FROM jsonb_array_elements(outputs) AS x(element) LOOP
  SELECT * INTO STRICT ai FROM command_artifact_invalidations WHERE "commandId"=cmd.id AND "resultVersionId"=v.id AND "baseVersionId"=b.id AND "projectId"=v."projectId" AND "workspaceId"=v."workspaceId"
   AND "artifactId"=affected.element->>'artifactId' AND kind='proxy' AND "variantId"=affected.element->>'variantId';
  IF ai.status<>'stale' OR ai."impactHash" IS DISTINCT FROM impact->>'impactHash' OR ai."dependencyTypesJson"::jsonb IS DISTINCT FROM impact->'dependencyTypes' OR
   ai."affectedRangesJson"::jsonb IS DISTINCT FROM ranges OR ai."createdAt" IS DISTINCT FROM v."createdAt" THEN RAISE EXCEPTION 'W66 editorial invalidation fact differs' USING ERRCODE='23514';END IF;
  identity_text:='{"affectedRanges":'||((cmd."outputPayloadJson"::json->'impact')->'affectedRanges')::text||',"artifactId":'||to_json(ai."artifactId")::text||
   ',"baseVersionId":'||to_json(b.id)::text||',"commandId":'||to_json(cmd.id)::text||',"createdAt":'||to_json(w66_v2_iso(v."createdAt"))::text||
   ',"dependencyTypes":'||((cmd."outputPayloadJson"::json->'impact')->'dependencyTypes')::text||',"impactHash":'||to_json(impact->>'impactHash')::text||
   ',"kind":"proxy","resultVersionId":'||to_json(v.id)::text||',"schemaVersion":"command-artifact-invalidation/v1","status":"stale","variantId":'||to_json(ai."variantId")::text||'}';
  IF ai.id IS DISTINCT FROM w66_v2_sha(identity_text) THEN RAISE EXCEPTION 'W66 editorial invalidation identity seal differs' USING ERRCODE='23514';END IF;
 END LOOP;
 IF (SELECT count(*) FROM command_artifact_invalidations WHERE "commandId"=cmd.id AND "workspaceId"=v."workspaceId")<>jsonb_array_length(outputs) THEN
  RAISE EXCEPTION 'W66 editorial invalidation membership differs' USING ERRCODE='23514';END IF;
EXCEPTION WHEN no_data_found OR too_many_rows THEN RAISE EXCEPTION 'W66 editorial invalidation membership missing/ambiguous' USING ERRCODE='23514';
END $$;
CREATE FUNCTION w66_assert_editorial_state_v1(p_state text) RETURNS void LANGUAGE plpgsql AS $$
DECLARE s project_output_states%ROWTYPE;v project_versions%ROWTYPE;b project_versions%ROWTYPE;bs project_output_states%ROWTYPE;
 ob output_operational_bundles%ROWTYPE;d jsonb;o jsonb;pj jsonb;sp project_snapshots%ROWTYPE;bp jsonb;cmd edit_commands%ROWTYPE;entry_record record;
 e project_output_state_entries%ROWTYPE;re output_spec_revisions%ROWTYPE;m output_materializations%ROWTYPE;expected_version jsonb;target_v project_versions%ROWTYPE;
 source_state project_output_states%ROWTYPE;root_state text;project_row projects%ROWTYPE;source_plan jsonb;expected_producer jsonb;metadata jsonb;tr media_transcripts%ROWTYPE;operation_row public_operations%ROWTYPE;detail_row media_ingest_operations%ROWTYPE;manual_payload jsonb;manual_impact jsonb;impact_ranges jsonb;impact_body jsonb;manual_impact_text text;affected_output jsonb;editorial_payload jsonb;editorial_expected jsonb;audio jsonb;speech_body jsonb;
BEGIN
 SELECT * INTO STRICT s FROM project_output_states WHERE id=p_state AND "schemaVersion"='project-output-state/v3';
 SELECT * INTO STRICT v FROM project_versions WHERE id=s."resultVersionId" AND "workspaceId"=s."workspaceId" AND "projectId"=s."projectId" AND "outputContractVersion"=3;
 SELECT * INTO STRICT b FROM project_versions WHERE id=s."parentVersionId" AND "workspaceId"=s."workspaceId" AND "projectId"=s."projectId" AND "outputContractVersion" IN (2,3);
 SELECT * INTO STRICT bs FROM project_output_states WHERE id=b."outputStateId" AND "resultVersionId"=b.id AND "stateHash"=b."outputStateHash" AND "workspaceId"=b."workspaceId" AND "projectId"=b."projectId";
 SELECT * INTO STRICT ob FROM output_operational_bundles WHERE "versionId"=v.id AND "stateId"=s.id AND "workspaceId"=v."workspaceId" AND "projectId"=v."projectId";
 SELECT * INTO STRICT sp FROM project_snapshots WHERE id=s."editPlanSnapshotId" AND "projectId"=s."projectId" AND "workspaceId"=s."workspaceId" AND kind='edit-plan';
 SELECT * INTO STRICT project_row FROM projects WHERE id=v."projectId" AND "workspaceId"=v."workspaceId" AND "creationContractVersion"=2;
 SELECT rv."outputStateId" INTO STRICT root_state FROM project_versions rv WHERE rv."projectId"=v."projectId" AND rv."workspaceId"=v."workspaceId" AND rv.sequence=1 AND rv."outputContractVersion"=2;
 PERFORM w66_assert_creation_anchor_v3(root_state);
 IF b."outputContractVersion"=2 THEN PERFORM w66_assert_creation_anchor_v3(bs.id);
 ELSIF bs."schemaVersion" IS DISTINCT FROM 'project-output-state/v3' OR bs."stateHash" IS DISTINCT FROM w66_v2_sha(bs."stateJson") OR b."baseHash" IS DISTINCT FROM w66_v2_sha(b."outputBaseHashJson")
  OR b."outputVersionJson"::jsonb->>'outputStateHash' IS DISTINCT FROM bs."stateHash" THEN
  RAISE EXCEPTION 'W66v3 parent immutable local anchor differs' USING ERRCODE='23514';END IF;
 d:=s."stateJson"::jsonb;o:=ob."originJson"::jsonb;pj:=sp."contentJson"::jsonb;
 IF b."outputContractVersion"=2 AND (bs.transition IS DISTINCT FROM 'fork-with-content' OR s.transition IS DISTINCT FROM 'editorial-cut') THEN
  RAISE EXCEPTION 'W66v3 Fork2 target authority remains blocked' USING ERRCODE='23514';END IF;
 SELECT x."contentJson"::jsonb INTO STRICT bp FROM project_snapshots x WHERE x.id=b."editPlanSnapshotId" AND x."projectId"=b."projectId" AND x."workspaceId"=b."workspaceId";
 IF d->>'schemaVersion' IS DISTINCT FROM 'project-output-state/v3' OR d->>'canonicalPolicyVersion' IS DISTINCT FROM s."canonicalPolicyVersion"
 OR d->>'transitionPolicyVersion' IS DISTINCT FROM s."transitionPolicyVersion" OR s."canonicalPolicyVersion"<>'output-canonical-json/v1' OR s."transitionPolicyVersion"<>'project-output-transition/v3'
 OR s.transition IS DISTINCT FROM 'editorial-cut'
 OR NOT w66_v2_exact_json(d,ARRAY['schemaVersion','canonicalPolicyVersion','transitionPolicyVersion','id','workspaceId','projectId','resultVersionId','parentVersionId','parentStateId',
  'parentStateHash','transition','provenance','producer','editPlan','renderablePlan','entries','overlays','invalidations','sourceDependencies','createdAt'])
 OR d->>'id' IS DISTINCT FROM s.id OR d->>'workspaceId' IS DISTINCT FROM s."workspaceId" OR d->>'projectId' IS DISTINCT FROM s."projectId"
 OR d->>'resultVersionId' IS DISTINCT FROM v.id OR d->>'parentVersionId' IS DISTINCT FROM b.id OR d->>'parentStateId' IS DISTINCT FROM bs.id
 OR d->>'parentStateHash' IS DISTINCT FROM bs."stateHash" OR s."parentStateId" IS DISTINCT FROM bs.id OR s."parentStateHash" IS DISTINCT FROM bs."stateHash"
 OR d->>'transition' IS DISTINCT FROM s.transition OR d->>'createdAt' IS DISTINCT FROM w66_v2_iso(s."createdAt")
 OR d->'provenance' IS DISTINCT FROM jsonb_build_object('kind',s."producerKind",'id',s."producerId",'hash',s."provenanceHash")
 OR d->'producer' IS DISTINCT FROM jsonb_build_object('document',s."producerJson"::jsonb,'hash',s."producerHash")
 OR s."producerHash" IS DISTINCT FROM w66_v2_sha(s."producerJson") OR s."stateHash" IS DISTINCT FROM w66_v2_sha(s."stateJson")
 OR sp."contentHash" IS DISTINCT FROM s."editPlanHash" OR sp."contentHash" IS DISTINCT FROM w66_v2_sha(sp."contentJson")
 OR pj->>'projectVersionId' IS DISTINCT FROM v.id OR d#>>'{editPlan,snapshotId}' IS DISTINCT FROM sp.id
 OR d#>>'{editPlan,hash}' IS DISTINCT FROM sp."contentHash" OR d->'renderablePlan' IS DISTINCT FROM 'null'::jsonb
 OR s."renderablePlanSnapshotId" IS NOT NULL OR s."renderablePlanId" IS NOT NULL OR s."creationCommandV2Id" IS NOT NULL
 OR v."parentVersionId" IS DISTINCT FROM b.id OR v.sequence<>b.sequence+1 OR v."outputStateId" IS DISTINCT FROM s.id
 OR v."outputStateHash" IS DISTINCT FROM s."stateHash" OR v."createdAt" IS DISTINCT FROM s."createdAt" THEN
  RAISE EXCEPTION 'W66v3 State/Version/parent/plan reciprocal binding' USING ERRCODE='23514'; END IF;
 PERFORM w66_assert_plan_authority(s."editPlanAuthorityJson",s."editPlanAuthorityHash",'project-edit-plan',sp."contentHash",pj);
 IF d#>'{editPlan,authority}' IS DISTINCT FROM jsonb_build_object('schemaVersion','output-plan-authority/v1','document',s."editPlanAuthorityJson"::jsonb,'hash',s."editPlanAuthorityHash") THEN
  RAISE EXCEPTION 'W66v3 State plan authority envelope differs' USING ERRCODE='23514'; END IF;
 expected_version:=jsonb_build_object('schemaVersion',1,'canonicalPolicyVersion','output-canonical-json/v1','outputContractVersion',3,'id',v.id,'workspaceId',v."workspaceId",
  'projectId',v."projectId",'sequence',v.sequence,'parentVersionId',b.id,'baseHash',v."baseHash",'outputStateId',s.id,'outputStateHash',s."stateHash",
  'createdBy',v."createdBy",'createdAt',w66_v2_iso(v."createdAt"),'snapshotRefs',jsonb_build_object('brief',v."briefSnapshotId",'policies',v."policiesSnapshotId",'editPlan',sp.id)||
   CASE WHEN v."treatmentSnapshotId" IS NULL THEN '{}'::jsonb ELSE jsonb_build_object('treatment',v."treatmentSnapshotId") END||
   CASE WHEN v."storySnapshotId" IS NULL THEN '{}'::jsonb ELSE jsonb_build_object('story',v."storySnapshotId") END)||
   CASE WHEN v."commandId" IS NULL THEN '{}'::jsonb ELSE jsonb_build_object('commandId',v."commandId") END;
 IF v."outputVersionJson"::jsonb IS DISTINCT FROM expected_version OR v."outputBaseHashJson"::jsonb IS DISTINCT FROM jsonb_build_object(
  'schemaVersion','project-output-bound-version-hash/v3','canonicalPolicyVersion','output-canonical-json/v1','workspaceId',v."workspaceId",'projectId',v."projectId",
  'resultVersionId',v.id,'parentVersionId',b.id,'previousBaseHash',b."baseHash",'producerHash',s."producerHash",'outputStateId',s.id,'outputStateHash',s."stateHash")
 OR v."baseHash" IS DISTINCT FROM w66_v2_sha(v."outputBaseHashJson") OR ob."bundleJson"::jsonb->>'schemaVersion' IS DISTINCT FROM 'operational-output-version-bundle/v3'
 OR ob."bundleJson"::jsonb->'version' IS DISTINCT FROM expected_version OR ob."bundleJson"::jsonb->'state' IS DISTINCT FROM jsonb_build_object('document',d,'stateHash',s."stateHash")
 OR ob."bundleJson"::jsonb->'origin' IS DISTINCT FROM o OR ob."bundleJson"::jsonb->>'outputBaseHashJson' IS DISTINCT FROM v."outputBaseHashJson" THEN
  RAISE EXCEPTION 'W66v3 bundle/base hash authority differs' USING ERRCODE='23514'; END IF;
 PERFORM w66_assert_provenance(s."producerKind",s."producerId",s."provenanceHash",s."projectId",s."workspaceId",v.id);
 source_state:=bs;source_plan:=bp;
 IF s."producerKind"='edit-command' THEN
  SELECT * INTO STRICT cmd FROM edit_commands WHERE id=s."producerId" AND "projectId"=s."projectId" AND "workspaceId"=s."workspaceId";
  IF ob."producerPayloadJson" IS NULL OR ob."producerPayloadHash" IS NULL OR ob."producerPayloadHash" IS DISTINCT FROM w66_v2_sha(ob."producerPayloadJson")
 OR ob."producerPayloadJson"::jsonb IS DISTINCT FROM cmd."payloadJson"::jsonb OR cmd."baseVersionId" IS DISTINCT FROM b.id OR cmd."baseHash" IS DISTINCT FROM b."baseHash" OR cmd."actorId" IS DISTINCT FROM v."createdBy"
   OR cmd."createdAt" IS DISTINCT FROM v."createdAt" OR v."commandId" IS DISTINCT FROM cmd.id THEN
   RAISE EXCEPTION 'W66v3 Command base/actor/time differs' USING ERRCODE='23514'; END IF;
  IF o->>'kind'='editorial-cut-command' THEN
   editorial_payload:=cmd."outputPayloadJson"::jsonb;
   IF cmd.type IS DISTINCT FROM 'remove-spoken-content' OR cmd."actorType" IS DISTINCT FROM 'api-client' OR editorial_payload->'schemaVersion' IS DISTINCT FROM '3'::jsonb
    OR cmd."outputPayloadHash" IS DISTINCT FROM w66_v2_sha(cmd."outputPayloadJson") OR editorial_payload IS DISTINCT FROM cmd."payloadJson"::jsonb
    OR o->'command' IS DISTINCT FROM cmd."commandJson"::jsonb||jsonb_build_object('commandHash',cmd."commandHash")
    OR o->>'requestFingerprint' IS DISTINCT FROM cmd."requestFingerprint" OR o#>>'{audit,contextHash}' IS DISTINCT FROM cmd."actorContextHash"
    OR o->'audit' IS DISTINCT FROM (jsonb_build_object('clientId',cmd."actorId",'credentialId',cmd."actorCredentialId",'workspaceId',cmd."workspaceId",
      'environment',cmd."actorEnvironment",'authenticationKind',cmd."actorAuthenticationKind",'contextHash',cmd."actorContextHash") ||
      CASE WHEN cmd."delegatedUserId" IS NULL THEN '{}'::jsonb ELSE jsonb_build_object('delegatedUserId',cmd."delegatedUserId") END ||
      CASE WHEN cmd."actorDelegatedIdentityId" IS NULL THEN '{}'::jsonb ELSE jsonb_build_object('delegatedIdentityId',cmd."actorDelegatedIdentityId") END ||
      CASE WHEN cmd."actorWorkspaceRole" IS NULL THEN '{}'::jsonb ELSE jsonb_build_object('workspaceRole',cmd."actorWorkspaceRole") END)
    OR cmd."scopeJson"::jsonb IS DISTINCT FROM '{"project":true}'::jsonb OR NOT EXISTS(SELECT 1 FROM project_output_state_entries pe WHERE pe."stateId"=bs.id AND pe."variantId"=editorial_payload->>'variantId')
    OR editorial_payload->>'editPlanHash' IS DISTINCT FROM sp."contentHash" OR editorial_payload->>'sourceTranscriptId' IS DISTINCT FROM editorial_payload#>>'{sourceBinding,document,transcript,id}'
    OR editorial_payload->>'sourceArtifactId' IS DISTINCT FROM editorial_payload#>>'{sourceBinding,document,transcript,sourceArtifactId}'
    OR bp#>>'{retimedTranscript,sourceTranscriptId}' IS DISTINCT FROM editorial_payload->>'sourceTranscriptId'
    OR bp#>>'{retimedTranscript,sourceTranscriptHash}' IS DISTINCT FROM editorial_payload#>>'{sourceBinding,document,transcript,document,transcriptHash}' THEN
    RAISE EXCEPTION 'W66 editorial Command3 source/base/actor/variant differs' USING ERRCODE='23514';END IF;
   PERFORM w66_assert_editorial_binding_v1((cmd."outputPayloadJson"::json)->'sourceBinding',v."projectId",v."workspaceId",b.id,v.id);
   editorial_expected:=w66_editorial_plan_v1(bp,editorial_payload->'sourceBinding',cmd.id,v.id,pj->>'id',w66_v2_iso(v."createdAt"),editorial_payload->'exclusions');
   IF pj-ARRAY['audioTimelineHash'] IS DISTINCT FROM editorial_expected THEN RAISE EXCEPTION 'W66 editorial content/crop/cue/audio/overlay timing differs' USING ERRCODE='23514';END IF;
   audio:=editorial_payload->'audioProjection';
   IF bp ? 'audioTimelineHash' THEN
    SELECT jsonb_build_object('schemaVersion','editorial-audio-timeline/v1','fps',round((pj->>'fps')::numeric,6),'segments',jsonb_agg(jsonb_build_object(
     'artifactId',coalesce(c.element->>'audioSourceArtifactId',c.element->>'sourceArtifactId'),'audioSourceInFrame',coalesce(c.element->'audioSourceInFrame',c.element->'sourceInFrame'),
     'audioSourceOutFrame',coalesce(c.element->'audioSourceOutFrame',c.element->'sourceOutFrame'),'timelineInFrame',c.element->'timelineInFrame','timelineOutFrame',c.element->'timelineOutFrame','rate',c.element->'rate') ORDER BY t.ordinal,c.ordinal))
     INTO speech_body FROM jsonb_array_elements(pj->'videoTracks') WITH ORDINALITY AS t(element,ordinal) CROSS JOIN LATERAL jsonb_array_elements(t.element->'clips') WITH ORDINALITY AS c(element,ordinal) WHERE t.element->>'kind'='base-video';
    IF NOT w66_v2_exact_json(audio,ARRAY['schemaVersion','speechCanonicalJson','speechHash','mixedCanonicalJson']) OR audio->>'schemaVersion'<>'editorial-audio-projection/v1'
     OR (audio->>'speechCanonicalJson')::jsonb IS DISTINCT FROM speech_body OR w66_v2_sha(audio->>'speechCanonicalJson') IS DISTINCT FROM audio->>'speechHash' THEN
     RAISE EXCEPTION 'W66 editorial audio speech source/clock/text differs' USING ERRCODE='23514';END IF;
    IF pj->'audioTracks'='[]'::jsonb THEN
     IF audio->'mixedCanonicalJson' IS DISTINCT FROM 'null'::jsonb OR pj->>'audioTimelineHash' IS DISTINCT FROM audio->>'speechHash' THEN
      RAISE EXCEPTION 'W66 editorial speech hash differs' USING ERRCODE='23514';END IF;
    ELSIF (audio->>'mixedCanonicalJson')::jsonb IS DISTINCT FROM jsonb_build_object('schemaVersion','directed-audio-timeline/v1','speechHash',audio->>'speechHash','musicTracks',pj->'audioTracks')
     OR pj->>'audioTimelineHash' IS DISTINCT FROM w66_v2_sha(audio->>'mixedCanonicalJson') THEN
      RAISE EXCEPTION 'W66 editorial music mix hash differs' USING ERRCODE='23514';END IF;
   ELSIF audio IS DISTINCT FROM 'null'::jsonb OR pj ? 'audioTimelineHash' THEN RAISE EXCEPTION 'W66 editorial invented audio hash authority' USING ERRCODE='23514';END IF;
   IF editorial_payload#>>'{impact,schemaVersion}' IS DISTINCT FROM 'editorial-cut-impact/v2' OR editorial_payload#>>'{impact,commandId}' IS DISTINCT FROM cmd.id
    OR editorial_payload#>>'{impact,baseVersionId}' IS DISTINCT FROM b.id OR editorial_payload#>>'{impact,resultVersionId}' IS DISTINCT FROM v.id
    OR editorial_payload#>'{impact,affectedVariantIds}' IS DISTINCT FROM (SELECT jsonb_agg(pe."variantId" ORDER BY pe."variantId" COLLATE "C") FROM project_output_state_entries pe WHERE pe."stateId"=bs.id) THEN
    RAISE EXCEPTION 'W66 editorial exact sibling impact differs' USING ERRCODE='23514';END IF;
   PERFORM w66_assert_editorial_impact_v2(cmd,b,v,bs,bp,pj);
   expected_producer:=jsonb_build_object('schemaVersion','output-editorial-derived-producer/v1','canonicalPolicyVersion','output-canonical-json/v1','kind','editorial-cut-command',
    'commandId',cmd.id,'commandHash',cmd."commandHash",'payloadHash',cmd."outputPayloadHash",'target',NULL);
  ELSIF o->>'kind' IN ('create-output-variant','revise-output-spec') THEN
   IF cmd.type IS DISTINCT FROM o->>'kind' OR s.transition IS DISTINCT FROM (CASE cmd.type WHEN 'create-output-variant' THEN 'create-variant' ELSE 'revise-output' END)
    OR o#>'{result,command}' IS DISTINCT FROM cmd."commandJson"::jsonb||jsonb_build_object('commandHash',cmd."commandHash")
    OR o#>>'{result,requestFingerprint}' IS DISTINCT FROM cmd."requestFingerprint"
    OR pj-ARRAY['id','projectVersionId','createdAt'] IS DISTINCT FROM bp-ARRAY['id','projectVersionId','createdAt'] THEN
    RAISE EXCEPTION 'W66v3 output Command effect differs' USING ERRCODE='23514'; END IF;
   PERFORM w66_assert_revision_origin_v3(cmd,bs,s);
   expected_producer:=jsonb_build_object('schemaVersion','output-child-command-producer/v3','canonicalPolicyVersion','output-canonical-json/v1','kind',cmd.type,
    'commandId',cmd.id,'commandHash',cmd."commandHash",'requestFingerprint',cmd."requestFingerprint",'payloadHash',cmd."outputPayloadHash");
  ELSIF o->>'kind' IN ('inherit-command','restore-command') THEN
   IF cmd.type<>'manual-edit' OR cmd."actorType" IS DISTINCT FROM 'api-client' OR b."outputContractVersion"<>3 OR o->'command' IS DISTINCT FROM cmd."commandJson"::jsonb||jsonb_build_object('commandHash',cmd."commandHash")
    OR o->>'requestFingerprint' IS DISTINCT FROM cmd."requestFingerprint" OR o#>>'{audit,contextHash}' IS DISTINCT FROM cmd."actorContextHash" THEN
    RAISE EXCEPTION 'W66v3 manual origin authority differs' USING ERRCODE='23514'; END IF;
   manual_payload:=cmd."payloadJson"::jsonb;manual_impact:=manual_payload->'impact';
   IF NOT w66_v3_exact_keys(manual_payload,ARRAY['schemaVersion','action','expectedRevision','variantId','targetId','impact',
      CASE WHEN o->>'kind'='inherit-command' THEN 'operation' ELSE 'restoresVersionId' END])
    OR manual_payload->'schemaVersion' IS DISTINCT FROM '2'::jsonb OR manual_payload->'expectedRevision' IS DISTINCT FROM to_jsonb(b.sequence)
    OR cmd."scopeJson"::jsonb IS DISTINCT FROM jsonb_build_object('clipIds',jsonb_build_array(manual_payload->>'targetId'),
      'outputSpecIds',jsonb_build_array(manual_payload->>'variantId'))
    OR NOT EXISTS(SELECT 1 FROM project_output_state_entries pe WHERE pe."stateId"=bs.id AND pe."variantId"=manual_payload->>'variantId') THEN
    RAISE EXCEPTION 'W66v3 manual revision/variant/scope differs' USING ERRCODE='23514';END IF;
   IF o->>'kind'='inherit-command' THEN
    IF s.transition<>'inherit' OR cmd."payloadJson"::jsonb->>'action' IS DISTINCT FROM 'apply' OR cmd."payloadJson"::jsonb#>>'{operation,kind}' IS DISTINCT FROM 'select'
     OR cmd."payloadJson"::jsonb#>'{impact,renderSemanticsChanged}' IS DISTINCT FROM 'false'::jsonb
     OR NOT w66_v3_exact_keys(manual_payload->'operation',ARRAY['kind','clipId'])
     OR manual_payload#>>'{operation,clipId}' IS DISTINCT FROM manual_payload->>'targetId'
     OR NOT EXISTS(SELECT 1 FROM jsonb_array_elements(bp->'videoTracks') AS track_row(track_doc),
       LATERAL jsonb_array_elements(track_row.track_doc->'clips') AS clip_row(clip_doc) WHERE clip_row.clip_doc->>'id'=manual_payload->>'targetId') THEN
     RAISE EXCEPTION 'W66v3 inheritance requires real render-free selection' USING ERRCODE='23514'; END IF;
   ELSE
    SELECT * INTO STRICT target_v FROM project_versions WHERE id=o#>>'{target,versionId}' AND "projectId"=v."projectId" AND "workspaceId"=v."workspaceId" AND "outputContractVersion" IN (2,3);
    SELECT * INTO STRICT source_state FROM project_output_states WHERE id=target_v."outputStateId" AND "stateHash"=target_v."outputStateHash"
     AND "resultVersionId"=target_v.id AND "projectId"=target_v."projectId" AND "workspaceId"=target_v."workspaceId";
    SELECT x."contentJson"::jsonb INTO STRICT source_plan FROM project_snapshots x WHERE x.id=target_v."editPlanSnapshotId" AND x."projectId"=v."projectId" AND x."workspaceId"=v."workspaceId";
    IF s.transition<>'restore' OR NOT w66_v3_exact_keys(o->'target',ARRAY['versionId','baseHash','stateId','stateHash'])
     OR NOT(coalesce(manual_payload->>'action','')=ANY(ARRAY['restore','undo','redo'])) OR target_v."outputContractVersion"<>3 OR o#>>'{target,baseHash}' IS DISTINCT FROM target_v."baseHash" OR o#>>'{target,stateHash}' IS DISTINCT FROM source_state."stateHash"
     OR target_v.sequence>b.sequence OR (cmd."payloadJson"::jsonb->>'action'='undo' AND target_v.id IS DISTINCT FROM b."parentVersionId")
     OR o#>>'{target,stateId}' IS DISTINCT FROM source_state.id OR cmd."payloadJson"::jsonb->>'restoresVersionId' IS DISTINCT FROM target_v.id THEN
     RAISE EXCEPTION 'W66v3 restore exact target differs' USING ERRCODE='23514'; END IF;
   END IF;
   metadata:=jsonb_build_object('schemaVersion',1,'action',cmd."payloadJson"::jsonb->>'action','variantId',cmd."payloadJson"::jsonb->>'variantId')||
    CASE WHEN o->>'kind'='inherit-command' THEN jsonb_build_object('operation',cmd."payloadJson"::jsonb->'operation') ELSE jsonb_build_object('restoresVersionId',target_v.id) END;
   IF pj->'manualEditing' IS DISTINCT FROM metadata OR pj->>'id' IS DISTINCT FROM 'edit-plan-'||v.id
    OR pj-ARRAY['id','projectVersionId','createdAt','manualEditing'] IS DISTINCT FROM source_plan-ARRAY['id','projectVersionId','createdAt','manualEditing'] THEN
     RAISE EXCEPTION 'W66v3 real manual plan effect differs' USING ERRCODE='23514'; END IF;

   IF o->>'kind'='inherit-command' THEN
    -- Same union of before/after clip ranges as canonicalCommandImpactRanges.
    WITH ranges AS (
      SELECT (clip_row.clip_doc->>'timelineInFrame')::bigint AS start_frame,(clip_row.clip_doc->>'timelineOutFrame')::bigint AS end_frame
      FROM (VALUES (bp),(pj)) AS plan_row(plan_doc),LATERAL jsonb_array_elements(plan_row.plan_doc->'videoTracks') AS track_row(track_doc),
       LATERAL jsonb_array_elements(track_row.track_doc->'clips') AS clip_row(clip_doc)
      WHERE clip_row.clip_doc->>'id'=manual_payload->>'targetId' OR starts_with(clip_row.clip_doc->>'id',(manual_payload->>'targetId')||':')
    ), prior AS (SELECT *,max(end_frame) OVER(ORDER BY start_frame,end_frame ROWS BETWEEN UNBOUNDED PRECEDING AND 1 PRECEDING) AS previous_end FROM ranges),
    grouped AS (SELECT *,sum(CASE WHEN previous_end IS NULL OR start_frame>previous_end THEN 1 ELSE 0 END) OVER(ORDER BY start_frame,end_frame) AS group_id FROM prior),
    merged AS (SELECT min(start_frame) AS start_frame,max(end_frame) AS end_frame FROM grouped GROUP BY group_id)
    SELECT jsonb_agg(jsonb_build_object('startFrame',start_frame,'endFrame',end_frame) ORDER BY start_frame,end_frame) INTO impact_ranges FROM merged;
   ELSE impact_ranges:=jsonb_build_array(jsonb_build_object('startFrame',0,'endFrame',greatest((bp->>'durationFrames')::bigint,(pj->>'durationFrames')::bigint)));END IF;
   impact_body:=jsonb_build_object('schemaVersion','command-impact/v1','commandId',cmd.id,'commandType','manual-edit',
    'baseVersionId',b.id,'resultVersionId',v.id,'changeKinds',CASE WHEN o->>'kind'='inherit-command' THEN '["selection"]'::jsonb ELSE '["restore"]'::jsonb END,
    'dependencyTypes',CASE WHEN o->>'kind'='inherit-command' THEN '[]'::jsonb ELSE '["content","timing","visual","audio"]'::jsonb END,
    'affectedRanges',impact_ranges,'affectedVariantIds',CASE WHEN o->>'kind'='inherit-command' THEN '[]'::jsonb ELSE jsonb_build_array(manual_payload->>'variantId') END,
    'affectedArtifacts',CASE WHEN o->>'kind'='inherit-command' THEN '[]'::jsonb ELSE manual_impact->'affectedArtifacts' END,
    'minimalRenders',CASE WHEN o->>'kind'='inherit-command' THEN '[]'::jsonb ELSE jsonb_build_array(jsonb_build_object('kind','proxy','variantId',manual_payload->>'variantId','ranges',impact_ranges)) END,
    'renderSemanticsChanged',o->>'kind'='restore-command');
   -- Historical stableSerialize key order. JSON (not JSONB) preserves the raw
   -- array/object lexemes written by the real manual Command constructor.
   SELECT '{'||string_agg('"'||field_row.field_name||'":'||((cmd."payloadJson"::json->'impact')->field_row.field_name)::text,',' ORDER BY field_row.ordinal)||'}'
    INTO manual_impact_text FROM unnest(ARRAY['affectedArtifacts','affectedRanges','affectedVariantIds','baseVersionId','changeKinds','commandId',
      'commandType','dependencyTypes','minimalRenders','renderSemanticsChanged','resultVersionId','schemaVersion']) WITH ORDINALITY AS field_row(field_name,ordinal);
   IF impact_ranges IS NULL OR NOT w66_v3_exact_keys(manual_impact,ARRAY['schemaVersion','commandId','commandType','baseVersionId','resultVersionId',
    'changeKinds','dependencyTypes','affectedRanges','affectedVariantIds','affectedArtifacts','minimalRenders','renderSemanticsChanged','impactHash'])
    OR jsonb_typeof(manual_impact->'affectedArtifacts') IS DISTINCT FROM 'array'
    OR manual_impact-'impactHash' IS DISTINCT FROM impact_body OR manual_impact->>'impactHash' IS DISTINCT FROM w66_v2_sha(manual_impact_text) THEN
    RAISE EXCEPTION 'W66v3 manual impact differs from real effect' USING ERRCODE='23514';END IF;

   IF o->>'kind'='restore-command' THEN
    -- This is complete membership, not only a check of caller-supplied refs.
    -- Finals currently lack a stable variant fact; never infer it from format.
    IF EXISTS(SELECT 1 FROM project_final_export_operations fe JOIN public_operations po ON po.id=fe."operationId" AND po."workspaceId"=fe."workspaceId"
      WHERE fe."projectVersionId"=b.id AND fe."projectId"=v."projectId" AND fe."workspaceId"=v."workspaceId" AND po.status='succeeded') THEN
     RAISE EXCEPTION 'W66v3 restore final output lacks stable variant authority' USING ERRCODE='23514';END IF;
    IF EXISTS(SELECT 1 FROM project_proxy_render_operations pr JOIN public_operations po ON po.id=pr."operationId" AND po."workspaceId"=pr."workspaceId"
      WHERE pr."projectVersionId"=b.id AND pr."projectId"=v."projectId" AND pr."workspaceId"=v."workspaceId" AND po.status='succeeded'
      AND (pr."renderableVariantId" IS NULL OR pr."renderableVariantId"='')) THEN
     RAISE EXCEPTION 'W66v3 restore proxy output lacks stable variant binding' USING ERRCODE='23514';END IF;
    IF jsonb_array_length(manual_impact->'affectedArtifacts')<>(SELECT count(*) FROM project_proxy_render_operations pr
      JOIN public_operations po ON po.id=pr."operationId" AND po."workspaceId"=pr."workspaceId"
      WHERE pr."projectVersionId"=b.id AND pr."projectId"=v."projectId" AND pr."workspaceId"=v."workspaceId" AND po.status='succeeded'
       AND pr."renderableVariantId"=manual_payload->>'variantId')
     OR EXISTS(SELECT 1 FROM project_proxy_render_operations pr JOIN public_operations po ON po.id=pr."operationId" AND po."workspaceId"=pr."workspaceId"
      WHERE pr."projectVersionId"=b.id AND pr."projectId"=v."projectId" AND pr."workspaceId"=v."workspaceId" AND po.status='succeeded'
       AND pr."renderableVariantId"=manual_payload->>'variantId' AND NOT EXISTS(
        SELECT 1 FROM jsonb_array_elements(manual_impact->'affectedArtifacts') AS claimed_row(ref)
         WHERE claimed_row.ref=jsonb_build_object('artifactId',pr."outputArtifactId",'kind','proxy','sourceVersionId',b.id,'variantId',pr."renderableVariantId"))) THEN
     RAISE EXCEPTION 'W66v3 restore output membership differs' USING ERRCODE='23514';END IF;
   END IF;
   FOR affected_output IN SELECT artifact_row.ref FROM jsonb_array_elements(manual_impact->'affectedArtifacts') AS artifact_row(ref) LOOP
    IF NOT w66_v3_exact_keys(affected_output,ARRAY['artifactId','kind','sourceVersionId','variantId']) OR affected_output->>'kind'<>'proxy'
     OR affected_output->>'sourceVersionId' IS DISTINCT FROM b.id OR affected_output->>'variantId' IS DISTINCT FROM manual_payload->>'variantId'
     OR NOT EXISTS(SELECT 1 FROM project_proxy_render_operations pr JOIN public_operations po ON po.id=pr."operationId" AND po."workspaceId"=pr."workspaceId"
       WHERE pr."projectVersionId"=b.id AND pr."projectId"=v."projectId" AND pr."workspaceId"=v."workspaceId" AND po.status='succeeded'
       AND pr."outputArtifactId"=affected_output->>'artifactId' AND pr."renderableVariantId"=affected_output->>'variantId')
     OR NOT EXISTS(SELECT 1 FROM command_artifact_invalidations ai WHERE ai."commandId"=cmd.id AND ai."resultVersionId"=v.id AND ai."baseVersionId"=b.id
       AND ai."projectId"=v."projectId" AND ai."workspaceId"=v."workspaceId" AND ai."artifactId"=affected_output->>'artifactId' AND ai.kind=affected_output->>'kind'
       AND ai."variantId"=affected_output->>'variantId' AND ai.status='stale' AND ai."impactHash"=manual_impact->>'impactHash'
       AND ai."dependencyTypesJson"::jsonb=manual_impact->'dependencyTypes' AND ai."affectedRangesJson"::jsonb=impact_ranges AND ai."createdAt"=v."createdAt") THEN
     RAISE EXCEPTION 'W66v3 manual output/invalidation fact differs' USING ERRCODE='23514';END IF;
   END LOOP;
   IF (SELECT count(*) FROM command_artifact_invalidations ai WHERE ai."commandId"=cmd.id AND ai."workspaceId"=v."workspaceId")<>jsonb_array_length(manual_impact->'affectedArtifacts') THEN
    RAISE EXCEPTION 'W66v3 manual invalidation membership differs' USING ERRCODE='23514';END IF;
   IF EXISTS(SELECT 1 FROM jsonb_array_elements(d->'entries') AS child_entry(element)
    WHERE child_entry.element#>>'{consumption,status}'='materialized' AND (
      EXISTS(SELECT 1 FROM jsonb_array_elements(child_entry.element#>'{consumption,materialization,document,normalizations}') AS child_n(element)
       WHERE NOT EXISTS(SELECT 1 FROM jsonb_array_elements(source_state."stateJson"::jsonb->'entries') AS source_entry(element),
        LATERAL jsonb_array_elements(CASE WHEN source_entry.element#>>'{consumption,status}'='materialized' THEN source_entry.element#>'{consumption,materialization,document,normalizations}' ELSE '[]'::jsonb END) AS source_n(element)
        WHERE source_n.element=child_n.element)) OR
      EXISTS(SELECT 1 FROM jsonb_array_elements(source_state."stateJson"::jsonb->'entries') AS source_entry(element),
       LATERAL jsonb_array_elements(CASE WHEN source_entry.element#>>'{consumption,status}'='materialized' THEN source_entry.element#>'{consumption,materialization,document,normalizations}' ELSE '[]'::jsonb END) AS source_n(element)
       WHERE NOT EXISTS(SELECT 1 FROM jsonb_array_elements(child_entry.element#>'{consumption,materialization,document,normalizations}') AS child_n(element) WHERE child_n.element=source_n.element)))) THEN
    RAISE EXCEPTION 'W66v3 manual normalization lineage differs' USING ERRCODE='23514';END IF;
   expected_producer:=jsonb_build_object('schemaVersion','output-child-command-producer/v3','canonicalPolicyVersion','output-canonical-json/v1','kind',o->>'kind',
    'commandId',cmd.id,'commandHash',cmd."commandHash",'payloadHash',ob."producerPayloadHash",
    'target',CASE WHEN o->>'kind'='restore-command' THEN o->'target' ELSE 'null'::jsonb END);
  ELSE RAISE EXCEPTION 'W66v3 unsupported Command origin' USING ERRCODE='23514'; END IF;
 ELSE
  IF ob."producerPayloadJson" IS NOT NULL OR ob."producerPayloadHash" IS NOT NULL OR s.transition<>'ingest' OR o->>'kind'<>'ingest-operation' OR v."commandId" IS NOT NULL OR b."outputContractVersion"<>3
   OR o#>>'{operation,id}' IS DISTINCT FROM s."producerId" OR o->>'requestFingerprint' IS DISTINCT FROM s."provenanceHash"
   OR o#>>'{detail,sourceArtifactId}' IS DISTINCT FROM s."ingestSourceArtifactId" OR o#>>'{detail,sourceManifestId}' IS DISTINCT FROM s."ingestSourceManifestId" THEN
   RAISE EXCEPTION 'W66v3 ingest requires explicit variant and actual origin' USING ERRCODE='23514'; END IF;
  SELECT * INTO STRICT operation_row FROM public_operations WHERE id=s."producerId" AND "projectId"=v."projectId" AND "workspaceId"=v."workspaceId" AND type='media-ingest';
  SELECT * INTO STRICT detail_row FROM media_ingest_operations WHERE "operationId"=operation_row.id AND "projectId"=v."projectId" AND "workspaceId"=v."workspaceId";
  IF operation_row."clientId" IS DISTINCT FROM v."createdBy" OR operation_row."requestFingerprint" IS DISTINCT FROM s."provenanceHash"
  OR o#>>'{operation,schemaVersion}' IS DISTINCT FROM 'public-operation/v1' OR o#>>'{operation,type}' IS DISTINCT FROM operation_row.type
  OR o#>>'{operation,status}' IS DISTINCT FROM 'running' OR o#>>'{operation,phase}' IS DISTINCT FROM 'persisting'
  OR o#>>'{operation,clientId}' IS DISTINCT FROM operation_row."clientId" OR o#>>'{operation,workspaceId}' IS DISTINCT FROM operation_row."workspaceId"
  OR o#>>'{operation,projectId}' IS DISTINCT FROM operation_row."projectId" OR (o#>>'{operation,attempt}')::integer<>operation_row.attempt
  OR (o#>>'{operation,maxAttempts}')::integer<>operation_row."maxAttempts" OR o#>>'{operation,createdAt}' IS DISTINCT FROM w66_v2_iso(operation_row."createdAt")
  OR o#>'{operation,target}' IS DISTINCT FROM jsonb_build_object('type','media-artifact','id',detail_row."sourceArtifactId",'manifestId',detail_row."sourceManifestId")
  OR o#>'{operation,progress}' IS DISTINCT FROM '{"completed":5,"total":6,"unit":"stage"}'::jsonb
  OR o#>>'{detail,uploadId}' IS DISTINCT FROM detail_row."uploadId"::text OR o#>>'{detail,sourceArtifactId}' IS DISTINCT FROM detail_row."sourceArtifactId"
  OR o#>>'{detail,sourceManifestId}' IS DISTINCT FROM detail_row."sourceManifestId" THEN
   RAISE EXCEPTION 'W66v3 ingest factual operation/detail/actor differs' USING ERRCODE='23514';END IF;
  SELECT * INTO STRICT tr FROM media_transcripts WHERE id=s."ingestTranscriptId" AND "projectId"=v."projectId" AND "workspaceId"=v."workspaceId"
   AND "sourceArtifactId"=s."ingestSourceArtifactId" AND "sourceManifestId"=s."ingestSourceManifestId" AND "transcriptHash"=s."ingestTranscriptHash";
  IF o#>'{transcript,document}' IS DISTINCT FROM tr."transcriptJson"::jsonb OR o#>>'{transcript,id}' IS DISTINCT FROM tr.id THEN
   RAISE EXCEPTION 'W66v3 ingest transcript factual origin differs' USING ERRCODE='23514'; END IF;
  expected_producer:=jsonb_build_object('schemaVersion','output-ingest-producer/v3','canonicalPolicyVersion','output-canonical-json/v1','operationId',s."producerId",
   'requestFingerprint',s."provenanceHash",'attempt',(o#>>'{operation,attempt}')::integer,'leaseOwner',o->>'leaseOwner','uploadId',o#>>'{detail,uploadId}',
   'sourceArtifactId',s."ingestSourceArtifactId",'sourceManifestId',s."ingestSourceManifestId",'transcriptId',tr.id,'transcriptHash',tr."transcriptHash");
 END IF;
 IF v."briefSnapshotId" IS DISTINCT FROM (CASE WHEN s.transition='restore' THEN target_v."briefSnapshotId" ELSE b."briefSnapshotId" END)
 OR v."policiesSnapshotId" IS DISTINCT FROM (CASE WHEN s.transition='restore' THEN target_v."policiesSnapshotId" ELSE b."policiesSnapshotId" END)
 OR v."treatmentSnapshotId" IS DISTINCT FROM (CASE WHEN s.transition='restore' THEN target_v."treatmentSnapshotId" ELSE b."treatmentSnapshotId" END)
 OR v."storySnapshotId" IS DISTINCT FROM (CASE WHEN s.transition='restore' THEN target_v."storySnapshotId" ELSE b."storySnapshotId" END)
 OR NOT EXISTS(SELECT 1 FROM project_snapshots sx WHERE sx.id=v."briefSnapshotId" AND sx."projectId"=v."projectId" AND sx."workspaceId"=v."workspaceId" AND sx.kind='brief')
 OR NOT EXISTS(SELECT 1 FROM project_snapshots sx WHERE sx.id=v."policiesSnapshotId" AND sx."projectId"=v."projectId" AND sx."workspaceId"=v."workspaceId" AND sx.kind='policies') THEN
  RAISE EXCEPTION 'W66v3 non-output snapshot effect outside origin' USING ERRCODE='23514';END IF;
 -- Every untouched member retains the exact revision/spec; consumption receives
 -- fresh result geometry, never copied acceptance or output identities.
 IF EXISTS(SELECT 1 FROM jsonb_array_elements(source_state."stateJson"::jsonb->'entries') AS prior(element)
  WHERE (o->>'kind' NOT IN ('create-output-variant','revise-output-spec') OR prior.element->>'variantId' IS DISTINCT FROM cmd."payloadJson"::jsonb->>'variantId')
   AND NOT EXISTS(SELECT 1 FROM jsonb_array_elements(d->'entries') AS next_member(element)
    WHERE next_member.element-ARRAY['consumption'] IS NOT DISTINCT FROM prior.element-ARRAY['consumption']))
 OR EXISTS(SELECT 1 FROM jsonb_array_elements(d->'entries') AS next_member(element)
  WHERE (o->>'kind' NOT IN ('create-output-variant','revise-output-spec') OR next_member.element->>'variantId' IS DISTINCT FROM cmd."payloadJson"::jsonb->>'variantId')
   AND NOT EXISTS(SELECT 1 FROM jsonb_array_elements(source_state."stateJson"::jsonb->'entries') AS prior(element)
    WHERE prior.element-ARRAY['consumption'] IS NOT DISTINCT FROM next_member.element-ARRAY['consumption'])) THEN
  RAISE EXCEPTION 'W66v3 hidden sibling membership/revision change' USING ERRCODE='23514';END IF;
 IF s."producerJson"::jsonb IS DISTINCT FROM expected_producer THEN RAISE EXCEPTION 'W66v3 typed producer differs' USING ERRCODE='23514'; END IF;
 IF d->'overlays' IS DISTINCT FROM source_state."stateJson"::jsonb->'overlays' OR d->'invalidations' IS DISTINCT FROM source_state."stateJson"::jsonb->'invalidations'
 OR d->'sourceDependencies' IS DISTINCT FROM source_state."stateJson"::jsonb->'sourceDependencies' THEN
  RAISE EXCEPTION 'W66v3 hidden overlay/invalidation/source dependency effect' USING ERRCODE='23514'; END IF;
 IF s."consumptionStatus" IS DISTINCT FROM (CASE WHEN EXISTS(SELECT 1 FROM jsonb_array_elements(d->'entries') AS ei(element) WHERE ei.element#>>'{consumption,status}'='materialized') THEN 'materialized' ELSE 'blocked' END)
 OR s."consumptionJson"::jsonb IS DISTINCT FROM jsonb_build_object('schemaVersion','output-consumption/v3','canonicalPolicyVersion',s."canonicalPolicyVersion",'status',s."consumptionStatus") THEN
  RAISE EXCEPTION 'W66v3 persisted consumption discriminant differs' USING ERRCODE='23514';END IF;
 IF jsonb_array_length(d->'entries')=0 OR jsonb_array_length(d->'entries')<>(SELECT count(*) FROM project_output_state_entries pe WHERE pe."stateId"=s.id) THEN
  RAISE EXCEPTION 'W66v3 explicit entry membership required' USING ERRCODE='23514'; END IF;
 FOR entry_record IN SELECT ei.element FROM jsonb_array_elements(d->'entries') AS ei(element) LOOP
  SELECT * INTO STRICT e FROM project_output_state_entries WHERE "stateId"=s.id AND "variantId"=entry_record.element->>'variantId';
  SELECT * INTO STRICT re FROM output_spec_revisions WHERE id=e."outputSpecRevisionId" AND "variantId"=e."variantId" AND "projectId"=v."projectId" AND "workspaceId"=v."workspaceId" AND "specHash"=e."specHash";
  IF e."canonicalPolicyVersion"<>'output-canonical-json/v1' OR re."canonicalPolicyVersion"<>'output-canonical-json/v1'
   OR e."entryJson"::jsonb IS DISTINCT FROM entry_record.element OR e."entryHash" IS DISTINCT FROM w66_v2_sha(e."entryJson")
   OR entry_record.element->>'outputSpecRevisionId' IS DISTINCT FROM re.id OR entry_record.element->>'specHash' IS DISTINCT FROM re."specHash"
   OR entry_record.element->'spec' IS DISTINCT FROM re."specJson"::jsonb OR re."specHash" IS DISTINCT FROM w66_v2_sha(re."specJson") THEN
   RAISE EXCEPTION 'W66v3 entry/revision columns/policy/seals differ' USING ERRCODE='23514'; END IF;
  IF entry_record.element#>>'{consumption,status}'='materialized' THEN
   SELECT * INTO STRICT m FROM output_materializations WHERE id=e."materializationId" AND "materializationHash"=e."geometryProjectionHash"
    AND "resultVersionId"=v.id AND "variantId"=e."variantId" AND "projectId"=v."projectId" AND "workspaceId"=v."workspaceId";
   IF e."geometryStatus"<>'materialized-v3' OR entry_record.element#>'{consumption,materialization}' IS DISTINCT FROM
    jsonb_build_object('document',m."materializationJson"::jsonb,'materializationHash',m."materializationHash") THEN
    RAISE EXCEPTION 'W66v3 entry materialization binding differs' USING ERRCODE='23514'; END IF;
   IF m."materializationJson"::jsonb->>'schemaVersion' IS DISTINCT FROM 'editorial-derived-materialization/v1' OR
    m."materializationJson"::jsonb->'sourceBinding' IS DISTINCT FROM editorial_payload->'sourceBinding' THEN
    RAISE EXCEPTION 'W66 editorial entry must own its exact derived materialization' USING ERRCODE='23514';END IF;
   PERFORM w66_assert_materialization_v3(m.id,v."projectId",v."workspaceId");
  ELSE
   IF e."geometryStatus"<>'blocked-v3' OR e."materializationId" IS NOT NULL OR e."geometryProjectionHash" IS NOT NULL
    OR entry_record.element#>>'{consumption,status}' IS DISTINCT FROM 'blocked' OR entry_record.element#>'{consumption,reasons}' IS DISTINCT FROM '["empty-project"]'::jsonb
    OR (pj->>'durationFrames')::bigint<>0 THEN RAISE EXCEPTION 'W66v3 blocked consumption differs' USING ERRCODE='23514'; END IF;
  END IF;
 END LOOP;
EXCEPTION WHEN no_data_found OR too_many_rows THEN RAISE EXCEPTION 'W66v3 reciprocal bundle missing/ambiguous at COMMIT' USING ERRCODE='23514';
END $$;

CREATE FUNCTION w66_assert_operational_state_v3(p_state text) RETURNS void LANGUAGE plpgsql AS $$
DECLARE origin_kind text;BEGIN
 SELECT "originJson"::jsonb->>'kind' INTO STRICT origin_kind FROM output_operational_bundles WHERE "stateId"=p_state;
 IF origin_kind='editorial-cut-command' THEN PERFORM w66_assert_editorial_state_v1(p_state);
 ELSE PERFORM w66_assert_operational_state_v3_historical(p_state);END IF;
END $$;
