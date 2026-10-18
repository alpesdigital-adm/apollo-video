-- A cut copy (a Creation fork that took its editorial cut) accepts the normal children, exactly like a project that was cut in place:
-- configuration, review patches, manual edit apply and a Director re-run are children whose entries are materialized from the very
-- receipts the cut bound, under the cut's editorial binding carried (never rebound) to each new Version. The child guard now
-- requires that carried binding to equal the parent's apart from the identity of the Version it is re-issued for, refuses an
-- editorial-derived entry whose parent is not editorial-derived, and refuses a child of a cut copy that drops the authority;
-- the editorial binding guard accepts, as continuity, a parent whose State holds the same authority. Only these two functions
-- are replaced; no trigger, row or constraint is touched.
CREATE OR REPLACE FUNCTION w66_assert_editorial_binding_v1(p_binding json,p_project text,p_workspace text,p_parent text,p_result text) RETURNS void LANGUAGE plpgsql AS $$
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
CREATE OR REPLACE FUNCTION w66_assert_child_command_state_v1(p_state text) RETURNS void LANGUAGE plpgsql AS $$
DECLARE s project_output_states%ROWTYPE;v project_versions%ROWTYPE;b project_versions%ROWTYPE;bs project_output_states%ROWTYPE;
 ob output_operational_bundles%ROWTYPE;d jsonb;o jsonb;pj jsonb;sp project_snapshots%ROWTYPE;bp jsonb;cmd edit_commands%ROWTYPE;entry_record record;
 e project_output_state_entries%ROWTYPE;re output_spec_revisions%ROWTYPE;m output_materializations%ROWTYPE;expected_version jsonb;target_v project_versions%ROWTYPE;
 source_state project_output_states%ROWTYPE;root_state text;project_row projects%ROWTYPE;source_plan jsonb;expected_producer jsonb;metadata jsonb;tr media_transcripts%ROWTYPE;operation_row public_operations%ROWTYPE;detail_row media_ingest_operations%ROWTYPE;manual_payload jsonb;manual_impact jsonb;impact_ranges jsonb;impact_body jsonb;manual_impact_text text;affected_output jsonb;
 replaced text[];adopted_ids text[];adoption record;adopted_receipt output_normalization_receipts%ROWTYPE;adopted_artifact media_artifacts%ROWTYPE;adopted_rights asset_rights_snapshots%ROWTYPE;written_now boolean;pending_parent boolean;derived_parent boolean;
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
 -- A copy that no editorial cut has given target authority: the Creation fork itself, or a State3 whose every entry is still blocked
 -- with the fork reason. Its children only configure it and inherit that posture.
 pending_parent:=(b."outputContractVersion"=2 AND bs.transition='fork-with-content')
  OR (b."outputContractVersion"=3 AND jsonb_array_length(bs."stateJson"::jsonb->'entries')>0 AND NOT EXISTS(SELECT 1 FROM jsonb_array_elements(bs."stateJson"::jsonb->'entries') AS pe(element)
   WHERE pe.element->'consumption' IS DISTINCT FROM '{"status":"blocked","reasons":["fork-target-materialization-required"]}'::jsonb));
 -- A cut copy: every entry of the parent carries the editorial binding its cut gave it. Its children keep that authority.
 derived_parent:=b."outputContractVersion"=3 AND jsonb_array_length(bs."stateJson"::jsonb->'entries')>0 AND NOT EXISTS(SELECT 1 FROM jsonb_array_elements(bs."stateJson"::jsonb->'entries') AS de(element)
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
 OR v."baseHash" IS DISTINCT FROM w66_v2_sha(v."outputBaseHashJson") OR ob."bundleJson"::jsonb->>'schemaVersion' IS DISTINCT FROM 'operational-output-version-bundle/v3'
 OR ob."bundleJson"::jsonb->'version' IS DISTINCT FROM expected_version OR ob."bundleJson"::jsonb->'state' IS DISTINCT FROM jsonb_build_object('document',d,'stateHash',s."stateHash")
 OR ob."bundleJson"::jsonb->'origin' IS DISTINCT FROM o OR ob."bundleJson"::jsonb->>'outputBaseHashJson' IS DISTINCT FROM v."outputBaseHashJson" THEN
  RAISE EXCEPTION 'W66v3 bundle/base hash authority differs' USING ERRCODE='23514'; END IF;
 PERFORM w66_assert_provenance(s."producerKind",s."producerId",s."provenanceHash",s."projectId",s."workspaceId",v.id);
 source_state:=bs;source_plan:=bp;
 IF s."producerKind"<>'edit-command' THEN RAISE EXCEPTION 'W66v3 child Command requires an edit-command producer' USING ERRCODE='23514'; END IF;
 SELECT * INTO STRICT cmd FROM edit_commands WHERE id=s."producerId" AND "projectId"=s."projectId" AND "workspaceId"=s."workspaceId";
 IF ob."producerPayloadJson" IS NULL OR ob."producerPayloadHash" IS NULL OR ob."producerPayloadHash" IS DISTINCT FROM w66_v2_sha(ob."producerPayloadJson")
  OR ob."producerPayloadJson"::jsonb IS DISTINCT FROM cmd."payloadJson"::jsonb OR cmd."baseVersionId" IS DISTINCT FROM b.id OR cmd."baseHash" IS DISTINCT FROM b."baseHash"
  OR cmd."actorId" IS DISTINCT FROM v."createdBy" OR cmd."createdAt" IS DISTINCT FROM v."createdAt" OR v."commandId" IS DISTINCT FROM cmd.id THEN
  RAISE EXCEPTION 'W66v3 Command base/actor/time differs' USING ERRCODE='23514'; END IF;
 -- The origin is the sealed Command itself plus its declared effect; nothing is re-derived from the caller.
 IF NOT w66_v3_exact_keys(o,ARRAY['kind','command','audit','requestFingerprint','replaces','adoptions']) OR o->>'kind' IS DISTINCT FROM 'child-command'
  OR cmd.type NOT IN ('attach-media-library-reference','manual-edit','apply-review-patch','apply-review-patch-batch','run-director','set-project-lut-selection','set-project-color-plan','set-project-subtitle-mode','apply-subtitle-segment-override','replace-source-transcript','direct-multicam-session','set-project-policy-overrides')
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
 IF cmd.type IN ('attach-media-library-reference','set-project-lut-selection','set-project-color-plan','set-project-subtitle-mode','apply-subtitle-segment-override','set-project-policy-overrides') AND pj-ARRAY['id','projectVersionId','createdAt'] IS DISTINCT FROM bp-ARRAY['id','projectVersionId','createdAt'] THEN
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
    WHERE NOT EXISTS(SELECT 1 FROM jsonb_array_elements(source_state."stateJson"::jsonb->'entries') AS source_entry(element),
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
    OR EXISTS(SELECT 1 FROM jsonb_array_elements(source_state."stateJson"::jsonb->'entries') AS source_entry(element),
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
 IF EXISTS(SELECT 1 FROM jsonb_array_elements(source_state."stateJson"::jsonb->'entries') AS prior(element)
  WHERE NOT EXISTS(SELECT 1 FROM jsonb_array_elements(d->'entries') AS next_member(element)
    WHERE next_member.element-ARRAY['consumption'] IS NOT DISTINCT FROM prior.element-ARRAY['consumption']))
 OR EXISTS(SELECT 1 FROM jsonb_array_elements(d->'entries') AS next_member(element)
  WHERE NOT EXISTS(SELECT 1 FROM jsonb_array_elements(source_state."stateJson"::jsonb->'entries') AS prior(element)
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
   IF pending_parent THEN RAISE EXCEPTION 'W66v3 a copy without target authority cannot materialize' USING ERRCODE='23514';END IF;
   SELECT * INTO STRICT m FROM output_materializations WHERE id=e."materializationId" AND "materializationHash"=e."geometryProjectionHash"
    AND "resultVersionId"=v.id AND "variantId"=e."variantId" AND "projectId"=v."projectId" AND "workspaceId"=v."workspaceId";
   IF e."geometryStatus"<>'materialized-v3' OR entry_record.element#>'{consumption,materialization}' IS DISTINCT FROM
    jsonb_build_object('document',m."materializationJson"::jsonb,'materializationHash',m."materializationHash") THEN
    RAISE EXCEPTION 'W66v3 entry materialization binding differs' USING ERRCODE='23514'; END IF;
   -- The authority of a cut copy is carried, never rebound: an editorial-derived entry needs an editorial-derived parent and the
   -- parent's binding unchanged apart from the identity of the Version it is re-issued for (the binding itself is validated by
   -- w66_assert_materialization_v3 below, which routes editorial-derived documents to the editorial guard).
   IF m."materializationJson"::jsonb->>'schemaVersion'='editorial-derived-materialization/v1' THEN
    IF NOT derived_parent THEN RAISE EXCEPTION 'W66v3 an editorial-derived entry needs an editorial-derived parent' USING ERRCODE='23514';END IF;
    IF (m."materializationJson"::jsonb#>'{sourceBinding,document}')-ARRAY['id','parentVersionId','parentStateId','parentStateHash','resultVersionId','createdAt'] IS DISTINCT FROM
     (SELECT pe.element#>'{consumption,materialization,document,sourceBinding,document}' FROM jsonb_array_elements(bs."stateJson"::jsonb->'entries') AS pe(element)
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
END $$;
