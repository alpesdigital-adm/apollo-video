-- A renderable plan snapshot is born with the Version whose sealed State binds it. The dispatch guard of the table already demanded
-- that reciprocal binding but only a retired contract could give it: every project Version is now contract 2 or 3, so no
-- compiler (react playback, multi-range synthesis, music-led montage, localization) could insert its plan at all.
--
-- The way in is a Command like any other that produces a Version: `compile-renderable-plan`, a child of the exact head whose
-- State3 holds the plan as its alternate plan. This migration adds, and replaces nothing else than:
--   1. the Command type in the table constraint (the registry list, exactly);
--   2. the guard of that origin. It copies the shared State/Version/bundle/materialization spine of the child-command guard and
--      replaces the origin-specific part: the origin is the sealed Command row, its payload names the very row the State binds,
--      the row equals the State (id, plan id, hash, authority, workspace, project, Version, clock) and its plan document hashes to
--      the stored hash, the EditPlan is the head's under a new identity, nothing is replaced or adopted, and every entry
--      re-materializes from the head's exact observations;
--   3. the dispatcher of the operational guards, which routes that origin to its own guard and keeps the other three as they were;
--   4. the dispatch of the snapshot table: contract 1 and contract 2 exactly as before, and contract 3 only when the State names
--      the row back through the three reciprocal columns, then the operational guard of that State decides.
-- No trigger is created, dropped or disabled and no immutability is touched: a bare INSERT of a snapshot is still refused at
-- COMMIT, for every Version whose State does not bind it.
ALTER TABLE "edit_commands" DROP CONSTRAINT "edit_commands_type_check";
ALTER TABLE "edit_commands" ADD CONSTRAINT "edit_commands_type_check" CHECK ("type" IN (
  'apply-review-patch', 'apply-review-patch-batch', 'apply-subtitle-segment-override',
  'attach-media-library-reference', 'compare-action', 'compile-renderable-plan', 'direct-multicam-session', 'manual-edit', 'remove-spoken-content',
  'replace-source-transcript', 'run-director', 'set-project-color-plan',
  'set-project-lut-selection', 'set-project-policy-overrides', 'set-project-subtitle-mode',
  'create-output-variant', 'revise-output-spec'
));

