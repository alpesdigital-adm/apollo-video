-- W70 readiness (cost of the integrity assertions, second part). The operational State of a project embeds the normalization receipts of its sources
-- (a 103 s master is a 3.5 MB receipt, a 4.4 MB State), and the assertions that prove a State read those documents as text and parsed them again for
-- every sub-expression: the bundle five times, the parent State up to twelve times, the materialization three times. About thirty parses and deep
-- comparisons of megabytes made one verification cost 2 to 4 seconds, twice per commit (the deferred flush and the explicit verification), so a
-- cut of the real master met the 10 s statement budget of the commit on any machine that was not idle.
--
-- Nothing is weakened: every guard below is the guard it was, over the same values. Three kinds of change, each local to one function:
--   * a document read from a row is parsed ONCE, into a variable assigned right after the row is read (`ob_bundle`, `bs_doc`, `source_doc`, `m_doc`),
--     and the expressions that cast the same text again read the variable. The text and the cast are the same; only the repetition is gone;
--   * `w66_assert_editorial_binding_v1` reads the receipt inventory of the source State once into a small array (id, receiptHash) and checks the
--     declared references against that array instead of walking the megabytes again for each reference: the same set, the same two comparisons;
--   * `w66_assert_normalization_v3` keeps the verdict of a receipt for the same receipt, in the same statement, with the same number of rows written
--     by the transaction, exactly the rule `w66_assert_operational_state_v3` uses for a State. A refused check raises, so no refusal is remembered.
-- The functions are replaced in place with their current bodies (taken from the database the earlier migrations build); signatures are unchanged.

CREATE OR REPLACE FUNCTION w66_assert_editorial_state_v1(p_state text) RETURNS void LANGUAGE plpgsql AS $$
DECLARE ob_bundle jsonb;source_doc jsonb;m_doc jsonb; s project_output_states%ROWTYPE;v project_versions%ROWTYPE;b project_versions%ROWTYPE;bs project_output_states%ROWTYPE;
 ob output_operational_bundles%ROWTYPE;d jsonb;o jsonb;pj jsonb;sp project_snapshots%ROWTYPE;bp jsonb;cmd edit_commands%ROWTYPE;entry_record record;
 e project_output_state_entries%ROWTYPE;re output_spec_revisions%ROWTYPE;m output_materializations%ROWTYPE;expected_version jsonb;target_v project_versions%ROWTYPE;
 source_state project_output_states%ROWTYPE;root_state text;project_row projects%ROWTYPE;source_plan jsonb;expected_producer jsonb;metadata jsonb;tr media_transcripts%ROWTYPE;operation_row public_operations%ROWTYPE;detail_row media_ingest_operations%ROWTYPE;manual_payload jsonb;manual_impact jsonb;impact_ranges jsonb;impact_body jsonb;manual_impact_text text;affected_output jsonb;editorial_payload jsonb;editorial_expected jsonb;audio jsonb;speech_body jsonb;
