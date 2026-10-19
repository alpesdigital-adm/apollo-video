-- Plan-editing Commands make the renders of EVERY output of a project stale.
--
-- A manual edit, a review patch and an editorial cut change the ONE EditPlan every output of a project re-materializes from. The
-- database guards that re-derive the impact of a manual restore/undo/redo and of an editorial cut from the rows of the base Version
-- were written for a project with one output: they listed only the Command's view variant as affected, attributed only PROXY renders
-- to it by renderableVariantId and refused any published final export. The renders now name the output they were made for
-- (outputVariantId, migration 20261017160000), so the guards derive the impact the way the application does:
--   * affectedVariantIds / minimalRenders: every output of the base State (a restore; the editorial guard already did);
--   * affectedArtifacts: every succeeded proxy render AND final export of the base Version, attributed to its own output by
--     w66_version_render_references; a render that cannot be attributed exactly (a legacy row in a Version with several outputs) is refused.
-- Nothing else in the guards changes. The bodies below are the previous ones with only these parts replaced.

-- The renders (succeeded proxy renders and final exports) of ONE Version, each attributed to the output of the Version's State it was
-- made for, as the objects a Command impact lists them. Exactly the attribution the application makes (renderOutputReferences):
--   * a render that states its output (outputVariantId) names it, and that output must be an entry of the State;
--   * a FINAL written before the column existed names only its aspect ratio, which must be the ratio of exactly one entry;
--   * a PROXY written before the column existed names nothing: it belongs to the State's only output, and to none of several.
-- Anything else cannot be attributed exactly and is refused, because attributing a render to the wrong output would stale the wrong one.
CREATE FUNCTION w66_version_render_references(p_state jsonb,p_version text,p_project text,p_workspace text) RETURNS jsonb LANGUAGE plpgsql STABLE AS $$
DECLARE entry_count integer;references_found jsonb:='[]'::jsonb;render_row record;attributed text;matches integer;
BEGIN
 SELECT count(*) INTO entry_count FROM jsonb_array_elements(p_state->'entries');
 FOR render_row IN
  SELECT 'proxy'::text AS kind,pr."outputArtifactId" AS artifact_id,pr."outputVariantId" AS variant_id,NULL::text AS ratio
   FROM project_proxy_render_operations pr JOIN public_operations po ON po.id=pr."operationId" AND po."workspaceId"=pr."workspaceId"
   WHERE pr."projectVersionId"=p_version AND pr."projectId"=p_project AND pr."workspaceId"=p_workspace AND po.status='succeeded'
  UNION ALL
  SELECT 'final'::text,fe."outputArtifactId",fe."outputVariantId",fe."outputAspectRatio"
   FROM project_final_export_operations fe JOIN public_operations po ON po.id=fe."operationId" AND po."workspaceId"=fe."workspaceId"
   WHERE fe."projectVersionId"=p_version AND fe."projectId"=p_project AND fe."workspaceId"=p_workspace AND po.status='succeeded'
 LOOP
  IF render_row.variant_id IS NOT NULL THEN
   IF NOT EXISTS(SELECT 1 FROM jsonb_array_elements(p_state->'entries') AS state_entry(element) WHERE state_entry.element->>'variantId'=render_row.variant_id) THEN
    RAISE EXCEPTION 'W66 render names an output its Version does not carry' USING ERRCODE='23514';END IF;
   attributed:=render_row.variant_id;
  ELSIF render_row.kind='final' THEN
   SELECT count(*),min(state_entry.element->>'variantId') INTO matches,attributed FROM jsonb_array_elements(p_state->'entries') AS state_entry(element)
    WHERE coalesce(state_entry.element#>>'{spec,output,aspectRatio}',state_entry.element#>>'{spec,effectiveSpec,output,aspectRatio}')=render_row.ratio;
   IF matches<>1 THEN RAISE EXCEPTION 'W66 final export without a stated output matches no single output of its Version' USING ERRCODE='23514';END IF;
  ELSE
   IF entry_count<>1 THEN RAISE EXCEPTION 'W66 proxy render without a stated output cannot be attributed in a Version with several outputs' USING ERRCODE='23514';END IF;
   SELECT state_entry.element->>'variantId' INTO attributed FROM jsonb_array_elements(p_state->'entries') AS state_entry(element);
  END IF;
  references_found:=references_found||jsonb_build_array(jsonb_build_object('artifactId',render_row.artifact_id,'kind',render_row.kind,'sourceVersionId',p_version,'variantId',attributed));
 END LOOP;
 RETURN references_found;
END $$;

CREATE OR REPLACE FUNCTION w66_assert_operational_state_v3_historical(p_state text) RETURNS void LANGUAGE plpgsql AS $$
DECLARE s project_output_states%ROWTYPE;v project_versions%ROWTYPE;b project_versions%ROWTYPE;bs project_output_states%ROWTYPE;
 ob output_operational_bundles%ROWTYPE;d jsonb;o jsonb;pj jsonb;sp project_snapshots%ROWTYPE;bp jsonb;cmd edit_commands%ROWTYPE;entry_record record;
 e project_output_state_entries%ROWTYPE;re output_spec_revisions%ROWTYPE;m output_materializations%ROWTYPE;expected_version jsonb;target_v project_versions%ROWTYPE;
 source_state project_output_states%ROWTYPE;root_state text;project_row projects%ROWTYPE;source_plan jsonb;expected_producer jsonb;metadata jsonb;tr media_transcripts%ROWTYPE;operation_row public_operations%ROWTYPE;detail_row media_ingest_operations%ROWTYPE;manual_payload jsonb;manual_impact jsonb;impact_ranges jsonb;impact_body jsonb;manual_impact_text text;affected_output jsonb;actual_references jsonb;
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
 IF b."outputContractVersion"=2 AND (bs.transition IS DISTINCT FROM 'initialize-empty' OR s.transition IS DISTINCT FROM 'create-variant') THEN
  RAISE EXCEPTION 'W66v3 Fork2 target authority remains blocked' USING ERRCODE='23514';END IF;
 SELECT x."contentJson"::jsonb INTO STRICT bp FROM project_snapshots x WHERE x.id=b."editPlanSnapshotId" AND x."projectId"=b."projectId" AND x."workspaceId"=b."workspaceId";
 IF d->>'schemaVersion' IS DISTINCT FROM 'project-output-state/v3' OR d->>'canonicalPolicyVersion' IS DISTINCT FROM s."canonicalPolicyVersion"
 OR d->>'transitionPolicyVersion' IS DISTINCT FROM s."transitionPolicyVersion" OR s."canonicalPolicyVersion"<>'output-canonical-json/v1' OR s."transitionPolicyVersion"<>'project-output-transition/v3'
 OR s.transition NOT IN ('create-variant','revise-output','ingest','inherit','restore')
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
  IF o->>'kind' IN ('create-output-variant','revise-output-spec') THEN
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
    'affectedRanges',impact_ranges,'affectedVariantIds',CASE WHEN o->>'kind'='inherit-command' THEN '[]'::jsonb ELSE
     (SELECT jsonb_agg(pe."variantId" ORDER BY pe."variantId" COLLATE "C") FROM project_output_state_entries pe WHERE pe."stateId"=bs.id) END,
    'affectedArtifacts',CASE WHEN o->>'kind'='inherit-command' THEN '[]'::jsonb ELSE manual_impact->'affectedArtifacts' END,
    'minimalRenders',CASE WHEN o->>'kind'='inherit-command' THEN '[]'::jsonb ELSE
     (SELECT jsonb_agg(jsonb_build_object('kind','proxy','variantId',pe."variantId",'ranges',impact_ranges) ORDER BY pe."variantId" COLLATE "C")
      FROM project_output_state_entries pe WHERE pe."stateId"=bs.id) END,
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
    -- A restore returns the plan to an earlier one, and the plan is shared by every output: the renders of EVERY output of the base
    -- Version go stale, proxies and published finals alike. Complete membership, each render attributed to its own output by the
    -- stable variant it was enqueued with (w66_version_render_references refuses a render it cannot attribute exactly).
    actual_references:=w66_version_render_references(bs."stateJson"::jsonb,b.id,v."projectId",v."workspaceId");
    IF jsonb_array_length(manual_impact->'affectedArtifacts')<>jsonb_array_length(actual_references)
     OR EXISTS(SELECT 1 FROM jsonb_array_elements(actual_references) AS actual_row(ref)
      WHERE NOT EXISTS(SELECT 1 FROM jsonb_array_elements(manual_impact->'affectedArtifacts') AS claimed_row(ref) WHERE claimed_row.ref=actual_row.ref)) THEN
     RAISE EXCEPTION 'W66v3 restore output membership differs' USING ERRCODE='23514';END IF;
   END IF;
   FOR affected_output IN SELECT artifact_row.ref FROM jsonb_array_elements(manual_impact->'affectedArtifacts') AS artifact_row(ref) LOOP
    IF NOT w66_v3_exact_keys(affected_output,ARRAY['artifactId','kind','sourceVersionId','variantId']) OR affected_output->>'kind' NOT IN ('proxy','final')
     OR affected_output->>'sourceVersionId' IS DISTINCT FROM b.id
     OR NOT EXISTS(SELECT 1 FROM jsonb_array_elements(actual_references) AS actual_row(ref) WHERE actual_row.ref=affected_output)
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
   PERFORM w66_assert_materialization_v3(m.id,v."projectId",v."workspaceId");
  ELSE
   IF e."geometryStatus"<>'blocked-v3' OR e."materializationId" IS NOT NULL OR e."geometryProjectionHash" IS NOT NULL
    OR entry_record.element#>>'{consumption,status}' IS DISTINCT FROM 'blocked' OR entry_record.element#>'{consumption,reasons}' IS DISTINCT FROM '["empty-project"]'::jsonb
    OR (pj->>'durationFrames')::bigint<>0 THEN RAISE EXCEPTION 'W66v3 blocked consumption differs' USING ERRCODE='23514'; END IF;
  END IF;
 END LOOP;
EXCEPTION WHEN no_data_found OR too_many_rows THEN RAISE EXCEPTION 'W66v3 reciprocal bundle missing/ambiguous at COMMIT' USING ERRCODE='23514';
END $$;

CREATE OR REPLACE FUNCTION w66_assert_editorial_impact_v2(cmd edit_commands,b project_versions,v project_versions,bs project_output_states,bp jsonb,pj jsonb) RETURNS void LANGUAGE plpgsql AS $$
DECLARE payload jsonb:=cmd."outputPayloadJson"::jsonb;impact jsonb:=payload->'impact';expected jsonb;ranges jsonb;outputs jsonb;variants jsonb;raw_body text;affected record;ai command_artifact_invalidations%ROWTYPE;identity_text text;
BEGIN
 SELECT jsonb_agg(pe."variantId" ORDER BY pe."variantId" COLLATE "C") INTO variants FROM project_output_state_entries pe WHERE pe."stateId"=bs.id;
 ranges:=jsonb_build_array(jsonb_build_object('startFrame',0,'endFrame',greatest((bp->>'durationFrames')::bigint,(pj->>'durationFrames')::bigint)));
 -- The cut changes the shared plan: the renders of EVERY output of the base Version go stale, proxies and published finals alike, each
 -- attributed to its own output (w66_version_render_references refuses a render it cannot attribute exactly). Sorted as the Command lists
 -- them: by kind and artifact, byte order.
 SELECT coalesce(jsonb_agg(r.ref ORDER BY ((r.ref->>'kind')||':'||(r.ref->>'artifactId')) COLLATE "C"),'[]'::jsonb) INTO outputs
  FROM jsonb_array_elements(w66_version_render_references(bs."stateJson"::jsonb,b.id,v."projectId",v."workspaceId")) AS r(ref);
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
   AND "artifactId"=affected.element->>'artifactId' AND kind=affected.element->>'kind' AND "variantId"=affected.element->>'variantId';
  IF ai.status<>'stale' OR ai."impactHash" IS DISTINCT FROM impact->>'impactHash' OR ai."dependencyTypesJson"::jsonb IS DISTINCT FROM impact->'dependencyTypes' OR
   ai."affectedRangesJson"::jsonb IS DISTINCT FROM ranges OR ai."createdAt" IS DISTINCT FROM v."createdAt" THEN RAISE EXCEPTION 'W66 editorial invalidation fact differs' USING ERRCODE='23514';END IF;
  identity_text:='{"affectedRanges":'||((cmd."outputPayloadJson"::json->'impact')->'affectedRanges')::text||',"artifactId":'||to_json(ai."artifactId")::text||
   ',"baseVersionId":'||to_json(b.id)::text||',"commandId":'||to_json(cmd.id)::text||',"createdAt":'||to_json(w66_v2_iso(v."createdAt"))::text||
   ',"dependencyTypes":'||((cmd."outputPayloadJson"::json->'impact')->'dependencyTypes')::text||',"impactHash":'||to_json(impact->>'impactHash')::text||
   ',"kind":'||to_json(ai.kind)::text||',"resultVersionId":'||to_json(v.id)::text||',"schemaVersion":"command-artifact-invalidation/v1","status":"stale","variantId":'||to_json(ai."variantId")::text||'}';
  IF ai.id IS DISTINCT FROM w66_v2_sha(identity_text) THEN RAISE EXCEPTION 'W66 editorial invalidation identity seal differs' USING ERRCODE='23514';END IF;
 END LOOP;
 IF (SELECT count(*) FROM command_artifact_invalidations WHERE "commandId"=cmd.id AND "workspaceId"=v."workspaceId")<>jsonb_array_length(outputs) THEN
  RAISE EXCEPTION 'W66 editorial invalidation membership differs' USING ERRCODE='23514';END IF;
EXCEPTION WHEN no_data_found OR too_many_rows THEN RAISE EXCEPTION 'W66 editorial invalidation membership missing/ambiguous' USING ERRCODE='23514';
END $$;