CREATE FUNCTION w66_assert_renderable_compile_state_v1(p_state text) RETURNS void LANGUAGE plpgsql AS $$
DECLARE s project_output_states%ROWTYPE;v project_versions%ROWTYPE;b project_versions%ROWTYPE;bs project_output_states%ROWTYPE;
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
 OR v."baseHash" IS DISTINCT FROM w66_v2_sha(v."outputBaseHashJson") OR ob."bundleJson"::jsonb->>'schemaVersion' IS DISTINCT FROM 'operational-output-version-bundle/v3'
 OR ob."bundleJson"::jsonb->'version' IS DISTINCT FROM expected_version OR ob."bundleJson"::jsonb->'state' IS DISTINCT FROM jsonb_build_object('document',d,'stateHash',s."stateHash")
 OR ob."bundleJson"::jsonb->'origin' IS DISTINCT FROM o OR ob."bundleJson"::jsonb->>'outputBaseHashJson' IS DISTINCT FROM v."outputBaseHashJson" THEN
  RAISE EXCEPTION 'W66v3 bundle/base hash authority differs' USING ERRCODE='23514'; END IF;
 PERFORM w66_assert_provenance(s."producerKind",s."producerId",s."provenanceHash",s."projectId",s."workspaceId",v.id);
 source_state:=bs;
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
    WHERE NOT EXISTS(SELECT 1 FROM jsonb_array_elements(source_state."stateJson"::jsonb->'entries') AS source_entry(element),
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
   SELECT * INTO STRICT m FROM output_materializations WHERE id=e."materializationId" AND "materializationHash"=e."geometryProjectionHash"
    AND "resultVersionId"=v.id AND "variantId"=e."variantId" AND "projectId"=v."projectId" AND "workspaceId"=v."workspaceId";
   IF e."geometryStatus"<>'materialized-v3' OR entry_record.element#>'{consumption,materialization}' IS DISTINCT FROM
    jsonb_build_object('document',m."materializationJson"::jsonb,'materializationHash',m."materializationHash") THEN
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
END $$;

CREATE OR REPLACE FUNCTION w66_assert_operational_state_v3(p_state text) RETURNS void LANGUAGE plpgsql AS $$
DECLARE origin_kind text;fingerprint text;BEGIN
 -- A deferred batch queues one check per written row; each re-reads every receipt of the State. The verdict for a State cannot change
 -- unless something was written, so it is reused for the same State, in the same statement, with the same number of rows this
 -- transaction has written to any table. Any write changes the count, a new statement changes the timestamp, and with track_counts
 -- off nothing is reused. A refused check raises, so no refusal is ever remembered.
 IF current_setting('track_counts')='on' THEN
  fingerprint:=p_state||':'||statement_timestamp()::text||':'||(SELECT coalesce(sum(x.n_tup_ins+x.n_tup_upd+x.n_tup_del),0) FROM pg_stat_xact_all_tables x WHERE x.schemaname='public')::text;
  IF current_setting('apollo.w66_state_verified',true)=fingerprint THEN RETURN;END IF;
 END IF;
 SELECT "originJson"::jsonb->>'kind' INTO STRICT origin_kind FROM output_operational_bundles WHERE "stateId"=p_state;
 IF origin_kind='editorial-cut-command' THEN PERFORM w66_assert_editorial_state_v1(p_state);
 ELSIF origin_kind='child-command' THEN PERFORM w66_assert_child_command_state_v1(p_state);
 ELSIF origin_kind='renderable-compile-command' THEN PERFORM w66_assert_renderable_compile_state_v1(p_state);
 ELSE PERFORM w66_assert_operational_state_v3_historical(p_state);END IF;
 IF fingerprint IS NOT NULL THEN PERFORM set_config('apollo.w66_state_verified',fingerprint,true);END IF;
END $$;

CREATE OR REPLACE FUNCTION w66_renderable_dispatch_v2() RETURNS trigger LANGUAGE plpgsql AS $$
DECLARE version project_versions%ROWTYPE; BEGIN
 SELECT * INTO STRICT version FROM project_versions WHERE id=NEW."projectVersionId";
 IF version."outputContractVersion"=2 THEN
  RAISE EXCEPTION 'W66v2 Creation renderable is a blocked candidate, not a factual rendered plan' USING ERRCODE='23514'; END IF;
 -- Contract 3: the State of the Version names the row back through the three reciprocal columns, and its operational guard (the
 -- renderable compile origin, for any State that binds a plan) verifies the row against the State field by field.
 IF version."outputContractVersion"=3 THEN
  IF NOT EXISTS(SELECT 1 FROM project_output_states s WHERE s.id=version."outputStateId" AND s."resultVersionId"=version.id AND s."schemaVersion"='project-output-state/v3'
   AND s."renderablePlanSnapshotId"=NEW.id AND s."renderablePlanId"=NEW."planId" AND s."renderablePlanHash"=NEW."planHash") THEN
   RAISE EXCEPTION 'W66 new renderable snapshot lacks reciprocal state binding' USING ERRCODE='23514'; END IF;
  PERFORM w66_assert_operational_state_v3(version."outputStateId"); RETURN NULL;
 END IF;
 IF version."outputContractVersion" IS DISTINCT FROM 1 OR NOT EXISTS(SELECT 1 FROM project_output_states s WHERE s.id=version."outputStateId"
  AND s."renderablePlanSnapshotId"=NEW.id AND s."renderablePlanId"=NEW."planId" AND s."renderablePlanHash"=NEW."planHash") THEN
  RAISE EXCEPTION 'W66 new renderable snapshot lacks reciprocal state binding' USING ERRCODE='23514'; END IF;
 PERFORM w66_assert_output_state(version."outputStateId"); RETURN NULL;
END $$;