BEGIN
 SELECT * INTO STRICT s FROM project_output_states WHERE id=p_state AND "schemaVersion"='project-output-state/v3';
 SELECT * INTO STRICT v FROM project_versions WHERE id=s."resultVersionId" AND "workspaceId"=s."workspaceId" AND "projectId"=s."projectId" AND "outputContractVersion"=3;
 SELECT * INTO STRICT b FROM project_versions WHERE id=s."parentVersionId" AND "workspaceId"=s."workspaceId" AND "projectId"=s."projectId" AND "outputContractVersion" IN (2,3);
 SELECT * INTO STRICT bs FROM project_output_states WHERE id=b."outputStateId" AND "resultVersionId"=b.id AND "stateHash"=b."outputStateHash" AND "workspaceId"=b."workspaceId" AND "projectId"=b."projectId";
 SELECT * INTO STRICT ob FROM output_operational_bundles WHERE "versionId"=v.id AND "stateId"=s.id AND "workspaceId"=v."workspaceId" AND "projectId"=v."projectId";
 ob_bundle:=ob."bundleJson"::jsonb;
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
 OR v."baseHash" IS DISTINCT FROM w66_v2_sha(v."outputBaseHashJson") OR ob_bundle->>'schemaVersion' IS DISTINCT FROM 'operational-output-version-bundle/v3'
 OR ob_bundle->'version' IS DISTINCT FROM expected_version OR ob_bundle->'state' IS DISTINCT FROM jsonb_build_object('document',d,'stateHash',s."stateHash")
 OR ob_bundle->'origin' IS DISTINCT FROM o OR ob_bundle->>'outputBaseHashJson' IS DISTINCT FROM v."outputBaseHashJson" THEN
  RAISE EXCEPTION 'W66v3 bundle/base hash authority differs' USING ERRCODE='23514'; END IF;
 PERFORM w66_assert_provenance(s."producerKind",s."producerId",s."provenanceHash",s."projectId",s."workspaceId",v.id);
 source_state:=bs;source_doc:=bs."stateJson"::jsonb;source_plan:=bp;
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
    source_doc:=source_state."stateJson"::jsonb;
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
       WHERE NOT EXISTS(SELECT 1 FROM jsonb_array_elements(source_doc->'entries') AS source_entry(element),
        LATERAL jsonb_array_elements(CASE WHEN source_entry.element#>>'{consumption,status}'='materialized' THEN source_entry.element#>'{consumption,materialization,document,normalizations}' ELSE '[]'::jsonb END) AS source_n(element)
        WHERE source_n.element=child_n.element)) OR
      EXISTS(SELECT 1 FROM jsonb_array_elements(source_doc->'entries') AS source_entry(element),
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
 IF EXISTS(SELECT 1 FROM jsonb_array_elements(source_doc->'entries') AS prior(element)
  WHERE (o->>'kind' NOT IN ('create-output-variant','revise-output-spec') OR prior.element->>'variantId' IS DISTINCT FROM cmd."payloadJson"::jsonb->>'variantId')
   AND NOT EXISTS(SELECT 1 FROM jsonb_array_elements(d->'entries') AS next_member(element)
    WHERE next_member.element-ARRAY['consumption'] IS NOT DISTINCT FROM prior.element-ARRAY['consumption']))
 OR EXISTS(SELECT 1 FROM jsonb_array_elements(d->'entries') AS next_member(element)
  WHERE (o->>'kind' NOT IN ('create-output-variant','revise-output-spec') OR next_member.element->>'variantId' IS DISTINCT FROM cmd."payloadJson"::jsonb->>'variantId')
   AND NOT EXISTS(SELECT 1 FROM jsonb_array_elements(source_doc->'entries') AS prior(element)
    WHERE prior.element-ARRAY['consumption'] IS NOT DISTINCT FROM next_member.element-ARRAY['consumption'])) THEN
  RAISE EXCEPTION 'W66v3 hidden sibling membership/revision change' USING ERRCODE='23514';END IF;
 IF s."producerJson"::jsonb IS DISTINCT FROM expected_producer THEN RAISE EXCEPTION 'W66v3 typed producer differs' USING ERRCODE='23514'; END IF;
 IF d->'overlays' IS DISTINCT FROM source_doc->'overlays' OR d->'invalidations' IS DISTINCT FROM source_doc->'invalidations'
 OR d->'sourceDependencies' IS DISTINCT FROM source_doc->'sourceDependencies' THEN
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
   m_doc:=m."materializationJson"::jsonb;
   IF e."geometryStatus"<>'materialized-v3' OR entry_record.element#>'{consumption,materialization}' IS DISTINCT FROM
    jsonb_build_object('document',m_doc,'materializationHash',m."materializationHash") THEN
    RAISE EXCEPTION 'W66v3 entry materialization binding differs' USING ERRCODE='23514'; END IF;
   IF m_doc->>'schemaVersion' IS DISTINCT FROM 'editorial-derived-materialization/v1' OR
    m_doc->'sourceBinding' IS DISTINCT FROM editorial_payload->'sourceBinding' THEN
    RAISE EXCEPTION 'W66 editorial entry must own its exact derived materialization' USING ERRCODE='23514';END IF;
   PERFORM w66_assert_materialization_v3(m.id,v."projectId",v."workspaceId");
  ELSE
   IF e."geometryStatus"<>'blocked-v3' OR e."materializationId" IS NOT NULL OR e."geometryProjectionHash" IS NOT NULL
    OR entry_record.element#>>'{consumption,status}' IS DISTINCT FROM 'blocked' OR entry_record.element#>'{consumption,reasons}' IS DISTINCT FROM '["empty-project"]'::jsonb
    OR (pj->>'durationFrames')::bigint<>0 THEN RAISE EXCEPTION 'W66v3 blocked consumption differs' USING ERRCODE='23514'; END IF;
  END IF;
 END LOOP;
EXCEPTION WHEN no_data_found OR too_many_rows THEN RAISE EXCEPTION 'W66v3 reciprocal bundle missing/ambiguous at COMMIT' USING ERRCODE='23514';
END 
$$;

CREATE OR REPLACE FUNCTION w66_assert_child_command_state_v1(p_state text) RETURNS void LANGUAGE plpgsql AS $$
DECLARE ob_bundle jsonb;source_doc jsonb;m_doc jsonb;bs_doc jsonb; s project_output_states%ROWTYPE;v project_versions%ROWTYPE;b project_versions%ROWTYPE;bs project_output_states%ROWTYPE;
 ob output_operational_bundles%ROWTYPE;d jsonb;o jsonb;pj jsonb;sp project_snapshots%ROWTYPE;bp jsonb;cmd edit_commands%ROWTYPE;entry_record record;
 e project_output_state_entries%ROWTYPE;re output_spec_revisions%ROWTYPE;m output_materializations%ROWTYPE;expected_version jsonb;target_v project_versions%ROWTYPE;
 source_state project_output_states%ROWTYPE;root_state text;project_row projects%ROWTYPE;source_plan jsonb;expected_producer jsonb;metadata jsonb;tr media_transcripts%ROWTYPE;operation_row public_operations%ROWTYPE;detail_row media_ingest_operations%ROWTYPE;manual_payload jsonb;manual_impact jsonb;impact_ranges jsonb;impact_body jsonb;manual_impact_text text;affected_output jsonb;
 replaced text[];adopted_ids text[];adoption record;adopted_receipt output_normalization_receipts%ROWTYPE;adopted_artifact media_artifacts%ROWTYPE;adopted_rights asset_rights_snapshots%ROWTYPE;written_now boolean;pending_parent boolean;derived_parent boolean;
BEGIN
 SELECT * INTO STRICT s FROM project_output_states WHERE id=p_state AND "schemaVersion"='project-output-state/v3';
 SELECT * INTO STRICT v FROM project_versions WHERE id=s."resultVersionId" AND "workspaceId"=s."workspaceId" AND "projectId"=s."projectId" AND "outputContractVersion"=3;
 SELECT * INTO STRICT b FROM project_versions WHERE id=s."parentVersionId" AND "workspaceId"=s."workspaceId" AND "projectId"=s."projectId" AND "outputContractVersion" IN (2,3);
 SELECT * INTO STRICT bs FROM project_output_states WHERE id=b."outputStateId" AND "resultVersionId"=b.id AND "stateHash"=b."outputStateHash" AND "workspaceId"=b."workspaceId" AND "projectId"=b."projectId";
 bs_doc:=bs."stateJson"::jsonb;
 SELECT * INTO STRICT ob FROM output_operational_bundles WHERE "versionId"=v.id AND "stateId"=s.id AND "workspaceId"=v."workspaceId" AND "projectId"=v."projectId";
 ob_bundle:=ob."bundleJson"::jsonb;
 SELECT * INTO STRICT sp FROM project_snapshots WHERE id=s."editPlanSnapshotId" AND "projectId"=s."projectId" AND "workspaceId"=s."workspaceId" AND kind='edit-plan';
 SELECT * INTO STRICT project_row FROM projects WHERE id=v."projectId" AND "workspaceId"=v."workspaceId" AND "creationContractVersion"=2;
 SELECT rv."outputStateId" INTO STRICT root_state FROM project_versions rv WHERE rv."projectId"=v."projectId" AND rv."workspaceId"=v."workspaceId" AND rv.sequence=1 AND rv."outputContractVersion"=2;
 PERFORM w66_assert_creation_anchor_v3(root_state);
 IF b."outputContractVersion"=2 THEN PERFORM w66_assert_creation_anchor_v3(bs.id);
 ELSIF bs."schemaVersion" IS DISTINCT FROM 'project-output-state/v3' OR bs."stateHash" IS DISTINCT FROM w66_v2_sha(bs."stateJson") OR b."baseHash" IS DISTINCT FROM w66_v2_sha(b."outputBaseHashJson")
  OR b."outputVersionJson"::jsonb->>'outputStateHash' IS DISTINCT FROM bs."stateHash" THEN
  RAISE EXCEPTION 'W66v3 parent immutable local anchor differs' USING ERRCODE='23514';END IF;
 d:=s."stateJson"::jsonb;o:=ob."originJson"::jsonb;pj:=sp."contentJson"::jsonb;
 -- A copy that no editorial cut has given target authority: the Creation fork itself, or a State3 whose every entry is still blocked
 -- with the fork reason. Its children only configure it and inherit that posture.
 pending_parent:=(b."outputContractVersion"=2 AND bs.transition='fork-with-content')
  OR (b."outputContractVersion"=3 AND jsonb_array_length(bs_doc->'entries')>0 AND NOT EXISTS(SELECT 1 FROM jsonb_array_elements(bs_doc->'entries') AS pe(element)
   WHERE pe.element->'consumption' IS DISTINCT FROM '{"status":"blocked","reasons":["fork-target-materialization-required"]}'::jsonb));
 -- A cut copy: every entry of the parent carries the editorial binding its cut gave it. Its children keep that authority.
 derived_parent:=b."outputContractVersion"=3 AND jsonb_array_length(bs_doc->'entries')>0 AND NOT EXISTS(SELECT 1 FROM jsonb_array_elements(bs_doc->'entries') AS de(element)
  WHERE de.element#>>'{consumption,status}' IS DISTINCT FROM 'materialized' OR de.element#>>'{consumption,materialization,document,schemaVersion}' IS DISTINCT FROM 'editorial-derived-materialization/v1');
 IF b."outputContractVersion"<>3 AND NOT pending_parent THEN RAISE EXCEPTION 'W66v3 child Command requires an operational State3 parent' USING ERRCODE='23514';END IF;
 SELECT x."contentJson"::jsonb INTO STRICT bp FROM project_snapshots x WHERE x.id=b."editPlanSnapshotId" AND x."projectId"=b."projectId" AND x."workspaceId"=b."workspaceId";
 IF d->>'schemaVersion' IS DISTINCT FROM 'project-output-state/v3' OR d->>'canonicalPolicyVersion' IS DISTINCT FROM s."canonicalPolicyVersion"
 OR d->>'transitionPolicyVersion' IS DISTINCT FROM s."transitionPolicyVersion" OR s."canonicalPolicyVersion"<>'output-canonical-json/v1' OR s."transitionPolicyVersion"<>'project-output-transition/v3'
 OR s.transition IS DISTINCT FROM 'inherit'
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
 OR v."baseHash" IS DISTINCT FROM w66_v2_sha(v."outputBaseHashJson") OR ob_bundle->>'schemaVersion' IS DISTINCT FROM 'operational-output-version-bundle/v3'
 OR ob_bundle->'version' IS DISTINCT FROM expected_version OR ob_bundle->'state' IS DISTINCT FROM jsonb_build_object('document',d,'stateHash',s."stateHash")
 OR ob_bundle->'origin' IS DISTINCT FROM o OR ob_bundle->>'outputBaseHashJson' IS DISTINCT FROM v."outputBaseHashJson" THEN
  RAISE EXCEPTION 'W66v3 bundle/base hash authority differs' USING ERRCODE='23514'; END IF;
 PERFORM w66_assert_provenance(s."producerKind",s."producerId",s."provenanceHash",s."projectId",s."workspaceId",v.id);
 source_state:=bs;source_doc:=bs_doc;source_plan:=bp;
 IF s."producerKind"<>'edit-command' THEN RAISE EXCEPTION 'W66v3 child Command requires an edit-command producer' USING ERRCODE='23514'; END IF;
 SELECT * INTO STRICT cmd FROM edit_commands WHERE id=s."producerId" AND "projectId"=s."projectId" AND "workspaceId"=s."workspaceId";
 IF ob."producerPayloadJson" IS NULL OR ob."producerPayloadHash" IS NULL OR ob."producerPayloadHash" IS DISTINCT FROM w66_v2_sha(ob."producerPayloadJson")
  OR ob."producerPayloadJson"::jsonb IS DISTINCT FROM cmd."payloadJson"::jsonb OR cmd."baseVersionId" IS DISTINCT FROM b.id OR cmd."baseHash" IS DISTINCT FROM b."baseHash"
  OR cmd."actorId" IS DISTINCT FROM v."createdBy" OR cmd."createdAt" IS DISTINCT FROM v."createdAt" OR v."commandId" IS DISTINCT FROM cmd.id THEN
  RAISE EXCEPTION 'W66v3 Command base/actor/time differs' USING ERRCODE='23514'; END IF;
 -- The origin is the sealed Command itself plus its declared effect; nothing is re-derived from the caller.
 IF NOT w66_v3_exact_keys(o,ARRAY['kind','command','audit','requestFingerprint','replaces','adoptions']) OR o->>'kind' IS DISTINCT FROM 'child-command'
  OR cmd.type NOT IN ('attach-media-library-reference','manual-edit','apply-review-patch','apply-review-patch-batch','run-director','set-project-lut-selection','set-project-color-plan','set-project-subtitle-mode','apply-subtitle-segment-override','apply-variant-reframe-override','replace-source-transcript','direct-multicam-session','set-project-policy-overrides')
  OR o->'command' IS DISTINCT FROM cmd."commandJson"::jsonb||jsonb_build_object('commandHash',cmd."commandHash")
  OR o->>'requestFingerprint' IS DISTINCT FROM cmd."requestFingerprint" OR jsonb_typeof(o->'replaces') IS DISTINCT FROM 'array' OR jsonb_typeof(o->'adoptions') IS DISTINCT FROM 'array'
  OR cmd."outputPayloadJson" IS NOT NULL OR cmd."outputPayloadHash" IS NOT NULL
  OR (cmd.type='manual-edit' AND (cmd."payloadJson"::jsonb->>'action' IS DISTINCT FROM 'apply'
   OR cmd."payloadJson"::jsonb#>>'{operation,kind}' IS NULL OR cmd."payloadJson"::jsonb#>>'{operation,kind}'='select')) THEN
  RAISE EXCEPTION 'W66v3 child Command origin authority differs' USING ERRCODE='23514'; END IF;
 IF cmd."actorType"='api-client' THEN
  IF cmd."actorContextHash" IS NULL OR o#>>'{audit,contextHash}' IS DISTINCT FROM cmd."actorContextHash" OR o#>>'{audit,clientId}' IS DISTINCT FROM cmd."actorId"
   OR o#>>'{audit,workspaceId}' IS DISTINCT FROM cmd."workspaceId" THEN
   RAISE EXCEPTION 'W66v3 child Command external actor audit differs' USING ERRCODE='23514'; END IF;
 ELSIF o->'audit' IS DISTINCT FROM 'null'::jsonb OR cmd."actorContextHash" IS NOT NULL OR cmd."actorCredentialId" IS NOT NULL THEN
  RAISE EXCEPTION 'W66v3 child Command internal actor carries a credential audit' USING ERRCODE='23514'; END IF;
 IF pending_parent AND (cmd.type NOT IN ('set-project-lut-selection','set-project-color-plan','set-project-subtitle-mode','apply-subtitle-segment-override','set-project-policy-overrides')
  OR o->'adoptions' IS DISTINCT FROM '[]'::jsonb) THEN
  RAISE EXCEPTION 'W66v3 a copy without target authority accepts only configuration Commands that adopt nothing' USING ERRCODE='23514';END IF;
 replaced:=ARRAY(SELECT r.kind_name FROM jsonb_array_elements_text(o->'replaces') WITH ORDINALITY AS r(kind_name,item_order) ORDER BY r.item_order);
 IF replaced IS DISTINCT FROM ARRAY(SELECT u.kind_name FROM unnest(replaced) AS u(kind_name) ORDER BY u.kind_name COLLATE "C")
  OR (SELECT count(DISTINCT u.kind_name) FROM unnest(replaced) AS u(kind_name))<>cardinality(replaced)
  OR EXISTS(SELECT 1 FROM unnest(replaced) AS u(kind_name) WHERE u.kind_name <> ALL(CASE cmd.type WHEN 'run-director' THEN ARRAY['brief','story','treatment'] WHEN 'set-project-policy-overrides' THEN ARRAY['policies'] ELSE ARRAY[]::text[] END)) THEN
  RAISE EXCEPTION 'W66v3 child Command replacement kinds exceed its declared effect' USING ERRCODE='23514'; END IF;
 IF s.transition IS DISTINCT FROM 'inherit' THEN RAISE EXCEPTION 'W66v3 child Command transition differs' USING ERRCODE='23514'; END IF;
 -- Declared plan effect: these types may only re-identify the parent plan.
 IF cmd.type IN ('attach-media-library-reference','set-project-lut-selection','set-project-color-plan','set-project-subtitle-mode','apply-subtitle-segment-override','apply-variant-reframe-override','set-project-policy-overrides') AND pj-ARRAY['id','projectVersionId','createdAt'] IS DISTINCT FROM bp-ARRAY['id','projectVersionId','createdAt'] THEN
  RAISE EXCEPTION 'W66v3 child Command changed a plan it declared unchanged' USING ERRCODE='23514'; END IF;
 adopted_ids:=ARRAY(SELECT a.element->>'receiptId' FROM jsonb_array_elements(o->'adoptions') WITH ORDINALITY AS a(element,item_order) ORDER BY a.item_order);
 IF adopted_ids IS DISTINCT FROM ARRAY(SELECT u.id FROM unnest(adopted_ids) AS u(id) ORDER BY u.id COLLATE "C")
  OR (SELECT count(DISTINCT u.id) FROM unnest(adopted_ids) AS u(id))<>cardinality(adopted_ids)
  OR EXISTS(SELECT 1 FROM jsonb_array_elements(o->'adoptions') AS a(element)
   WHERE NOT coalesce(w66_v3_exact_keys(a.element,ARRAY['receiptId','receiptHash','sourceArtifactId','sourceManifestId','sourceManifestHash','rights']),false)
    OR NOT coalesce(w66_v3_exact_keys(a.element->'rights',ARRAY['snapshotId','snapshotHash','revision']),false)) THEN
  RAISE EXCEPTION 'W66v3 child adoption shape/order differs' USING ERRCODE='23514';END IF;
 IF EXISTS(SELECT 1 FROM jsonb_array_elements(d->'entries') AS child_entry(element)
  WHERE child_entry.element#>>'{consumption,status}'='materialized' AND
   EXISTS(SELECT 1 FROM jsonb_array_elements(child_entry.element#>'{consumption,materialization,document,normalizations}') AS child_n(element)
    WHERE NOT EXISTS(SELECT 1 FROM jsonb_array_elements(source_doc->'entries') AS source_entry(element),
     LATERAL jsonb_array_elements(CASE WHEN source_entry.element#>>'{consumption,status}'='materialized' THEN source_entry.element#>'{consumption,materialization,document,normalizations}' ELSE '[]'::jsonb END) AS source_n(element)
     WHERE source_n.element=child_n.element)
    AND NOT EXISTS(SELECT 1 FROM jsonb_array_elements(o->'adoptions') AS a(element)
     WHERE a.element->>'receiptId'=child_n.element#>>'{document,id}' AND a.element->>'receiptHash'=child_n.element->>'receiptHash'
      AND a.element->>'sourceArtifactId'=child_n.element#>>'{document,source,artifactId}' AND a.element->>'sourceManifestId'=child_n.element#>>'{document,source,manifestId}'
      AND a.element->>'sourceManifestHash'=child_n.element#>>'{document,source,manifest,manifestHash}')))
  OR EXISTS(SELECT 1 FROM jsonb_array_elements(o->'adoptions') AS a(element)
   WHERE NOT EXISTS(SELECT 1 FROM jsonb_array_elements(d->'entries') AS child_entry(element),
     LATERAL jsonb_array_elements(CASE WHEN child_entry.element#>>'{consumption,status}'='materialized' THEN child_entry.element#>'{consumption,materialization,document,normalizations}' ELSE '[]'::jsonb END) AS child_n(element)
     WHERE child_n.element#>>'{document,id}'=a.element->>'receiptId')
    OR EXISTS(SELECT 1 FROM jsonb_array_elements(source_doc->'entries') AS source_entry(element),
     LATERAL jsonb_array_elements(CASE WHEN source_entry.element#>>'{consumption,status}'='materialized' THEN source_entry.element#>'{consumption,materialization,document,normalizations}' ELSE '[]'::jsonb END) AS source_n(element)
     WHERE source_n.element#>>'{document,id}'=a.element->>'receiptId' OR source_n.element#>>'{document,source,artifactId}'=a.element->>'sourceArtifactId')) THEN
  RAISE EXCEPTION 'W66v3 child normalization lineage differs' USING ERRCODE='23514';END IF;
 -- Currency is a property of the write: only the transaction that inserted this Version row requires its adoptions' rights to be current.
 SELECT pv.xmin::text::bigint=(txid_current() % 4294967296) INTO written_now FROM project_versions pv WHERE pv.id=v.id;
 FOR adoption IN SELECT a.element FROM jsonb_array_elements(o->'adoptions') AS a(element) LOOP
  SELECT * INTO STRICT adopted_receipt FROM output_normalization_receipts WHERE id=adoption.element->>'receiptId' AND "receiptHash"=adoption.element->>'receiptHash'
   AND "projectId"=s."projectId" AND "workspaceId"=s."workspaceId" AND "sourceArtifactId"=adoption.element->>'sourceArtifactId'
   AND "sourceManifestId"=adoption.element->>'sourceManifestId' AND "sourceManifestHash"=adoption.element->>'sourceManifestHash';
  PERFORM w66_assert_normalization_v3(adopted_receipt.id,s."projectId",s."workspaceId");
  -- History: the snapshot the adoption names is a persisted, approved revision of that artifact's rights, unexpired when the Version was born.
  SELECT * INTO STRICT adopted_rights FROM asset_rights_snapshots WHERE id=adoption.element#>>'{rights,snapshotId}' AND "artifactId"=adopted_receipt."sourceArtifactId" AND "workspaceId"=s."workspaceId";
  IF adopted_rights."snapshotHash" IS DISTINCT FROM adoption.element#>>'{rights,snapshotHash}' OR adopted_rights.sequence > (adoption.element#>>'{rights,revision}')::integer
   OR adopted_rights.status IS DISTINCT FROM 'approved' OR (adopted_rights."expiresAt" IS NOT NULL AND adopted_rights."expiresAt"<=v."createdAt") THEN
   RAISE EXCEPTION 'W66v3 adopted observation rights differ from the snapshot they name' USING ERRCODE='23514';END IF;
  -- Currency: only the transaction that wrote this Version requires that snapshot to still be current.
  IF written_now THEN
   SELECT * INTO STRICT adopted_artifact FROM media_artifacts WHERE id=adopted_receipt."sourceArtifactId" AND "workspaceId"=s."workspaceId" AND status='available';
   IF adopted_artifact."currentRightsSnapshotId" IS DISTINCT FROM adopted_rights.id OR adopted_artifact."rightsRevision" IS DISTINCT FROM (adoption.element#>>'{rights,revision}')::integer
    OR (adopted_rights."expiresAt" IS NOT NULL AND adopted_rights."expiresAt"<=clock_timestamp()) THEN
    RAISE EXCEPTION 'W66v3 adopted observation rights are not current' USING ERRCODE='23514';END IF;
  END IF;
  IF NOT EXISTS(SELECT 1 FROM project_media_assets l WHERE l."projectId"=s."projectId" AND l."workspaceId"=s."workspaceId" AND l."artifactId"=adopted_receipt."sourceArtifactId") THEN
   RAISE EXCEPTION 'W66v3 adopted observation has no project media association' USING ERRCODE='23514';END IF;
 END LOOP;
 expected_producer:=jsonb_build_object('schemaVersion','output-child-command-producer/v3','canonicalPolicyVersion','output-canonical-json/v1','kind','child-command',
  'commandId',cmd.id,'commandHash',cmd."commandHash",'payloadHash',ob."producerPayloadHash",'target','null'::jsonb,'adoptions',o->'adoptions');
 -- Non-output snapshots are inherited unless the origin declares the kind; a replaced kind is a new snapshot born with the Version.
 IF (NOT 'brief'=ANY(replaced) AND v."briefSnapshotId" IS DISTINCT FROM b."briefSnapshotId")
  OR (NOT 'policies'=ANY(replaced) AND v."policiesSnapshotId" IS DISTINCT FROM b."policiesSnapshotId")
  OR (NOT 'treatment'=ANY(replaced) AND v."treatmentSnapshotId" IS DISTINCT FROM b."treatmentSnapshotId")
  OR (NOT 'story'=ANY(replaced) AND v."storySnapshotId" IS DISTINCT FROM b."storySnapshotId")
  OR ('brief'=ANY(replaced) AND (v."briefSnapshotId" IS NOT DISTINCT FROM b."briefSnapshotId" OR NOT EXISTS(SELECT 1 FROM project_snapshots sx WHERE sx.id=v."briefSnapshotId"
   AND sx.kind='brief' AND sx."projectId"=v."projectId" AND sx."workspaceId"=v."workspaceId" AND sx."createdAt"<=v."createdAt")))
  OR ('policies'=ANY(replaced) AND (v."policiesSnapshotId" IS NOT DISTINCT FROM b."policiesSnapshotId" OR NOT EXISTS(SELECT 1 FROM project_snapshots sx WHERE sx.id=v."policiesSnapshotId"
   AND sx.kind='policies' AND sx."projectId"=v."projectId" AND sx."workspaceId"=v."workspaceId" AND sx."createdAt"<=v."createdAt")))
  OR ('treatment'=ANY(replaced) AND (v."treatmentSnapshotId" IS NULL OR v."treatmentSnapshotId" IS NOT DISTINCT FROM b."treatmentSnapshotId" OR NOT EXISTS(SELECT 1 FROM project_snapshots sx
   WHERE sx.id=v."treatmentSnapshotId" AND sx.kind='treatment' AND sx."projectId"=v."projectId" AND sx."workspaceId"=v."workspaceId" AND sx."createdAt"<=v."createdAt")))
  OR ('story'=ANY(replaced) AND (v."storySnapshotId" IS NULL OR v."storySnapshotId" IS NOT DISTINCT FROM b."storySnapshotId" OR NOT EXISTS(SELECT 1 FROM project_snapshots sx
   WHERE sx.id=v."storySnapshotId" AND sx.kind='story' AND sx."projectId"=v."projectId" AND sx."workspaceId"=v."workspaceId" AND sx."createdAt"<=v."createdAt")))
  OR NOT EXISTS(SELECT 1 FROM project_snapshots sx WHERE sx.id=v."briefSnapshotId" AND sx."projectId"=v."projectId" AND sx."workspaceId"=v."workspaceId" AND sx.kind='brief')
  OR NOT EXISTS(SELECT 1 FROM project_snapshots sx WHERE sx.id=v."policiesSnapshotId" AND sx."projectId"=v."projectId" AND sx."workspaceId"=v."workspaceId" AND sx.kind='policies') THEN
  RAISE EXCEPTION 'W66v3 non-output snapshot effect outside origin' USING ERRCODE='23514';END IF;
 -- Every member retains the exact revision/spec (a child Command revises none); consumption receives
 -- fresh result geometry, never copied acceptance or output identities.
 IF EXISTS(SELECT 1 FROM jsonb_array_elements(source_doc->'entries') AS prior(element)
  WHERE NOT EXISTS(SELECT 1 FROM jsonb_array_elements(d->'entries') AS next_member(element)
    WHERE next_member.element-ARRAY['consumption'] IS NOT DISTINCT FROM prior.element-ARRAY['consumption']))
 OR EXISTS(SELECT 1 FROM jsonb_array_elements(d->'entries') AS next_member(element)
  WHERE NOT EXISTS(SELECT 1 FROM jsonb_array_elements(source_doc->'entries') AS prior(element)
    WHERE prior.element-ARRAY['consumption'] IS NOT DISTINCT FROM next_member.element-ARRAY['consumption'])) THEN
  RAISE EXCEPTION 'W66v3 hidden sibling membership/revision change' USING ERRCODE='23514';END IF;
 IF s."producerJson"::jsonb IS DISTINCT FROM expected_producer THEN RAISE EXCEPTION 'W66v3 typed producer differs' USING ERRCODE='23514'; END IF;
 IF d->'overlays' IS DISTINCT FROM source_doc->'overlays' OR d->'invalidations' IS DISTINCT FROM source_doc->'invalidations'
 OR d->'sourceDependencies' IS DISTINCT FROM source_doc->'sourceDependencies' THEN
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
   IF pending_parent THEN RAISE EXCEPTION 'W66v3 a copy without target authority cannot materialize' USING ERRCODE='23514';END IF;
   SELECT * INTO STRICT m FROM output_materializations WHERE id=e."materializationId" AND "materializationHash"=e."geometryProjectionHash"
    AND "resultVersionId"=v.id AND "variantId"=e."variantId" AND "projectId"=v."projectId" AND "workspaceId"=v."workspaceId";
   m_doc:=m."materializationJson"::jsonb;
   IF e."geometryStatus"<>'materialized-v3' OR entry_record.element#>'{consumption,materialization}' IS DISTINCT FROM
    jsonb_build_object('document',m_doc,'materializationHash',m."materializationHash") THEN
    RAISE EXCEPTION 'W66v3 entry materialization binding differs' USING ERRCODE='23514'; END IF;
   -- The authority of a cut copy is carried, never rebound: an editorial-derived entry needs an editorial-derived parent and the
   -- parent's binding unchanged apart from the identity of the Version it is re-issued for (the binding itself is validated by
   -- w66_assert_materialization_v3 below, which routes editorial-derived documents to the editorial guard).
   IF m_doc->>'schemaVersion'='editorial-derived-materialization/v1' THEN
    IF NOT derived_parent THEN RAISE EXCEPTION 'W66v3 an editorial-derived entry needs an editorial-derived parent' USING ERRCODE='23514';END IF;
    IF (m_doc#>'{sourceBinding,document}')-ARRAY['id','parentVersionId','parentStateId','parentStateHash','resultVersionId','createdAt'] IS DISTINCT FROM
     (SELECT pe.element#>'{consumption,materialization,document,sourceBinding,document}' FROM jsonb_array_elements(bs_doc->'entries') AS pe(element)
      WHERE pe.element->>'variantId'=e."variantId")-ARRAY['id','parentVersionId','parentStateId','parentStateHash','resultVersionId','createdAt'] THEN
     RAISE EXCEPTION 'W66v3 a child of a cut copy changed its editorial authority' USING ERRCODE='23514';END IF;
   ELSIF derived_parent THEN RAISE EXCEPTION 'W66v3 a child of a cut copy keeps its editorial authority' USING ERRCODE='23514';END IF;
   PERFORM w66_assert_materialization_v3(m.id,v."projectId",v."workspaceId");
  ELSE
   IF e."geometryStatus"<>'blocked-v3' OR e."materializationId" IS NOT NULL OR e."geometryProjectionHash" IS NOT NULL
    OR entry_record.element#>>'{consumption,status}' IS DISTINCT FROM 'blocked'
    OR (CASE WHEN pending_parent THEN entry_record.element#>'{consumption,reasons}' IS DISTINCT FROM '["fork-target-materialization-required"]'::jsonb
     ELSE entry_record.element#>'{consumption,reasons}' IS DISTINCT FROM '["empty-project"]'::jsonb OR (pj->>'durationFrames')::bigint<>0 END)
    THEN RAISE EXCEPTION 'W66v3 blocked consumption differs' USING ERRCODE='23514'; END IF;
  END IF;
 END LOOP;
EXCEPTION WHEN no_data_found OR too_many_rows THEN RAISE EXCEPTION 'W66v3 reciprocal bundle missing/ambiguous at COMMIT' USING ERRCODE='23514';
END 
$$;

CREATE OR REPLACE FUNCTION w66_assert_renderable_compile_state_v1(p_state text) RETURNS void LANGUAGE plpgsql AS $$
DECLARE ob_bundle jsonb;source_doc jsonb;m_doc jsonb; s project_output_states%ROWTYPE;v project_versions%ROWTYPE;b project_versions%ROWTYPE;bs project_output_states%ROWTYPE;
 ob output_operational_bundles%ROWTYPE;d jsonb;o jsonb;pj jsonb;sp project_snapshots%ROWTYPE;bp jsonb;cmd edit_commands%ROWTYPE;entry_record record;
 e project_output_state_entries%ROWTYPE;re output_spec_revisions%ROWTYPE;m output_materializations%ROWTYPE;expected_version jsonb;
 source_state project_output_states%ROWTYPE;root_state text;project_row projects%ROWTYPE;expected_producer jsonb;
 r renderable_plan_snapshots%ROWTYPE;cmd_payload jsonb;snapshot_ref jsonb;impact jsonb;
BEGIN
 SELECT * INTO STRICT s FROM project_output_states WHERE id=p_state AND "schemaVersion"='project-output-state/v3';
 SELECT * INTO STRICT v FROM project_versions WHERE id=s."resultVersionId" AND "workspaceId"=s."workspaceId" AND "projectId"=s."projectId" AND "outputContractVersion"=3;
 SELECT * INTO STRICT b FROM project_versions WHERE id=s."parentVersionId" AND "workspaceId"=s."workspaceId" AND "projectId"=s."projectId" AND "outputContractVersion"=3;
 SELECT * INTO STRICT bs FROM project_output_states WHERE id=b."outputStateId" AND "resultVersionId"=b.id AND "stateHash"=b."outputStateHash" AND "workspaceId"=b."workspaceId" AND "projectId"=b."projectId";
 SELECT * INTO STRICT ob FROM output_operational_bundles WHERE "versionId"=v.id AND "stateId"=s.id AND "workspaceId"=v."workspaceId" AND "projectId"=v."projectId";
 ob_bundle:=ob."bundleJson"::jsonb;
 SELECT * INTO STRICT sp FROM project_snapshots WHERE id=s."editPlanSnapshotId" AND "projectId"=s."projectId" AND "workspaceId"=s."workspaceId" AND kind='edit-plan';
 SELECT * INTO STRICT project_row FROM projects WHERE id=v."projectId" AND "workspaceId"=v."workspaceId" AND "creationContractVersion"=2;
 SELECT rv."outputStateId" INTO STRICT root_state FROM project_versions rv WHERE rv."projectId"=v."projectId" AND rv."workspaceId"=v."workspaceId" AND rv.sequence=1 AND rv."outputContractVersion"=2;
 PERFORM w66_assert_creation_anchor_v3(root_state);
 IF bs."schemaVersion" IS DISTINCT FROM 'project-output-state/v3' OR bs."stateHash" IS DISTINCT FROM w66_v2_sha(bs."stateJson") OR b."baseHash" IS DISTINCT FROM w66_v2_sha(b."outputBaseHashJson")
  OR b."outputVersionJson"::jsonb->>'outputStateHash' IS DISTINCT FROM bs."stateHash" THEN
  RAISE EXCEPTION 'W66v3 parent immutable local anchor differs' USING ERRCODE='23514';END IF;
 -- A copy that no editorial cut has given target authority renders nothing, and a cut copy keeps its editorial authority in every
 -- Version: neither takes a renderable plan through this origin.
 IF w66_fork_copy_pending_v1(b.id,b."projectId",b."workspaceId") THEN
  RAISE EXCEPTION 'W66v3 a copy without target authority cannot compile a renderable plan' USING ERRCODE='23514';END IF;
 IF EXISTS(SELECT 1 FROM jsonb_array_elements(bs."stateJson"::jsonb->'entries') AS pe(element)
  WHERE pe.element#>>'{consumption,materialization,document,schemaVersion}'='editorial-derived-materialization/v1') THEN
  RAISE EXCEPTION 'W66v3 a cut copy keeps its editorial authority; a renderable plan cannot be compiled onto it' USING ERRCODE='23514';END IF;
 d:=s."stateJson"::jsonb;o:=ob."originJson"::jsonb;pj:=sp."contentJson"::jsonb;
 SELECT x."contentJson"::jsonb INTO STRICT bp FROM project_snapshots x WHERE x.id=b."editPlanSnapshotId" AND x."projectId"=b."projectId" AND x."workspaceId"=b."workspaceId";
 -- The row and the State name each other: the State holds the row's id, plan id and hash, and the row is the one of this Version.
 IF s."renderablePlanSnapshotId" IS NULL OR s."renderablePlanId" IS NULL OR s."renderablePlanHash" IS NULL
  OR s."renderablePlanAuthorityJson" IS NULL OR s."renderablePlanAuthorityHash" IS NULL THEN
  RAISE EXCEPTION 'W66v3 renderable snapshot differs from the State it is bound to' USING ERRCODE='23514';END IF;
 SELECT * INTO STRICT r FROM renderable_plan_snapshots WHERE id=s."renderablePlanSnapshotId" AND "workspaceId"=s."workspaceId" AND "projectId"=s."projectId";
 IF s."renderablePlanSnapshotId" IS DISTINCT FROM r.id OR s."renderablePlanId" IS DISTINCT FROM r."planId" OR s."renderablePlanHash" IS DISTINCT FROM r."planHash"
  OR r."projectVersionId" IS DISTINCT FROM v.id OR r."createdAt" IS DISTINCT FROM v."createdAt"
  OR r."planJson"::jsonb->>'id' IS DISTINCT FROM r."planId" OR r."planJson"::jsonb->>'projectVersionId' IS DISTINCT FROM v.id
  OR d->'renderablePlan' IS DISTINCT FROM jsonb_build_object('snapshotId',r.id,'planId',r."planId",'hash',r."planHash",'authority',
   jsonb_build_object('schemaVersion','output-plan-authority/v1','document',s."renderablePlanAuthorityJson"::jsonb,'hash',s."renderablePlanAuthorityHash")) THEN
  RAISE EXCEPTION 'W66v3 renderable snapshot differs from the State it is bound to' USING ERRCODE='23514';END IF;
 -- The plan document hashes to the stored hash under the historical renderable authority, and the State seals that very document.
 PERFORM w66_assert_plan_authority(s."renderablePlanAuthorityJson",s."renderablePlanAuthorityHash",'renderable-edit-plan',r."planHash",
  jsonb_build_object('schemaVersion','renderable-edit-plan-hash/v2','compilerVersion','renderable-edit-plan/2026-09-05-v1','plan',r."planJson"::jsonb-'createdAt'));
 IF d->>'schemaVersion' IS DISTINCT FROM 'project-output-state/v3' OR d->>'canonicalPolicyVersion' IS DISTINCT FROM s."canonicalPolicyVersion"
 OR d->>'transitionPolicyVersion' IS DISTINCT FROM s."transitionPolicyVersion" OR s."canonicalPolicyVersion"<>'output-canonical-json/v1' OR s."transitionPolicyVersion"<>'project-output-transition/v3'
 OR s.transition IS DISTINCT FROM 'inherit'
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
 OR d#>>'{editPlan,hash}' IS DISTINCT FROM sp."contentHash" OR s."creationCommandV2Id" IS NOT NULL
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
 OR v."baseHash" IS DISTINCT FROM w66_v2_sha(v."outputBaseHashJson") OR ob_bundle->>'schemaVersion' IS DISTINCT FROM 'operational-output-version-bundle/v3'
 OR ob_bundle->'version' IS DISTINCT FROM expected_version OR ob_bundle->'state' IS DISTINCT FROM jsonb_build_object('document',d,'stateHash',s."stateHash")
 OR ob_bundle->'origin' IS DISTINCT FROM o OR ob_bundle->>'outputBaseHashJson' IS DISTINCT FROM v."outputBaseHashJson" THEN
  RAISE EXCEPTION 'W66v3 bundle/base hash authority differs' USING ERRCODE='23514'; END IF;
 PERFORM w66_assert_provenance(s."producerKind",s."producerId",s."provenanceHash",s."projectId",s."workspaceId",v.id);
 source_state:=bs;source_doc:=bs."stateJson"::jsonb;
 IF s."producerKind"<>'edit-command' THEN RAISE EXCEPTION 'W66v3 renderable compile requires an edit-command producer' USING ERRCODE='23514'; END IF;
 SELECT * INTO STRICT cmd FROM edit_commands WHERE id=s."producerId" AND "projectId"=s."projectId" AND "workspaceId"=s."workspaceId";
 IF ob."producerPayloadJson" IS NULL OR ob."producerPayloadHash" IS NULL OR ob."producerPayloadHash" IS DISTINCT FROM w66_v2_sha(ob."producerPayloadJson")
  OR ob."producerPayloadJson"::jsonb IS DISTINCT FROM cmd."payloadJson"::jsonb OR cmd."baseVersionId" IS DISTINCT FROM b.id OR cmd."baseHash" IS DISTINCT FROM b."baseHash"
  OR cmd."actorId" IS DISTINCT FROM v."createdBy" OR cmd."createdAt" IS DISTINCT FROM v."createdAt" OR v."commandId" IS DISTINCT FROM cmd.id THEN
  RAISE EXCEPTION 'W66v3 Command base/actor/time differs' USING ERRCODE='23514'; END IF;
 -- The origin is the sealed Command itself; the row it publishes is named by its payload and nowhere else.
 cmd_payload:=cmd."payloadJson"::jsonb;snapshot_ref:=cmd_payload->'snapshot';impact:=cmd_payload->'impact';
 IF NOT w66_v3_exact_keys(o,ARRAY['kind','command','audit','requestFingerprint']) OR o->>'kind' IS DISTINCT FROM 'renderable-compile-command'
  OR cmd.type IS DISTINCT FROM 'compile-renderable-plan'
  OR o->'command' IS DISTINCT FROM cmd."commandJson"::jsonb||jsonb_build_object('commandHash',cmd."commandHash")
  OR o->>'requestFingerprint' IS DISTINCT FROM cmd."requestFingerprint"
  OR cmd."outputPayloadJson" IS NOT NULL OR cmd."outputPayloadHash" IS NOT NULL
  OR cmd."commandJson"::jsonb->'scope' IS DISTINCT FROM '{"project":true}'::jsonb
  OR NOT w66_v3_exact_keys(cmd_payload,ARRAY['schemaVersion','snapshot','impact'])
  OR cmd_payload->'schemaVersion' IS DISTINCT FROM '1'::jsonb
  OR NOT coalesce(w66_v3_exact_keys(cmd_payload->'snapshot',ARRAY['id','planId','planHash','origin','sourceId','sourceHash','sourceVersion','fps','durationFrames','clipCount']),false)
  OR snapshot_ref->>'id' IS DISTINCT FROM r.id OR snapshot_ref->>'planId' IS DISTINCT FROM r."planId" OR snapshot_ref->>'planHash' IS DISTINCT FROM r."planHash"
  OR snapshot_ref->>'origin' IS DISTINCT FROM r.origin OR snapshot_ref->>'sourceId' IS DISTINCT FROM r."sourceId" OR snapshot_ref->>'sourceHash' IS DISTINCT FROM r."sourceHash"
  OR snapshot_ref->'sourceVersion' IS DISTINCT FROM (CASE WHEN r."sourceVersion" IS NULL THEN 'null'::jsonb ELSE to_jsonb(r."sourceVersion") END)
  OR (snapshot_ref->>'fps')::double precision IS DISTINCT FROM r.fps OR (snapshot_ref->>'durationFrames')::integer IS DISTINCT FROM r."durationFrames"
  OR (snapshot_ref->>'clipCount')::integer IS DISTINCT FROM r."clipCount"
  OR NOT coalesce(w66_v3_exact_keys(impact,ARRAY['schemaVersion','commandType','commandId','baseVersionId','resultVersionId','preservedEditPlanSnapshotId','renderablePlanSnapshotId',
   'renderablePlanHash','changeKinds','dependencyTypes','affectedRanges','affectedVariantIds','affectedArtifacts','minimalRenders','renderSemanticsChanged','impactHash']),false)
  OR impact->>'schemaVersion' IS DISTINCT FROM 'renderable-compile-impact/v1' OR impact->>'commandType' IS DISTINCT FROM 'compile-renderable-plan'
  OR impact->>'commandId' IS DISTINCT FROM cmd.id OR impact->>'baseVersionId' IS DISTINCT FROM b.id OR impact->>'resultVersionId' IS DISTINCT FROM v.id
  OR impact->>'preservedEditPlanSnapshotId' IS DISTINCT FROM sp.id OR impact->>'renderablePlanSnapshotId' IS DISTINCT FROM r.id OR impact->>'renderablePlanHash' IS DISTINCT FROM r."planHash"
  OR impact->'changeKinds' IS DISTINCT FROM '["renderable-plan"]'::jsonb OR impact->'renderSemanticsChanged' IS DISTINCT FROM 'false'::jsonb
  OR impact->'dependencyTypes' IS DISTINCT FROM '[]'::jsonb OR impact->'affectedRanges' IS DISTINCT FROM '[]'::jsonb OR impact->'affectedVariantIds' IS DISTINCT FROM '[]'::jsonb
  OR impact->'affectedArtifacts' IS DISTINCT FROM '[]'::jsonb OR impact->'minimalRenders' IS DISTINCT FROM '[]'::jsonb THEN
  RAISE EXCEPTION 'W66v3 renderable compile Command origin authority differs' USING ERRCODE='23514'; END IF;
 IF cmd."actorType"='api-client' THEN
  IF cmd."actorContextHash" IS NULL OR o#>>'{audit,contextHash}' IS DISTINCT FROM cmd."actorContextHash" OR o#>>'{audit,clientId}' IS DISTINCT FROM cmd."actorId"
   OR o#>>'{audit,workspaceId}' IS DISTINCT FROM cmd."workspaceId" THEN
   RAISE EXCEPTION 'W66v3 renderable compile external actor audit differs' USING ERRCODE='23514'; END IF;
 ELSIF o->'audit' IS DISTINCT FROM 'null'::jsonb OR cmd."actorContextHash" IS NOT NULL OR cmd."actorCredentialId" IS NOT NULL THEN
  RAISE EXCEPTION 'W66v3 renderable compile internal actor carries a credential audit' USING ERRCODE='23514'; END IF;
 -- Declared plan effect: the EditPlan may only be re-identified.
 IF pj-ARRAY['id','projectVersionId','createdAt'] IS DISTINCT FROM bp-ARRAY['id','projectVersionId','createdAt'] THEN
  RAISE EXCEPTION 'W66v3 renderable compile changed a plan it declared unchanged' USING ERRCODE='23514'; END IF;
 -- Nothing is observed or adopted: every observation of a materialized entry is one the head's State already holds, identical.
 IF EXISTS(SELECT 1 FROM jsonb_array_elements(d->'entries') AS child_entry(element)
  WHERE child_entry.element#>>'{consumption,status}'='materialized' AND
   EXISTS(SELECT 1 FROM jsonb_array_elements(child_entry.element#>'{consumption,materialization,document,normalizations}') AS child_n(element)
    WHERE NOT EXISTS(SELECT 1 FROM jsonb_array_elements(source_doc->'entries') AS source_entry(element),
     LATERAL jsonb_array_elements(CASE WHEN source_entry.element#>>'{consumption,status}'='materialized' THEN source_entry.element#>'{consumption,materialization,document,normalizations}' ELSE '[]'::jsonb END) AS source_n(element)
     WHERE source_n.element=child_n.element))) THEN
  RAISE EXCEPTION 'W66v3 renderable compile normalization lineage differs' USING ERRCODE='23514';END IF;
 expected_producer:=jsonb_build_object('schemaVersion','output-renderable-compile-producer/v1','canonicalPolicyVersion','output-canonical-json/v1','kind','renderable-compile-command',
  'commandId',cmd.id,'commandHash',cmd."commandHash",'payloadHash',ob."producerPayloadHash",'renderablePlanSnapshotId',r.id,'renderablePlanId',r."planId",'renderablePlanHash',r."planHash");
 -- Non-output snapshots are inherited from the head: the compile replaces none.
 IF v."briefSnapshotId" IS DISTINCT FROM b."briefSnapshotId" OR v."policiesSnapshotId" IS DISTINCT FROM b."policiesSnapshotId"
  OR v."treatmentSnapshotId" IS DISTINCT FROM b."treatmentSnapshotId" OR v."storySnapshotId" IS DISTINCT FROM b."storySnapshotId"
  OR NOT EXISTS(SELECT 1 FROM project_snapshots sx WHERE sx.id=v."briefSnapshotId" AND sx."projectId"=v."projectId" AND sx."workspaceId"=v."workspaceId" AND sx.kind='brief')
  OR NOT EXISTS(SELECT 1 FROM project_snapshots sx WHERE sx.id=v."policiesSnapshotId" AND sx."projectId"=v."projectId" AND sx."workspaceId"=v."workspaceId" AND sx.kind='policies') THEN
  RAISE EXCEPTION 'W66v3 non-output snapshot effect outside origin' USING ERRCODE='23514';END IF;
 -- Every member retains the exact revision/spec (a compile revises none); consumption receives fresh result geometry, never copied
 -- acceptance or output identities.
 IF EXISTS(SELECT 1 FROM jsonb_array_elements(source_doc->'entries') AS prior(element)
  WHERE NOT EXISTS(SELECT 1 FROM jsonb_array_elements(d->'entries') AS next_member(element)
    WHERE next_member.element-ARRAY['consumption'] IS NOT DISTINCT FROM prior.element-ARRAY['consumption']))
 OR EXISTS(SELECT 1 FROM jsonb_array_elements(d->'entries') AS next_member(element)
  WHERE NOT EXISTS(SELECT 1 FROM jsonb_array_elements(source_doc->'entries') AS prior(element)
    WHERE prior.element-ARRAY['consumption'] IS NOT DISTINCT FROM next_member.element-ARRAY['consumption'])) THEN
  RAISE EXCEPTION 'W66v3 hidden sibling membership/revision change' USING ERRCODE='23514';END IF;
 IF s."producerJson"::jsonb IS DISTINCT FROM expected_producer THEN RAISE EXCEPTION 'W66v3 typed producer differs' USING ERRCODE='23514'; END IF;
 IF d->'overlays' IS DISTINCT FROM source_doc->'overlays' OR d->'invalidations' IS DISTINCT FROM source_doc->'invalidations'
 OR d->'sourceDependencies' IS DISTINCT FROM source_doc->'sourceDependencies' THEN
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
   m_doc:=m."materializationJson"::jsonb;
   IF e."geometryStatus"<>'materialized-v3' OR entry_record.element#>'{consumption,materialization}' IS DISTINCT FROM
    jsonb_build_object('document',m_doc,'materializationHash',m."materializationHash") THEN
    RAISE EXCEPTION 'W66v3 entry materialization binding differs' USING ERRCODE='23514'; END IF;
   PERFORM w66_assert_materialization_v3(m.id,v."projectId",v."workspaceId");
  ELSE
   IF e."geometryStatus"<>'blocked-v3' OR e."materializationId" IS NOT NULL OR e."geometryProjectionHash" IS NOT NULL
    OR entry_record.element#>>'{consumption,status}' IS DISTINCT FROM 'blocked'
    OR entry_record.element#>'{consumption,reasons}' IS DISTINCT FROM '["empty-project"]'::jsonb OR (pj->>'durationFrames')::bigint<>0
    THEN RAISE EXCEPTION 'W66v3 blocked consumption differs' USING ERRCODE='23514'; END IF;
  END IF;
 END LOOP;
EXCEPTION WHEN no_data_found OR too_many_rows THEN RAISE EXCEPTION 'W66v3 reciprocal bundle missing/ambiguous at COMMIT' USING ERRCODE='23514';
END 
$$;

CREATE OR REPLACE FUNCTION w66_assert_editorial_binding_v1(p_binding json, p_project text, p_workspace text, p_parent text, p_result text) RETURNS void LANGUAGE plpgsql AS $$
DECLARE source_refs jsonb; d jsonb:=p_binding->'document';a jsonb:=d->'authority';sv project_versions%ROWTYPE;ss project_output_states%ROWTYPE;
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
   AND pb."originJson"::jsonb->>'kind'='editorial-cut-command' AND pb."originJson"::jsonb#>'{command,payload,sourceBinding,document,authority}'=a)
  -- A copy whose children only configured it: its parent still carries the fork's posture, and the authority is the fork root's.
  AND NOT (a->>'kind'='fork-derivation3' AND w66_fork_copy_pending_v1(p_parent,p_project,p_workspace))
  -- A child of a cut copy carries its parent's binding: the parent's State holds that very authority.
  AND NOT EXISTS(SELECT 1 FROM project_versions cv JOIN project_output_states cs ON cs.id=cv."outputStateId" AND cs."resultVersionId"=cv.id AND cs."stateHash"=cv."outputStateHash"
   WHERE cv.id=p_parent AND cv."projectId"=p_project AND cv."workspaceId"=p_workspace AND cs."schemaVersion"='project-output-state/v3'
    AND cs."stateJson"::jsonb#>'{entries,0,consumption,materialization,document,sourceBinding,document,authority}'=a) THEN
  RAISE EXCEPTION 'W66 editorial source authority is not explicit parent continuity' USING ERRCODE='23514';END IF;
 SELECT * INTO STRICT t FROM media_transcripts WHERE id=d#>>'{transcript,id}' AND "projectId"=sv."projectId" AND "workspaceId"=p_workspace;
 IF d->'transcript' IS DISTINCT FROM jsonb_build_object('id',t.id,'workspaceId',t."workspaceId",'projectId',t."projectId",'sourceArtifactId',t."sourceArtifactId",
  'sourceManifestId',t."sourceManifestId",'document',t."transcriptJson"::jsonb,'createdAt',w66_v2_iso(t."createdAt")) OR
  d#>>'{transcript,document,transcriptHash}' IS DISTINCT FROM t."transcriptHash" THEN
  RAISE EXCEPTION 'W66 editorial original transcript scope/receipt differs' USING ERRCODE='23514';END IF;
 IF jsonb_array_length(d->'normalizationRefs')=0 OR jsonb_array_length(d->'normalizationRefs')<>(SELECT count(DISTINCT r.element->>'id') FROM jsonb_array_elements(d->'normalizationRefs') AS r(element)) THEN
  RAISE EXCEPTION 'W66 editorial normalization refs missing/ambiguous' USING ERRCODE='23514';END IF;
 source_refs:=(SELECT coalesce(jsonb_agg(jsonb_build_object('id',nr.element#>>'{document,id}','receiptHash',nr.element->>'receiptHash')),'[]'::jsonb)
  FROM jsonb_array_elements(source_state_doc->'entries') AS e(element)
  CROSS JOIN LATERAL jsonb_array_elements(coalesce(e.element#>'{consumption,materialization,document,normalizations}','[]'::jsonb)) AS nr(element));
 IF jsonb_array_length(d->'normalizationRefs')<>(SELECT count(DISTINCT sr.element->>'id') FROM jsonb_array_elements(source_refs) AS sr(element)) THEN
  RAISE EXCEPTION 'W66 editorial exact source observation inventory differs' USING ERRCODE='23514';END IF;
 FOR item IN SELECT r.element FROM jsonb_array_elements(d->'normalizationRefs') AS r(element) LOOP
  SELECT * INTO STRICT n FROM output_normalization_receipts WHERE id=item.element->>'id' AND "projectId"=item.element->>'projectId' AND "workspaceId"=p_workspace AND "receiptHash"=item.element->>'receiptHash';
  PERFORM w66_assert_normalization_v3(n.id,n."projectId",p_workspace);
  IF NOT EXISTS(SELECT 1 FROM jsonb_array_elements(source_refs) AS sr(element) WHERE sr.element->>'id'=n.id AND sr.element->>'receiptHash'=n."receiptHash") THEN
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
END 
$$;

CREATE OR REPLACE FUNCTION w66_assert_normalization_v3(p_id text, p_project text, p_workspace text) RETURNS void LANGUAGE plpgsql AS $$
DECLARE memo_stamp text;memo_key text;memo_seen text; n output_normalization_receipts%ROWTYPE;d jsonb;o public_operations%ROWTYPE;e jsonb;slot text;audio jsonb;video jsonb;argv_expected jsonb;
BEGIN
 -- The same State is asserted through several paths (the materialization, the editorial binding, the child inventory) and each re-verifies every
 -- receipt it names. A receipt's verdict cannot change unless something was written, so it is reused for the same receipt, in the same statement,
 -- with the same number of rows this transaction has written to any table (the rule `w66_assert_operational_state_v3` already uses). Any write
 -- changes the count, a new statement changes the timestamp, and with track_counts off nothing is reused. A refused check raises: no refusal is remembered.
 IF current_setting('track_counts')='on' THEN
  memo_stamp:=statement_timestamp()::text||':'||(SELECT coalesce(sum(x.n_tup_ins+x.n_tup_upd+x.n_tup_del),0) FROM pg_stat_xact_all_tables x WHERE x.schemaname='public')::text;
  memo_key:='|'||p_id||','||p_project||','||p_workspace||'|';
  memo_seen:=coalesce(current_setting('apollo.w66_normalization_verified',true),'');
  IF split_part(memo_seen,E'\n',1)=memo_stamp AND position(memo_key in split_part(memo_seen,E'\n',2))>0 THEN RETURN;END IF;
 END IF;
 SELECT * INTO STRICT n FROM output_normalization_receipts WHERE id=p_id AND "projectId"=p_project AND "workspaceId"=p_workspace;
 d:=n."receiptJson"::jsonb;e:=d->'execution';
 IF NOT w66_v2_exact_json(d,ARRAY['schemaVersion','canonicalPolicyVersion','id','kind','workspaceId','projectId','operationId','attempt','leaseOwner','source','derivative','sourceProbe','derivativeProbe','audioProbes','execution','createdAt'])
 OR d->>'schemaVersion' IS DISTINCT FROM 'output-normalization-receipt/v3' OR d->>'canonicalPolicyVersion' IS DISTINCT FROM 'output-canonical-json/v1'
 OR d->>'id' IS DISTINCT FROM n.id OR d->>'workspaceId' IS DISTINCT FROM n."workspaceId" OR d->>'projectId' IS DISTINCT FROM n."projectId"
 OR d->>'operationId' IS DISTINCT FROM n."operationId" OR d->>'createdAt' IS DISTINCT FROM w66_v2_iso(n."createdAt")
 OR d#>>'{source,artifactId}' IS DISTINCT FROM n."sourceArtifactId" OR d#>>'{source,manifestId}' IS DISTINCT FROM n."sourceManifestId"
 OR d#>>'{source,manifest,manifestHash}' IS DISTINCT FROM n."sourceManifestHash" OR d#>>'{derivative,artifactId}' IS DISTINCT FROM n."derivativeArtifactId"
 OR d#>>'{derivative,manifestId}' IS DISTINCT FROM n."derivativeManifestId" OR d#>>'{derivative,manifest,manifestHash}' IS DISTINCT FROM n."derivativeManifestHash" THEN
  RAISE EXCEPTION 'W66v3 normalization identity/columns differ' USING ERRCODE='23514'; END IF;
 SELECT * INTO STRICT o FROM public_operations WHERE id=n."operationId" AND "workspaceId"=p_workspace AND "projectId"=p_project AND type='media-ingest';
 IF (d->>'attempt')::integer<1 OR o.attempt<(d->>'attempt')::integer OR length(d->>'leaseOwner') NOT BETWEEN 1 AND 128
 OR NOT w66_v2_exact_json(e,ARRAY['provider','recipeVersion','binarySha256','argv','spawnObserved','closeObserved','exitCode','sourceSha256Before','sourceSha256After','derivativeSha256','autorotate'])
 OR e->>'recipeVersion' IS DISTINCT FROM 'media-normalization-execution/2026-10-14-v3'
 OR e->'spawnObserved' IS DISTINCT FROM 'true'::jsonb OR e->'closeObserved' IS DISTINCT FROM 'true'::jsonb OR e->'exitCode' IS DISTINCT FROM '0'::jsonb
 OR e->>'binarySha256' !~ '^[a-f0-9]{64}$' OR e->>'sourceSha256Before' IS DISTINCT FROM d#>>'{source,manifest,artifact,sha256}'
 OR e->>'sourceSha256After' IS DISTINCT FROM e->>'sourceSha256Before' OR e->>'derivativeSha256' IS DISTINCT FROM d#>>'{derivative,manifest,artifact,sha256}' THEN
  RAISE EXCEPTION 'W66v3 normalization producer/bytes/terminality differ' USING ERRCODE='23514'; END IF;
 PERFORM w66_assert_artifact_fact_v3(d->'source',p_workspace);PERFORM w66_assert_artifact_fact_v3(d->'derivative',p_workspace);
 PERFORM w66_assert_probe_v3(d->'sourceProbe',d#>'{source,manifest}');PERFORM w66_assert_probe_v3(d->'derivativeProbe',d#>'{derivative,manifest}');
 IF NOT w66_v2_exact_json(d->'audioProbes',ARRAY['source','derivative']) THEN RAISE EXCEPTION 'W66v3 audio observations shape' USING ERRCODE='23514'; END IF;
 FOREACH slot IN ARRAY ARRAY['source','derivative'] LOOP
  audio:=d->'audioProbes'->slot;video:=d->(slot||'Probe');
  IF audio IS DISTINCT FROM 'null'::jsonb THEN
   PERFORM w66_assert_probe_v3(audio,d#>ARRAY[slot,'manifest']);
   IF audio->>'mediaType' IS DISTINCT FROM 'audio' OR audio->'rawJson' IS DISTINCT FROM video->'rawJson'
    OR audio->'rawSha256' IS DISTINCT FROM video->'rawSha256' OR audio->'binarySha256' IS DISTINCT FROM video->'binarySha256' THEN
    RAISE EXCEPTION 'W66v3 audio must bind identical observed probe bytes' USING ERRCODE='23514'; END IF;
  ELSIF EXISTS(SELECT 1 FROM jsonb_array_elements((video->>'rawJson')::jsonb->'streams') AS ss(element) WHERE ss.element->>'codec_type'='audio') THEN
   RAISE EXCEPTION 'W66v3 observed audio authority omitted' USING ERRCODE='23514';
  END IF;
 END LOOP;
 IF d->>'kind'='ffmpeg-video-derivative' THEN
  argv_expected:=jsonb_build_array('-hide_banner','-loglevel','error','-y','-i',e->'argv'->5,'-map','0:v:0','-map','0:a:0?',
   '-vf','scale=w=1280:h=1280:force_original_aspect_ratio=decrease:force_divisible_by=2:flags=lanczos',
   '-c:v','libx264','-preset','veryfast','-crf','24','-pix_fmt','yuv420p','-c:a','aac','-b:a','128k','-ar','48000',
   '-movflags','+faststart',e->'argv'->(jsonb_array_length(e->'argv')-1));
  IF e->>'provider' IS DISTINCT FROM 'ffmpeg' OR e->'autorotate' IS DISTINCT FROM 'true'::jsonb OR e->'argv' IS DISTINCT FROM argv_expected
  OR d#>>'{sourceProbe,mediaType}' IS DISTINCT FROM 'video' OR d#>>'{derivativeProbe,mediaType}' IS DISTINCT FROM 'video'
  OR d#>>'{derivative,manifest,recipe,id}' IS DISTINCT FROM 'editing-proxy' OR d#>>'{derivative,manifest,recipe,version}' IS DISTINCT FROM '1.2.0'
  OR d#>>'{derivative,manifest,recipe,parametersHash}' IS DISTINCT FROM '1cfd215bc314d680a97e36d0c55e573e43bef7c35421c49cdf2d2aa19071630d'
  OR n."sourceArtifactId"=n."derivativeArtifactId"
  OR NOT EXISTS(SELECT 1 FROM jsonb_array_elements(d#>'{derivative,manifest,sources}') AS lineage(element)
    WHERE lineage.element->>'artifactKey'=d#>>'{source,manifest,artifact,artifactKey}' AND lineage.element->>'sha256'=e->>'sourceSha256Before'
     AND lineage.element->>'role'='source-master' AND lineage.element#>>'{execution,tool,id}'='ffmpeg'
     AND lineage.element#>>'{execution,tool,digest}'=e->>'binarySha256') OR d#>'{derivativeProbe,rotationDegrees}' IS DISTINCT FROM '0'::jsonb THEN
   RAISE EXCEPTION 'W66v3 normalization recipe/lineage/rotation differ' USING ERRCODE='23514'; END IF;
 ELSIF d->>'kind'='ffprobe-original-audio' THEN
  IF e->>'provider' IS DISTINCT FROM 'ffprobe' OR e->'autorotate' IS DISTINCT FROM 'false'::jsonb OR d->'source' IS DISTINCT FROM d->'derivative'
  OR d->'sourceProbe' IS DISTINCT FROM d->'derivativeProbe' OR d#>>'{sourceProbe,mediaType}' IS DISTINCT FROM 'audio'
  OR d#>>'{sourceProbe,binarySha256}' IS DISTINCT FROM e->>'binarySha256' THEN
   RAISE EXCEPTION 'W66v3 original audio observation differs' USING ERRCODE='23514'; END IF;
 ELSE RAISE EXCEPTION 'W66v3 unsupported normalization kind' USING ERRCODE='23514'; END IF;
 IF memo_stamp IS NOT NULL THEN
  IF split_part(memo_seen,E'\n',1)=memo_stamp THEN PERFORM set_config('apollo.w66_normalization_verified',memo_seen||memo_key,true);
  ELSE PERFORM set_config('apollo.w66_normalization_verified',memo_stamp||E'\n'||memo_key,true);END IF;
 END IF;
EXCEPTION WHEN no_data_found OR too_many_rows OR invalid_text_representation OR numeric_value_out_of_range THEN
 RAISE EXCEPTION 'W66v3 normalization factual row/shape missing' USING ERRCODE='23514';
END 
$$;
