-- A creation (a project, a copy) fires w66_creation_bundle_deferred_v2 once per row it inserts, on thirteen tables, and every firing asserted the
-- complete bundle again: for a copy of a project whose State embeds the master's receipt each assertion takes seconds, so the SET CONSTRAINTS that
-- settles the transaction took (rows x seconds) and ran into the statement timeout. The assertion is a function of rows this statement does not
-- write, so its verdict for a State cannot change between two firings of the same statement. It is therefore made once per State, per statement,
-- under the rule w66_assert_normalization_v3 and w66_assert_operational_state_v3 already follow:
--   * the verdict is reused only for the same State, in the same statement, with the same number of rows written by this transaction to any
--     table (any write changes the count, a new statement changes the timestamp);
--   * with track_counts off nothing is reused;
--   * a refused check raises, so no refusal is ever remembered.
-- The assertion itself is untouched: it keeps its body under a new name and the entry point the triggers call decides whether it has to run.
CREATE FUNCTION w66_assert_creation_bundle_unmemoized_v2(state_id text) RETURNS void LANGUAGE plpgsql AS $$
DECLARE discriminator text;
BEGIN
 SELECT c."payloadJson"::jsonb#>>'{forkDerivation,schemaVersion}' INTO discriminator
 FROM project_output_states s JOIN project_creation_commands c ON c.id=s."creationCommandV2Id"
  AND c."workspaceId"=s."workspaceId" AND c."projectId"=s."projectId" AND c."versionId"=s."resultVersionId"
 WHERE s.id=state_id AND s."schemaVersion"='project-output-state/v2';
 IF discriminator='project-fork-derivation/v3' THEN PERFORM w66_assert_creation_fork_bundle_v3(state_id);
 ELSE PERFORM w66_assert_creation_bundle_source1_v2(state_id);END IF;
END $$;

CREATE OR REPLACE FUNCTION w66_assert_creation_bundle_v2(state_id text) RETURNS void LANGUAGE plpgsql AS $$
DECLARE memo_stamp text;memo_key text;memo_seen text;
BEGIN
 IF current_setting('track_counts')='on' THEN
  memo_stamp:=statement_timestamp()::text||':'||(SELECT coalesce(sum(x.n_tup_ins+x.n_tup_upd+x.n_tup_del),0) FROM pg_stat_xact_all_tables x WHERE x.schemaname='public')::text;
  memo_key:='|'||state_id||'|';
  memo_seen:=coalesce(current_setting('apollo.w66_creation_bundle_verified',true),'');
  IF split_part(memo_seen,E'\n',1)=memo_stamp AND position(memo_key in split_part(memo_seen,E'\n',2))>0 THEN RETURN;END IF;
 END IF;
 PERFORM w66_assert_creation_bundle_unmemoized_v2(state_id);
 IF memo_stamp IS NOT NULL THEN
  IF split_part(memo_seen,E'\n',1)=memo_stamp THEN PERFORM set_config('apollo.w66_creation_bundle_verified',memo_seen||memo_key,true);
  ELSE PERFORM set_config('apollo.w66_creation_bundle_verified',memo_stamp||E'\n'||memo_key,true);END IF;
 END IF;
END $$;
