-- W66r. Reframe with trajectory and per-variant override.
--
-- Three additive tables bound to the STABLE output variant (never an aspect ratio):
--   variant_reframe_plans          the content-addressed plan record of one variant of one ProjectVersion (server-owned ROI, policy hash,
--                                  server plan, plan with the editor's overrides, keyframed render ranges, localized issues). Append-only
--                                  per (version, variant): a new record is the next `sequence`, chained to the one it follows; the unique
--                                  successor index makes the chain a compare-and-swap.
--   variant_reframe_overrides      one row per `apply-variant-reframe-override` Command (set or reset of one exact range of one clip).
--   variant_reframe_override_heads the current override of each (variant, clip, range).
-- The new Command type enters the closed set of the EditCommand registry (the CHECK below must say exactly what
-- src/v2/domain/edit-command-registry.ts says) and the child-Command guard of the sealed output State: it re-identifies the parent's
-- EditPlan, never recompiles it, and is NOT admitted by a copy that has no target authority yet (geometry decides its range).
-- The only function replaced is w66_assert_child_command_state_v1; no trigger, row or other constraint is touched.
CREATE TABLE "variant_reframe_plans" (
  "id" VARCHAR(128) PRIMARY KEY,
  "workspaceId" VARCHAR(128) NOT NULL,
  "projectId" VARCHAR(128) NOT NULL,
  "projectVersionId" VARCHAR(128) NOT NULL,
  "variantId" VARCHAR(128) NOT NULL,
  "sequence" INTEGER NOT NULL,
  "recordHash" CHAR(64) NOT NULL,
  "disposition" VARCHAR(16) NOT NULL,
  "recordJson" TEXT NOT NULL,
  "previousPlanId" VARCHAR(128),
  "createdAt" TIMESTAMPTZ(3) NOT NULL,
  CONSTRAINT "variant_reframe_plans_sequence_check" CHECK ("sequence" >= 1),
  CONSTRAINT "variant_reframe_plans_hash_check" CHECK ("recordHash" ~ '^[a-f0-9]{64}$'),
  CONSTRAINT "variant_reframe_plans_disposition_check" CHECK ("disposition" IN ('ready','review-required','blocked')),
  -- The first record of a (version, variant) has no predecessor; every later one names the record it follows, never itself.
  CONSTRAINT "variant_reframe_plans_chain_check" CHECK (("sequence" = 1) = ("previousPlanId" IS NULL) AND ("previousPlanId" IS NULL OR "previousPlanId" <> "id"))
);
CREATE UNIQUE INDEX "variant_reframe_plans_id_workspaceId_key" ON "variant_reframe_plans"("id","workspaceId");
CREATE UNIQUE INDEX "variant_reframe_plans_record_key" ON "variant_reframe_plans"("workspaceId","projectVersionId","variantId","recordHash");
CREATE UNIQUE INDEX "variant_reframe_plans_sequence_key" ON "variant_reframe_plans"("workspaceId","projectVersionId","variantId","sequence");
CREATE UNIQUE INDEX "variant_reframe_plans_previousPlanId_workspaceId_key" ON "variant_reframe_plans"("previousPlanId","workspaceId");
CREATE INDEX "variant_reframe_plans_variant_idx" ON "variant_reframe_plans"("workspaceId","projectId","variantId","createdAt" DESC);

CREATE TABLE "variant_reframe_overrides" (
  "id" VARCHAR(128) PRIMARY KEY,
  "workspaceId" VARCHAR(128) NOT NULL,
  "projectId" VARCHAR(128) NOT NULL,
  "commandId" VARCHAR(128) NOT NULL,
  "baseVersionId" VARCHAR(128) NOT NULL,
  "resultVersionId" VARCHAR(128) NOT NULL,
  "variantId" VARCHAR(128) NOT NULL,
  "clipId" VARCHAR(128) NOT NULL,
  "startFrame" INTEGER NOT NULL,
  "endFrame" INTEGER NOT NULL,
  "action" VARCHAR(16) NOT NULL,
  "previousOverrideId" VARCHAR(128),
  "overrideJson" TEXT NOT NULL,
  "overrideHash" CHAR(64) NOT NULL,
  "impactJson" TEXT NOT NULL,
  "impactHash" CHAR(64) NOT NULL,
  "createdAt" TIMESTAMPTZ(3) NOT NULL,
  CONSTRAINT "variant_reframe_overrides_action_check" CHECK ("action" IN ('set','reset')),
  -- Half-open [startFrame, endFrame): the end is exclusive and a zero-length range is not a range.
  CONSTRAINT "variant_reframe_overrides_range_check" CHECK ("startFrame" >= 0 AND "endFrame" > "startFrame"),
  -- Only a `reset` is nothing without the override it resets; a `set` may replace one or stand alone.
  CONSTRAINT "variant_reframe_overrides_reset_check" CHECK ("action" <> 'reset' OR "previousOverrideId" IS NOT NULL),
  CONSTRAINT "variant_reframe_overrides_chain_check" CHECK ("previousOverrideId" IS NULL OR "previousOverrideId" <> "id"),
  CONSTRAINT "variant_reframe_overrides_hash_check" CHECK ("overrideHash" ~ '^[a-f0-9]{64}$' AND "impactHash" ~ '^[a-f0-9]{64}$')
);
CREATE UNIQUE INDEX "variant_reframe_overrides_id_workspaceId_key" ON "variant_reframe_overrides"("id","workspaceId");
CREATE UNIQUE INDEX "variant_reframe_overrides_commandId_workspaceId_key" ON "variant_reframe_overrides"("commandId","workspaceId");
CREATE UNIQUE INDEX "variant_reframe_overrides_resultVersionId_workspaceId_key" ON "variant_reframe_overrides"("resultVersionId","workspaceId");
CREATE UNIQUE INDEX "variant_reframe_overrides_previousOverrideId_workspaceId_key" ON "variant_reframe_overrides"("previousOverrideId","workspaceId");
CREATE INDEX "variant_reframe_overrides_variant_idx" ON "variant_reframe_overrides"("workspaceId","projectId","variantId","clipId","createdAt" DESC);
CREATE INDEX "variant_reframe_overrides_base_idx" ON "variant_reframe_overrides"("workspaceId","projectId","baseVersionId");

CREATE TABLE "variant_reframe_override_heads" (
  "workspaceId" VARCHAR(128) NOT NULL,
  "projectId" VARCHAR(128) NOT NULL,
  "variantId" VARCHAR(128) NOT NULL,
  "clipId" VARCHAR(128) NOT NULL,
  "startFrame" INTEGER NOT NULL,
  "endFrame" INTEGER NOT NULL,
  "overrideId" VARCHAR(128) NOT NULL,
  "updatedAt" TIMESTAMPTZ(3) NOT NULL,
  CONSTRAINT "variant_reframe_override_heads_pkey" PRIMARY KEY ("projectId","workspaceId","variantId","clipId","startFrame","endFrame"),
  CONSTRAINT "variant_reframe_override_heads_range_check" CHECK ("startFrame" >= 0 AND "endFrame" > "startFrame")
);
CREATE UNIQUE INDEX "variant_reframe_override_heads_overrideId_workspaceId_key" ON "variant_reframe_override_heads"("overrideId","workspaceId");

ALTER TABLE "variant_reframe_plans" ADD CONSTRAINT "variant_reframe_plans_workspaceId_fkey" FOREIGN KEY ("workspaceId") REFERENCES "workspaces"("id") ON DELETE CASCADE ON UPDATE CASCADE;
ALTER TABLE "variant_reframe_plans" ADD CONSTRAINT "variant_reframe_plans_projectId_workspaceId_fkey" FOREIGN KEY ("projectId","workspaceId") REFERENCES "projects"("id","workspaceId") ON DELETE CASCADE ON UPDATE CASCADE;
ALTER TABLE "variant_reframe_plans" ADD CONSTRAINT "variant_reframe_plans_projectVersionId_workspaceId_fkey" FOREIGN KEY ("projectVersionId","workspaceId") REFERENCES "project_versions"("id","workspaceId") ON DELETE RESTRICT ON UPDATE CASCADE;
ALTER TABLE "variant_reframe_plans" ADD CONSTRAINT "variant_reframe_plans_previousPlanId_workspaceId_fkey" FOREIGN KEY ("previousPlanId","workspaceId") REFERENCES "variant_reframe_plans"("id","workspaceId") ON DELETE RESTRICT ON UPDATE CASCADE;
ALTER TABLE "variant_reframe_overrides" ADD CONSTRAINT "variant_reframe_overrides_workspaceId_fkey" FOREIGN KEY ("workspaceId") REFERENCES "workspaces"("id") ON DELETE CASCADE ON UPDATE CASCADE;
ALTER TABLE "variant_reframe_overrides" ADD CONSTRAINT "variant_reframe_overrides_projectId_workspaceId_fkey" FOREIGN KEY ("projectId","workspaceId") REFERENCES "projects"("id","workspaceId") ON DELETE CASCADE ON UPDATE CASCADE;
ALTER TABLE "variant_reframe_overrides" ADD CONSTRAINT "variant_reframe_overrides_commandId_workspaceId_fkey" FOREIGN KEY ("commandId","workspaceId") REFERENCES "edit_commands"("id","workspaceId") ON DELETE RESTRICT ON UPDATE CASCADE;
ALTER TABLE "variant_reframe_overrides" ADD CONSTRAINT "variant_reframe_overrides_baseVersionId_workspaceId_fkey" FOREIGN KEY ("baseVersionId","workspaceId") REFERENCES "project_versions"("id","workspaceId") ON DELETE RESTRICT ON UPDATE CASCADE;
ALTER TABLE "variant_reframe_overrides" ADD CONSTRAINT "variant_reframe_overrides_resultVersionId_workspaceId_fkey" FOREIGN KEY ("resultVersionId","workspaceId") REFERENCES "project_versions"("id","workspaceId") ON DELETE RESTRICT ON UPDATE CASCADE;
ALTER TABLE "variant_reframe_overrides" ADD CONSTRAINT "variant_reframe_overrides_previousOverrideId_workspaceId_fkey" FOREIGN KEY ("previousOverrideId","workspaceId") REFERENCES "variant_reframe_overrides"("id","workspaceId") ON DELETE RESTRICT ON UPDATE CASCADE;
ALTER TABLE "variant_reframe_override_heads" ADD CONSTRAINT "variant_reframe_override_heads_workspaceId_fkey" FOREIGN KEY ("workspaceId") REFERENCES "workspaces"("id") ON DELETE CASCADE ON UPDATE CASCADE;
ALTER TABLE "variant_reframe_override_heads" ADD CONSTRAINT "variant_reframe_override_heads_projectId_workspaceId_fkey" FOREIGN KEY ("projectId","workspaceId") REFERENCES "projects"("id","workspaceId") ON DELETE CASCADE ON UPDATE CASCADE;
ALTER TABLE "variant_reframe_override_heads" ADD CONSTRAINT "variant_reframe_override_heads_overrideId_workspaceId_fkey" FOREIGN KEY ("overrideId","workspaceId") REFERENCES "variant_reframe_overrides"("id","workspaceId") ON DELETE RESTRICT ON UPDATE CASCADE;

ALTER TABLE "edit_commands" DROP CONSTRAINT "edit_commands_type_check";
ALTER TABLE "edit_commands" ADD CONSTRAINT "edit_commands_type_check" CHECK ("type" IN (
  'apply-review-patch', 'apply-review-patch-batch', 'apply-subtitle-segment-override', 'apply-variant-reframe-override',
  'attach-media-library-reference', 'compare-action', 'compile-renderable-plan', 'direct-multicam-session', 'manual-edit', 'remove-spoken-content',
  'replace-source-transcript', 'run-director', 'set-project-color-plan',
  'set-project-lut-selection', 'set-project-policy-overrides', 'set-project-subtitle-mode',
  'create-output-variant', 'revise-output-spec'
));

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
