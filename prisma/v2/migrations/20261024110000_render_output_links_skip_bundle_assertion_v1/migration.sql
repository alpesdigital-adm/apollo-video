-- A render output (the proxy or the final export of a Version) is linked to its project when the render is promoted. That insert fired the
-- deferred bundle assertion of the project's head State (13 tables share one trigger function), which re-verifies the WHOLE sealed State:
-- on a copy of a project that was already cut that is several seconds, and the owner transaction that links the output has 5 s
-- (found by the W70 rehearsal: the final export of the cut copy failed at its last write, "Transaction already closed", then again on retry).
--
-- Against an OPERATIONAL head (State v3: every cut copy and every ordinary project) that assertion only checks that each link the sealed
-- State names EXISTS; a link no sealed State names can never make it fail. So, and only there, the trigger function returns early for
-- the two roles that name a render output. The trigger itself is NOT changed: it still fires for every role on every table, and against a
-- Creation v2 head (a copy never cut, an empty project) the assertion is untouched and still demands the exact set of links (a bijection,
-- and no link at all on an empty project), so a render-output link inserted there is still refused. The body below is the one of
-- 20261014150000_project_fork_source_v3 plus the nested IF.
CREATE OR REPLACE FUNCTION w66_creation_bundle_deferred_v2() RETURNS trigger LANGUAGE plpgsql AS $$
DECLARE operational_state_id text; state_id text; contract integer; final_project projects%ROWTYPE; BEGIN
 operational_state_id:=w66_operational_event_state_v3(TG_TABLE_NAME,to_jsonb(NEW));
 IF operational_state_id IS NOT NULL THEN
  -- Only a link that names a render output, and only against an OPERATIONAL head (see the header of this migration). NEW.role exists on
  -- project_media_assets alone, hence the nested IF.
  IF TG_TABLE_NAME='project_media_assets' THEN IF NEW.role IN ('editorial-proxy','final-output') THEN RETURN NULL; END IF; END IF;
  PERFORM w66_assert_operational_state_v3(operational_state_id);RETURN NULL;END IF;
 CASE TG_TABLE_NAME
 WHEN 'project_output_states' THEN IF NEW."schemaVersion"<>'project-output-state/v2' THEN RETURN NULL; END IF; state_id:=NEW.id;
 WHEN 'project_versions' THEN IF NEW."outputContractVersion"<>2 THEN RETURN NULL; END IF; state_id:=NEW."outputStateId";
 WHEN 'project_creation_commands' THEN IF NEW."schemaVersion"<>2 THEN RETURN NULL; END IF;
  SELECT s.id INTO STRICT state_id FROM project_output_states s WHERE s."creationCommandV2Id"=NEW.id;
 WHEN 'output_variants' THEN IF NEW."createdCommandKind"<>'creation-command-v2' THEN RETURN NULL; END IF;
  SELECT s.id INTO STRICT state_id FROM project_output_states s WHERE s."creationCommandV2Id"=NEW."createdCommandId";
 WHEN 'output_spec_revisions' THEN IF NEW."schemaVersion" NOT IN ('output-spec-revision/v2','output-spec-revision/v3') THEN RETURN NULL; END IF;
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
