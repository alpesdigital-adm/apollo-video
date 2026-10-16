-- Operational W66 children. No activation of the sixteen runtime writers here.
-- v1/v2 validator bodies and digest policies remain preserved below dispatch.
CREATE TABLE output_normalization_receipts (
 id varchar(128) PRIMARY KEY,"workspaceId" varchar(128) NOT NULL,"projectId" varchar(128) NOT NULL,
 "operationId" varchar(128) NOT NULL,"sourceArtifactId" varchar(128) NOT NULL,"sourceManifestId" varchar(128) NOT NULL,
 "sourceManifestHash" char(64) NOT NULL,"derivativeArtifactId" varchar(128) NOT NULL,"derivativeManifestId" varchar(128) NOT NULL,
 "derivativeManifestHash" char(64) NOT NULL,"receiptJson" text NOT NULL,"receiptHash" char(64) NOT NULL,"createdAt" timestamptz(3) NOT NULL,
 CONSTRAINT output_normalization_seal_key UNIQUE(id,"projectId","workspaceId","receiptHash"),
 FOREIGN KEY("projectId","workspaceId") REFERENCES projects(id,"workspaceId") DEFERRABLE INITIALLY DEFERRED,
 FOREIGN KEY("operationId","workspaceId") REFERENCES public_operations(id,"workspaceId") DEFERRABLE INITIALLY DEFERRED,
 FOREIGN KEY("sourceManifestId","sourceArtifactId","workspaceId","sourceManifestHash")
  REFERENCES media_artifact_manifests(id,"artifactId","workspaceId","manifestHash") DEFERRABLE INITIALLY DEFERRED,
 FOREIGN KEY("derivativeManifestId","derivativeArtifactId","workspaceId","derivativeManifestHash")
  REFERENCES media_artifact_manifests(id,"artifactId","workspaceId","manifestHash") DEFERRABLE INITIALLY DEFERRED,
 CHECK("receiptHash"=w66_v2_sha("receiptJson")),
 CHECK(("receiptJson"::jsonb->>'schemaVersion') IS NOT DISTINCT FROM 'output-normalization-receipt/v3'),
 CHECK(("receiptJson"::jsonb->>'canonicalPolicyVersion') IS NOT DISTINCT FROM 'output-canonical-json/v1')
);
CREATE TABLE output_materializations (
 id varchar(128) PRIMARY KEY,"workspaceId" varchar(128) NOT NULL,"projectId" varchar(128) NOT NULL,
 "resultVersionId" varchar(128) NOT NULL,"variantId" varchar(128) NOT NULL,"outputSpecRevisionId" varchar(128) NOT NULL,
 "specHash" char(64) NOT NULL,"planSnapshotId" varchar(128) NOT NULL,"planHash" char(64) NOT NULL,
 "materializationJson" text NOT NULL,"materializationHash" char(64) NOT NULL,"createdAt" timestamptz(3) NOT NULL,
 CONSTRAINT output_materialization_seal_key UNIQUE(id,"projectId","workspaceId","materializationHash"),
 UNIQUE("resultVersionId","variantId","projectId","workspaceId"),
 FOREIGN KEY("resultVersionId","projectId","workspaceId") REFERENCES project_versions(id,"projectId","workspaceId") DEFERRABLE INITIALLY DEFERRED,
 FOREIGN KEY("outputSpecRevisionId","variantId","projectId","workspaceId","specHash")
  REFERENCES output_spec_revisions(id,"variantId","projectId","workspaceId","specHash") DEFERRABLE INITIALLY DEFERRED,
 FOREIGN KEY("planSnapshotId","projectId","workspaceId","planHash")
  REFERENCES project_snapshots(id,"projectId","workspaceId","contentHash") DEFERRABLE INITIALLY DEFERRED,
 CHECK("materializationHash"=w66_v2_sha("materializationJson")),
 CHECK(("materializationJson"::jsonb->>'schemaVersion') IS NOT DISTINCT FROM 'output-materialization/v3'),
 CHECK(("materializationJson"::jsonb->>'canonicalPolicyVersion') IS NOT DISTINCT FROM 'output-canonical-json/v1')
);
CREATE TABLE output_materialization_normalizations (
 "materializationId" varchar(128) NOT NULL,"normalizationId" varchar(128) NOT NULL,"normalizationHash" char(64) NOT NULL,
 "workspaceId" varchar(128) NOT NULL,"projectId" varchar(128) NOT NULL,PRIMARY KEY("materializationId","normalizationId"),
 FOREIGN KEY("materializationId") REFERENCES output_materializations(id) DEFERRABLE INITIALLY DEFERRED,
 FOREIGN KEY("normalizationId","projectId","workspaceId","normalizationHash")
  REFERENCES output_normalization_receipts(id,"projectId","workspaceId","receiptHash") DEFERRABLE INITIALLY DEFERRED
);
CREATE TABLE output_operational_bundles (
 "versionId" varchar(128) PRIMARY KEY,"workspaceId" varchar(128) NOT NULL,"projectId" varchar(128) NOT NULL,"stateId" varchar(128) NOT NULL,
 "bundleJson" text NOT NULL,"bundleHash" char(64) NOT NULL,"originJson" text NOT NULL,"originHash" char(64) NOT NULL,
 "producerPayloadJson" text,"producerPayloadHash" char(64),
 UNIQUE("stateId","projectId","workspaceId"),
 FOREIGN KEY("versionId","stateId","projectId","workspaceId") REFERENCES project_output_states("resultVersionId",id,"projectId","workspaceId") DEFERRABLE INITIALLY DEFERRED,
 FOREIGN KEY("versionId","projectId","workspaceId") REFERENCES project_versions(id,"projectId","workspaceId") DEFERRABLE INITIALLY DEFERRED,
 CHECK("bundleHash"=w66_v2_sha("bundleJson") AND "originHash"=w66_v2_sha("originJson")),
 CHECK(("producerPayloadJson" IS NULL AND "producerPayloadHash" IS NULL) OR ("producerPayloadJson" IS NOT NULL AND "producerPayloadHash" IS NOT NULL AND "producerPayloadHash"=w66_v2_sha("producerPayloadJson")))
);
ALTER TABLE project_output_state_entries ADD COLUMN "materializationId" varchar(128);
ALTER TABLE project_output_state_entries ADD CONSTRAINT output_entry_materialization_seal_fk
 FOREIGN KEY("materializationId","projectId","workspaceId","geometryProjectionHash")
 REFERENCES output_materializations(id,"projectId","workspaceId","materializationHash") DEFERRABLE INITIALLY DEFERRED;

-- Only incompatible enum checks gain a v3 discriminator. Compatible SHA,
-- policy, nullability, scope and parent checks stay active for all contracts.
DO $$ DECLARE c record; gate text; BEGIN
 FOR c IN SELECT pc.conname,pc.conrelid::regclass AS relation,pg_get_expr(pc.conbin,pc.conrelid) AS expression
 FROM pg_constraint pc WHERE pc.contype='c' AND pc.conrelid IN ('project_versions'::regclass,'project_output_states'::regclass,'project_output_state_entries'::regclass) LOOP
 gate:=NULL;
 IF c.relation::text='project_versions' AND c.conname='project_versions_output_contract_check' THEN
  gate:='"outputContractVersion"=3 AND "outputStateId" IS NOT NULL AND "outputStateHash" IS NOT NULL AND "outputBaseHashJson" IS NOT NULL AND "outputVersionJson" IS NOT NULL AND "baseHash"=w66_v2_sha("outputBaseHashJson")';
 ELSIF c.relation::text='project_output_states' AND
  (position('project-output-state/v1' in c.expression)>0 OR position('project-output-transition/v1' in c.expression)>0 OR
   position('initialize-empty' in c.expression)>0) THEN gate:='"schemaVersion"=''project-output-state/v3''';
 ELSIF c.relation::text='project_output_state_entries' AND position('"geometryStatus"' in c.expression)>0 THEN
  gate:='("geometryStatus"=''blocked-v3'' AND "materializationId" IS NULL AND "geometryProjectionHash" IS NULL) OR ("geometryStatus"=''materialized-v3'' AND "materializationId" IS NOT NULL AND "geometryProjectionHash" IS NOT NULL)';
 END IF;
 IF gate IS NOT NULL THEN
  EXECUTE format('ALTER TABLE %s DROP CONSTRAINT %I',c.relation,c.conname);
  EXECUTE format('ALTER TABLE %s ADD CONSTRAINT %I CHECK ((%s) OR (%s))',c.relation,c.conname,gate,c.expression);
 END IF;
 END LOOP;
END $$;
CREATE FUNCTION w66_assert_artifact_fact_v3(p_fact jsonb,p_workspace text) RETURNS void LANGUAGE plpgsql AS $$
DECLARE a media_artifacts%ROWTYPE;mf media_artifact_manifests%ROWTYPE;d jsonb;rp recipe_parameter_payloads%ROWTYPE;ri render_input_payloads%ROWTYPE;
BEGIN
 IF NOT w66_v2_exact_json(p_fact,ARRAY['artifactId','manifestId','manifest']) THEN RAISE EXCEPTION 'W66v3 artifact fact shape' USING ERRCODE='23514'; END IF;
 SELECT * INTO STRICT a FROM media_artifacts WHERE id=p_fact->>'artifactId' AND "workspaceId"=p_workspace;
 SELECT * INTO STRICT mf FROM media_artifact_manifests WHERE id=p_fact->>'manifestId' AND "workspaceId"=p_workspace AND "artifactId"=a.id;
 d:=p_fact->'manifest';
 IF mf."manifestJson"::jsonb IS DISTINCT FROM d OR d->>'schemaVersion' IS DISTINCT FROM mf."schemaVersion" OR d->>'manifestHash' IS DISTINCT FROM mf."manifestHash"
 OR d#>>'{artifact,artifactKey}' IS DISTINCT FROM a."artifactKey" OR d#>>'{artifact,sha256}' IS DISTINCT FROM a.sha256
 OR (d#>>'{artifact,byteSize}')::bigint IS DISTINCT FROM a."byteSize" OR d#>>'{artifact,mediaType}' IS DISTINCT FROM a."mediaType"
 OR d#>>'{artifact,container}' IS DISTINCT FROM a.container OR d#>>'{recipe,id}' IS DISTINCT FROM mf."recipeId"
 OR d#>>'{recipe,version}' IS DISTINCT FROM mf."recipeVersion" OR d#>>'{recipe,parametersHash}' IS DISTINCT FROM mf."parametersHash" THEN
  RAISE EXCEPTION 'W66v3 manifest/artifact/recipe factual binding' USING ERRCODE='23514'; END IF;
 IF mf."schemaVersion" IN ('media-artifact-manifest/v3','media-artifact-manifest/v4') THEN
  SELECT * INTO STRICT rp FROM recipe_parameter_payloads WHERE ref=mf."recipeParametersRef" AND "workspaceId"=p_workspace;
  IF rp.ref IS DISTINCT FROM d#>>'{recipe,parametersRef}' OR rp.ref IS DISTINCT FROM 'recipe-parameters/sha256/'||mf."parametersHash"
   OR rp."parametersHash" IS DISTINCT FROM mf."parametersHash" OR rp.algorithm<>'aes-256-gcm' OR rp."canonicalByteSize" NOT BETWEEN 1 AND 1048576
   OR rp."keyId" IS NULL OR rp.nonce IS NULL OR rp."authTag" IS NULL OR rp.ciphertext IS NULL THEN
   RAISE EXCEPTION 'W66v3 protected recipe binding' USING ERRCODE='23514'; END IF;
 ELSIF mf."recipeParametersRef" IS NOT NULL THEN RAISE EXCEPTION 'W66v3 unexpected recipe reference' USING ERRCODE='23514'; END IF;
 IF mf."schemaVersion"='media-artifact-manifest/v4' THEN
  SELECT * INTO STRICT ri FROM render_input_payloads WHERE ref=mf."renderInputRef" AND "workspaceId"=p_workspace;
  IF ri.ref IS DISTINCT FROM d#>>'{renderInput,ref}' OR ri."inputHash" IS DISTINCT FROM d#>>'{renderInput,inputHash}'
   OR mf."renderInputHash" IS DISTINCT FROM ri."inputHash" OR ri.ref IS DISTINCT FROM 'render-input/sha256/'||ri."inputHash"
   OR ri.algorithm<>'aes-256-gcm' OR ri."canonicalByteSize" NOT BETWEEN 1 AND 4194304 THEN
   RAISE EXCEPTION 'W66v3 protected render input binding' USING ERRCODE='23514'; END IF;
 ELSIF mf."renderInputRef" IS NOT NULL OR mf."renderInputHash" IS NOT NULL THEN
  RAISE EXCEPTION 'W66v3 unexpected render reference' USING ERRCODE='23514'; END IF;
EXCEPTION WHEN no_data_found THEN RAISE EXCEPTION 'W66v3 artifact fact missing' USING ERRCODE='23514';
END $$;
CREATE FUNCTION w66_assert_probe_v3(p_probe jsonb,p_manifest jsonb) RETURNS void LANGUAGE plpgsql AS $$
DECLARE raw jsonb;stream_doc jsonb;f record;frames jsonb;previous_pts bigint;rotations jsonb;measured text;duration_value text;observed_end bigint;
BEGIN
 IF NOT w66_v2_exact_json(p_probe,ARRAY['schemaVersion','binarySha256','rawJson','rawSha256','streamIndex','mediaType','sampleRateHz','channels','originSource','originSeconds','width','height','fps','rotationDegrees','timeBase','frames','frameEndPts','endPts'])
 OR p_probe->>'schemaVersion' IS DISTINCT FROM 'output-observed-probe/v3' OR p_probe->>'rawSha256' IS DISTINCT FROM w66_v2_sha(p_probe->>'rawJson')
 OR p_probe->>'binarySha256' !~ '^[a-f0-9]{64}$' OR octet_length(p_probe->>'rawJson')>67108864 THEN
  RAISE EXCEPTION 'W66v3 probe raw authority' USING ERRCODE='23514'; END IF;
 raw:=(p_probe->>'rawJson')::jsonb;
 IF jsonb_typeof(raw->'streams') IS DISTINCT FROM 'array' OR jsonb_typeof(raw->'frames') IS DISTINCT FROM 'array'
 OR EXISTS(SELECT 1 FROM jsonb_array_elements(raw->'streams') AS si(element) WHERE jsonb_typeof(si.element) IS DISTINCT FROM 'object'
   OR jsonb_typeof(si.element->'index') IS DISTINCT FROM 'number' OR (si.element->>'index') !~ '^(0|[1-9][0-9]*)$'
   OR (si.element->>'index')::numeric>9007199254740991)
 OR EXISTS(SELECT 1 FROM jsonb_array_elements(raw->'streams') AS si(element) GROUP BY si.element->'index' HAVING count(*)>1) THEN
  RAISE EXCEPTION 'W66v3 probe malformed/duplicate stream' USING ERRCODE='23514'; END IF;
 SELECT si.element INTO STRICT stream_doc FROM jsonb_array_elements(raw->'streams') AS si(element) WHERE si.element->'index'=p_probe->'streamIndex';
 IF p_probe->>'mediaType' NOT IN ('video','audio') OR stream_doc->>'codec_type' IS DISTINCT FROM p_probe->>'mediaType'
 OR NOT w66_v2_exact_json(p_probe->'timeBase',ARRAY['numerator','denominator'])
 OR (p_probe#>>'{timeBase,numerator}') !~ '^[1-9][0-9]{0,9}$' OR (p_probe#>>'{timeBase,denominator}') !~ '^[1-9][0-9]{0,9}$'
 OR (p_probe#>>'{timeBase,numerator}')::bigint>2147483647 OR (p_probe#>>'{timeBase,denominator}')::bigint>2147483647
 OR stream_doc->>'time_base' IS DISTINCT FROM (p_probe#>>'{timeBase,numerator}')||'/'||(p_probe#>>'{timeBase,denominator}') THEN
  RAISE EXCEPTION 'W66v3 probe stream/timebase differs' USING ERRCODE='23514'; END IF;
 IF p_probe->>'mediaType'='video' THEN
  IF stream_doc->'width' IS DISTINCT FROM p_probe->'width' OR stream_doc->'height' IS DISTINCT FROM p_probe->'height'
  OR (p_probe->>'width')::integer<1 OR (p_probe->>'height')::integer<1 OR p_probe->'sampleRateHz' IS DISTINCT FROM 'null'::jsonb
  OR p_probe->'channels' IS DISTINCT FROM 'null'::jsonb OR NOT w66_v2_exact_json(p_probe->'fps',ARRAY['numerator','denominator'])
  OR (p_probe#>>'{fps,numerator}') !~ '^[1-9][0-9]{0,9}$' OR (p_probe#>>'{fps,denominator}') !~ '^[1-9][0-9]{0,9}$'
  OR stream_doc->>'avg_frame_rate' IS DISTINCT FROM (p_probe#>>'{fps,numerator}')||'/'||(p_probe#>>'{fps,denominator}')
  OR (p_manifest#>>'{probe,width}')::integer IS DISTINCT FROM (p_probe->>'width')::integer
  OR (p_manifest#>>'{probe,height}')::integer IS DISTINCT FROM (p_probe->>'height')::integer
  OR (p_manifest#>>'{probe,fps}')::double precision IS DISTINCT FROM (p_probe#>>'{fps,numerator}')::double precision/(p_probe#>>'{fps,denominator}')::double precision THEN
   RAISE EXCEPTION 'W66v3 probe video/manifest binding' USING ERRCODE='23514'; END IF;
 ELSE
  IF p_probe->'width' IS DISTINCT FROM '0'::jsonb OR p_probe->'height' IS DISTINCT FROM '0'::jsonb OR p_probe->'fps' IS DISTINCT FROM 'null'::jsonb
  OR (stream_doc->>'sample_rate')::integer IS DISTINCT FROM (p_probe->>'sampleRateHz')::integer OR (p_probe->>'sampleRateHz')::integer<1
  OR stream_doc->'channels' IS DISTINCT FROM p_probe->'channels' OR (p_probe->>'channels')::integer NOT BETWEEN 1 AND 8 THEN
   RAISE EXCEPTION 'W66v3 probe audio binding' USING ERRCODE='23514'; END IF;
 END IF;
 IF p_probe->>'originSource'='format-start-time' THEN measured:=raw#>>'{format,start_time}';
 ELSIF p_probe->>'originSource'='stream-start-time' THEN measured:=stream_doc->>'start_time';
 ELSE RAISE EXCEPTION 'W66v3 probe origin missing' USING ERRCODE='23514'; END IF;
 IF measured IS NULL OR measured !~ '^-?[0-9]+([.][0-9]{1,18})?$'
 OR NOT w66_v2_exact_json(p_probe->'originSeconds',ARRAY['numerator','denominator'])
 OR (p_probe#>>'{originSeconds,numerator}') !~ '^-?(0|[1-9][0-9]*)$' OR (p_probe#>>'{originSeconds,denominator}') !~ '^[1-9][0-9]*$'
 OR (p_probe#>>'{originSeconds,numerator}')::numeric IS DISTINCT FROM measured::numeric*(p_probe#>>'{originSeconds,denominator}')::numeric THEN
  RAISE EXCEPTION 'W66v3 measured origin differs' USING ERRCODE='23514'; END IF;
 -- Every slot is checked before filtering, including numeric precision loss.
 FOR f IN SELECT fi.element FROM jsonb_array_elements(raw->'frames') AS fi(element) LOOP
  duration_value:=coalesce(f.element->>'duration',f.element->>'pkt_duration');
  IF jsonb_typeof(f.element) IS DISTINCT FROM 'object' OR (f.element->>'stream_index') !~ '^(0|[1-9][0-9]*)$'
  OR NOT EXISTS(SELECT 1 FROM jsonb_array_elements(raw->'streams') AS si(element) WHERE si.element->'index'=f.element->'stream_index' AND si.element->'codec_type'=f.element->'media_type')
  OR (f.element->>'best_effort_timestamp') !~ '^-?(0|[1-9][0-9]*)$' OR duration_value IS NULL OR duration_value !~ '^[1-9][0-9]*$'
  OR (jsonb_typeof(f.element->'best_effort_timestamp')='number' AND abs((f.element->>'best_effort_timestamp')::numeric)>9007199254740991)
  OR (jsonb_typeof(coalesce(f.element->'duration',f.element->'pkt_duration'))='number' AND duration_value::numeric>9007199254740991) THEN
   RAISE EXCEPTION 'W66v3 malformed/unsafe raw frame' USING ERRCODE='23514'; END IF;
 END LOOP;
 SELECT coalesce(jsonb_agg(fi.element ORDER BY fi.ordinal),'[]'::jsonb) INTO frames
 FROM jsonb_array_elements(raw->'frames') WITH ORDINALITY AS fi(element,ordinal)
 WHERE fi.element->>'media_type'=p_probe->>'mediaType' AND fi.element->'stream_index'=p_probe->'streamIndex';
 IF jsonb_array_length(frames)=0 OR jsonb_array_length(frames)<>jsonb_array_length(p_probe->'frames')
 OR jsonb_array_length(frames)<>jsonb_array_length(p_probe->'frameEndPts') THEN
  RAISE EXCEPTION 'W66v3 full probe frame sequence missing' USING ERRCODE='23514'; END IF;
 FOR f IN SELECT fi.element,fi.ordinal FROM jsonb_array_elements(p_probe->'frames') WITH ORDINALITY AS fi(element,ordinal) LOOP
  duration_value:=coalesce(frames->(f.ordinal-1)::integer->>'duration',frames->(f.ordinal-1)::integer->>'pkt_duration');
  observed_end:=(f.element->>'pts')::bigint+duration_value::bigint;
  IF NOT w66_v2_exact_json(f.element,ARRAY['frame','pts','timeBase']) OR (f.element->>'frame')::bigint IS DISTINCT FROM f.ordinal-1
  OR f.element->'timeBase' IS DISTINCT FROM p_probe->'timeBase'
  OR f.element->>'pts' IS DISTINCT FROM frames->(f.ordinal-1)::integer->>'best_effort_timestamp'
  OR (previous_pts IS NOT NULL AND (f.element->>'pts')::bigint<=previous_pts)
  OR (f.element->>'pts')::bigint=-9223372036854775808 OR (p_probe->'frameEndPts'->>(f.ordinal-1)::integer)::bigint IS DISTINCT FROM observed_end THEN
   RAISE EXCEPTION 'W66v3 raw PTS/end sequence differs' USING ERRCODE='23514'; END IF;
  previous_pts:=(f.element->>'pts')::bigint;
 END LOOP;
 IF (p_probe->>'endPts')::bigint IS DISTINCT FROM observed_end THEN RAISE EXCEPTION 'W66v3 terminal measured boundary differs' USING ERRCODE='23514'; END IF;
 SELECT coalesce(jsonb_agg(si.element->'rotation'),'[]'::jsonb) INTO rotations FROM jsonb_array_elements(coalesce(stream_doc->'side_data_list','[]'::jsonb)) AS si(element) WHERE si.element ? 'rotation';
 IF (jsonb_array_length(rotations)=0 AND NOT coalesce(stream_doc->'tags' ? 'rotate',false) AND p_probe->'rotationDegrees' IS DISTINCT FROM '0'::jsonb)
 OR EXISTS(SELECT 1 FROM jsonb_array_elements(rotations) AS rr(element) WHERE (rr.element#>>'{}')::double precision IS DISTINCT FROM (p_probe->>'rotationDegrees')::double precision)
 OR (stream_doc->'tags' ? 'rotate' AND (stream_doc#>>'{tags,rotate}')::double precision IS DISTINCT FROM (p_probe->>'rotationDegrees')::double precision) THEN
  RAISE EXCEPTION 'W66v3 observed rotation differs' USING ERRCODE='23514'; END IF;
EXCEPTION WHEN no_data_found OR too_many_rows OR invalid_text_representation OR numeric_value_out_of_range OR division_by_zero THEN
 RAISE EXCEPTION 'W66v3 malformed observed probe authority' USING ERRCODE='23514';
END $$;
CREATE FUNCTION w66_assert_normalization_v3(p_id text,p_project text,p_workspace text) RETURNS void LANGUAGE plpgsql AS $$
DECLARE n output_normalization_receipts%ROWTYPE;d jsonb;o public_operations%ROWTYPE;e jsonb;slot text;audio jsonb;video jsonb;argv_expected jsonb;
BEGIN
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
EXCEPTION WHEN no_data_found OR too_many_rows OR invalid_text_representation OR numeric_value_out_of_range THEN
 RAISE EXCEPTION 'W66v3 normalization factual row/shape missing' USING ERRCODE='23514';
END $$;

CREATE FUNCTION w66_fraction_v3(p_n numeric,p_d numeric) RETURNS jsonb LANGUAGE plpgsql IMMUTABLE AS $$
DECLARE a numeric:=abs(p_n);b numeric:=p_d;r numeric;g numeric;
BEGIN
 IF p_d<=0 OR p_n<>trunc(p_n) OR p_d<>trunc(p_d) THEN RAISE EXCEPTION 'W66v3 fraction invalid' USING ERRCODE='23514'; END IF;
 WHILE b<>0 LOOP r:=mod(a,b);a:=b;b:=r;END LOOP;g:=a;
 RETURN jsonb_build_object('numerator',trunc(p_n/g)::text,'denominator',trunc(p_d/g)::text);
END $$;
CREATE FUNCTION w66_frame_seconds_v3(p_frame bigint,p_fps double precision) RETURNS jsonb LANGUAGE plpgsql IMMUTABLE AS $$
DECLARE bytes bytea:=float8send(p_fps);exponent integer;mantissa numeric;denominator numeric:=1;i integer;exponent_shift integer;
BEGIN
 IF p_fps<1 OR p_fps>120 OR p_frame<0 THEN RAISE EXCEPTION 'W66v3 FPS/frame domain invalid' USING ERRCODE='23514'; END IF;
 exponent:=((get_byte(bytes,0)&127)<<4)|(get_byte(bytes,1)>>4);mantissa:=get_byte(bytes,1)&15;
 FOR i IN 2..7 LOOP mantissa:=mantissa*256+get_byte(bytes,i);END LOOP;
 mantissa:=mantissa+4503599627370496;exponent_shift:=exponent-1023-52;
 IF exponent_shift>=0 THEN mantissa:=mantissa*power(2::numeric,exponent_shift);ELSE denominator:=power(2::numeric,-exponent_shift);END IF;
 RETURN w66_fraction_v3(p_frame*denominator,mantissa);
END $$;
CREATE FUNCTION w66_pts_compare_v3(p_pts text,p_probe jsonb,p_seconds jsonb) RETURNS integer LANGUAGE sql IMMUTABLE AS $$
 SELECT CASE WHEN ((p_pts::numeric*(p_probe#>>'{timeBase,numerator}')::numeric*(p_probe#>>'{originSeconds,denominator}')::numeric-
  (p_probe#>>'{originSeconds,numerator}')::numeric*(p_probe#>>'{timeBase,denominator}')::numeric)*(p_seconds->>'denominator')::numeric)
  < ((p_seconds->>'numerator')::numeric*(p_probe#>>'{timeBase,denominator}')::numeric*(p_probe#>>'{originSeconds,denominator}')::numeric) THEN -1
 WHEN ((p_pts::numeric*(p_probe#>>'{timeBase,numerator}')::numeric*(p_probe#>>'{originSeconds,denominator}')::numeric-
  (p_probe#>>'{originSeconds,numerator}')::numeric*(p_probe#>>'{timeBase,denominator}')::numeric)*(p_seconds->>'denominator')::numeric)
  > ((p_seconds->>'numerator')::numeric*(p_probe#>>'{timeBase,denominator}')::numeric*(p_probe#>>'{originSeconds,denominator}')::numeric) THEN 1 ELSE 0 END
$$;
CREATE FUNCTION w66_range_coverage_v3(p_probe jsonb,p_start jsonb,p_end jsonb) RETURNS jsonb LANGUAGE plpgsql AS $$
DECLARE f record;first_frame integer;last_frame integer;covered_end numeric;frame_end text;segments jsonb:='[]';gaps jsonb:='[]';
BEGIN
 IF w66_pts_compare_v3(p_probe->>'endPts',p_probe,p_end)<0 OR w66_pts_compare_v3(p_probe#>>'{frames,0,pts}',p_probe,p_start)>0 THEN
  RAISE EXCEPTION 'W66v3 range exceeds measured initial/terminal coverage' USING ERRCODE='23514'; END IF;
 FOR f IN SELECT fi.element,fi.ordinal FROM jsonb_array_elements(p_probe->'frames') WITH ORDINALITY AS fi(element,ordinal) LOOP
  frame_end:=p_probe->'frameEndPts'->>(f.ordinal-1)::integer;
  IF w66_pts_compare_v3(frame_end,p_probe,p_start)>0 AND w66_pts_compare_v3(f.element->>'pts',p_probe,p_end)<0 THEN
   IF first_frame IS NULL THEN first_frame:=f.ordinal-1;END IF;
   IF covered_end IS NOT NULL AND (f.element->>'pts')::numeric>covered_end THEN
    gaps:=gaps||jsonb_build_array(jsonb_build_object('startPts',trunc(covered_end)::text,'endPts',f.element->>'pts'));END IF;
   segments:=segments||jsonb_build_array(jsonb_build_object('frame',f.ordinal-1,'startPts',f.element->>'pts','endPts',frame_end));
   last_frame:=f.ordinal-1;covered_end:=greatest(covered_end,frame_end::numeric);
  END IF;
 END LOOP;
 IF first_frame IS NULL OR w66_pts_compare_v3(p_probe->'frames'->first_frame->>'pts',p_probe,p_start)>0
 OR w66_pts_compare_v3(trunc(covered_end)::text,p_probe,p_end)<0 THEN
  RAISE EXCEPTION 'W66v3 range boundary lies in an observed gap' USING ERRCODE='23514'; END IF;
 RETURN jsonb_build_object('originSeconds',p_probe->'originSeconds','firstFrame',first_frame,'lastFrame',last_frame,
  'endExclusivePts',trunc(covered_end)::text,'timeBase',p_probe->'timeBase','coverage',CASE WHEN jsonb_array_length(gaps)=0 THEN 'complete' ELSE 'contains-measured-gaps' END,
  'segments',segments,'gaps',gaps);
END $$;
CREATE FUNCTION w66_observed_range_v3(p_source jsonb,p_derivative jsonb,p_start_frame bigint,p_end_frame bigint,p_fps double precision) RETURNS jsonb LANGUAGE plpgsql AS $$
DECLARE start_seconds jsonb;end_seconds jsonb;
BEGIN
 IF p_start_frame<0 OR p_end_frame<=p_start_frame THEN RAISE EXCEPTION 'W66v3 invalid frame range' USING ERRCODE='23514'; END IF;
 start_seconds:=w66_frame_seconds_v3(p_start_frame,p_fps);end_seconds:=w66_frame_seconds_v3(p_end_frame,p_fps);
 RETURN jsonb_build_object('schemaVersion','observed-output-range/v3','startSeconds',start_seconds,'endSeconds',end_seconds,
  'source',w66_range_coverage_v3(p_source,start_seconds,end_seconds),'derivative',w66_range_coverage_v3(p_derivative,start_seconds,end_seconds));
END $$;

CREATE FUNCTION w66_assert_materialization_v3(p_id text,p_project text,p_workspace text) RETURNS void LANGUAGE plpgsql AS $$
DECLARE m output_materializations%ROWTYPE;d jsonb;p jsonb;sp project_snapshots%ROWTYPE;re output_spec_revisions%ROWTYPE;item record;clip_doc jsonb;track_doc jsonb;
 n output_normalization_receipts%ROWTYPE;normalized jsonb;audio_n output_normalization_receipts%ROWTYPE;span double precision;rounded_span bigint;audio_source jsonb;audio_derivative jsonb;expected_audio jsonb;music_track jsonb;analysis music_analyses%ROWTYPE;
BEGIN
 SELECT * INTO STRICT m FROM output_materializations WHERE id=p_id AND "projectId"=p_project AND "workspaceId"=p_workspace;
 SELECT * INTO STRICT sp FROM project_snapshots WHERE id=m."planSnapshotId" AND "projectId"=p_project AND "workspaceId"=p_workspace AND "contentHash"=m."planHash" AND kind='edit-plan';
 SELECT * INTO STRICT re FROM output_spec_revisions WHERE id=m."outputSpecRevisionId" AND "variantId"=m."variantId" AND "specHash"=m."specHash" AND "projectId"=p_project AND "workspaceId"=p_workspace;
 d:=m."materializationJson"::jsonb;p:=sp."contentJson"::jsonb;
 IF NOT w66_v2_exact_json(d,ARRAY['schemaVersion','canonicalPolicyVersion','id','workspaceId','projectId','resultVersionId','variantId','outputSpecRevisionId','specHash',
  'planSnapshotId','planHash','fps','durationFrames','videoTracks','clips','audioTracks','music','overlayTracks','subtitleTracks','composition','normalizations','emission','createdAt'])
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
 IF jsonb_array_length(d->'normalizations')<>(SELECT count(*) FROM output_materialization_normalizations mn WHERE mn."materializationId"=m.id)
 OR jsonb_array_length(d->'clips')<>(SELECT count(*) FROM jsonb_array_elements(p->'videoTracks') AS pt(element)
   CROSS JOIN LATERAL jsonb_array_elements(pt.element->'clips') AS pc(element)) THEN
  RAISE EXCEPTION 'W66v3 materialization membership differs' USING ERRCODE='23514'; END IF;
 FOR item IN SELECT nx.element FROM jsonb_array_elements(d->'normalizations') AS nx(element) LOOP
  SELECT nr.* INTO STRICT n FROM output_normalization_receipts nr JOIN output_materialization_normalizations mn ON mn."normalizationId"=nr.id AND mn."normalizationHash"=nr."receiptHash"
   AND mn."projectId"=nr."projectId" AND mn."workspaceId"=nr."workspaceId" WHERE mn."materializationId"=m.id AND nr.id=item.element#>>'{document,id}'
    AND nr."projectId"=p_project AND nr."workspaceId"=p_workspace;
  IF item.element IS DISTINCT FROM jsonb_build_object('document',n."receiptJson"::jsonb,'receiptHash',n."receiptHash") THEN
   RAISE EXCEPTION 'W66v3 materialization normalization seal differs' USING ERRCODE='23514'; END IF;
  PERFORM w66_assert_normalization_v3(n.id,p_project,p_workspace);
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
   AND "workspaceId"=p_workspace AND "projectId"=p_project AND "sourceArtifactId"=clip_doc->>'sourceArtifactId';
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
   AND "projectId"=p_project AND "workspaceId"=p_workspace AND id IN (SELECT mn."normalizationId" FROM output_materialization_normalizations mn WHERE mn."materializationId"=m.id);
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
   AND "workspaceId"=p_workspace AND "projectId"=p_project AND "sourceArtifactId"=music_track->>'artifactId';
  SELECT ma.* INTO STRICT analysis FROM music_analyses ma JOIN project_versions av ON av.id=ma."projectVersionId" AND av."workspaceId"=ma."workspaceId"
   WHERE ma.id=music_track->>'analysisId' AND ma."analysisHash"=music_track->>'analysisHash' AND ma."workspaceId"=p_workspace AND av."projectId"=p_project;
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

CREATE FUNCTION w66_assert_revision_origin_v3(p_command edit_commands,p_base_state project_output_states,p_result_state project_output_states) RETURNS void LANGUAGE plpgsql AS $$
DECLARE payload jsonb:=p_command."outputPayloadJson"::jsonb;r output_spec_revisions%ROWTYPE;variant output_variants%ROWTYPE;previous output_spec_revisions%ROWTYPE;entry_doc jsonb;
BEGIN
 IF p_command.type NOT IN ('create-output-variant','revise-output-spec') OR p_command."outputPayloadJson" IS NULL OR p_command."outputPayloadHash" IS NULL
 OR p_command."outputPayloadHash" IS DISTINCT FROM w66_v2_sha(p_command."outputPayloadJson") OR payload IS DISTINCT FROM p_command."payloadJson"::jsonb THEN
  RAISE EXCEPTION 'W66v3 revision Command payload authority' USING ERRCODE='23514';END IF;
 SELECT * INTO STRICT r FROM output_spec_revisions WHERE id=payload#>>'{revision,id}' AND "projectId"=p_result_state."projectId" AND "workspaceId"=p_result_state."workspaceId";
 SELECT * INTO STRICT variant FROM output_variants WHERE id=r."variantId" AND "projectId"=r."projectId" AND "workspaceId"=r."workspaceId";
 SELECT ei.element INTO STRICT entry_doc FROM jsonb_array_elements(p_result_state."stateJson"::jsonb->'entries') AS ei(element) WHERE ei.element->>'variantId'=r."variantId";
 IF r."createdCommandKind" IS DISTINCT FROM 'edit-command' OR r."createdCommandId" IS DISTINCT FROM p_command.id OR r."createdCommandHash" IS DISTINCT FROM p_command."commandHash"
 OR r."canonicalPolicyVersion" IS DISTINCT FROM 'output-canonical-json/v1' OR r."schemaVersion" IS DISTINCT FROM 'output-spec-revision/v1'
 OR r."specJson"::jsonb IS DISTINCT FROM payload->'revision' OR r."specHash" IS DISTINCT FROM payload->>'revisionSpecHash'
 OR r."specHash" IS DISTINCT FROM w66_v2_sha(r."specJson") OR r."specJson"::jsonb->>'id' IS DISTINCT FROM r.id
 OR r."specJson"::jsonb->>'variantId' IS DISTINCT FROM r."variantId" OR r."specJson"::jsonb->>'workspaceId' IS DISTINCT FROM r."workspaceId"
 OR r."specJson"::jsonb->>'projectId' IS DISTINCT FROM r."projectId" OR (r."specJson"::jsonb->>'revisionNumber')::integer IS DISTINCT FROM r."revisionNumber"
 OR entry_doc->>'outputSpecRevisionId' IS DISTINCT FROM r.id OR entry_doc->>'specHash' IS DISTINCT FROM r."specHash" THEN
  RAISE EXCEPTION 'W66v3 revision origin/member factual binding' USING ERRCODE='23514';END IF;
 IF p_command.type='create-output-variant' THEN
  IF r."revisionNumber"<>1 OR variant."createdCommandKind" IS DISTINCT FROM 'edit-command' OR variant."createdCommandId" IS DISTINCT FROM p_command.id
  OR variant."createdCommandHash" IS DISTINCT FROM p_command."commandHash" OR payload->'expectedRevisionId' IS DISTINCT FROM 'null'::jsonb
  OR payload->'expectedSpecHash' IS DISTINCT FROM 'null'::jsonb OR EXISTS(SELECT 1 FROM jsonb_array_elements(p_base_state."stateJson"::jsonb->'entries') AS prior(element)
    WHERE prior.element->>'variantId'=variant.id) THEN RAISE EXCEPTION 'W66v3 new variant origin invalid' USING ERRCODE='23514';END IF;
 ELSE
  SELECT pr.* INTO STRICT previous FROM output_spec_revisions pr JOIN project_output_state_entries pe ON pe."outputSpecRevisionId"=pr.id AND pe."variantId"=pr."variantId"
   WHERE pe."stateId"=p_base_state.id AND pr.id=payload->>'expectedRevisionId' AND pr."specHash"=payload->>'expectedSpecHash' AND pr."variantId"=r."variantId" AND pr."projectId"=r."projectId" AND pr."workspaceId"=r."workspaceId";
  IF r."revisionNumber"<>previous."revisionNumber"+1 THEN RAISE EXCEPTION 'W66v3 revision exact predecessor mismatch' USING ERRCODE='23514';END IF;
 END IF;
EXCEPTION WHEN no_data_found OR too_many_rows THEN RAISE EXCEPTION 'W66v3 revision origin missing/ambiguous' USING ERRCODE='23514';
END $$;
CREATE FUNCTION w66_v3_exact_keys(p_document jsonb,p_keys text[]) RETURNS boolean LANGUAGE sql IMMUTABLE AS $$
 SELECT jsonb_typeof(p_document)='object' AND
  ARRAY(SELECT key_row.key_name FROM jsonb_object_keys(CASE WHEN jsonb_typeof(p_document)='object' THEN p_document ELSE '{}'::jsonb END) AS key_row(key_name) ORDER BY key_row.key_name)=
  ARRAY(SELECT expected_row.key_name FROM unnest(p_keys) AS expected_row(key_name) ORDER BY expected_row.key_name)
$$;
CREATE FUNCTION w66_assert_operational_state_v3(p_state text) RETURNS void LANGUAGE plpgsql AS $$
DECLARE s project_output_states%ROWTYPE;v project_versions%ROWTYPE;b project_versions%ROWTYPE;bs project_output_states%ROWTYPE;
 ob output_operational_bundles%ROWTYPE;d jsonb;o jsonb;pj jsonb;sp project_snapshots%ROWTYPE;bp jsonb;cmd edit_commands%ROWTYPE;entry_record record;
 e project_output_state_entries%ROWTYPE;re output_spec_revisions%ROWTYPE;m output_materializations%ROWTYPE;expected_version jsonb;target_v project_versions%ROWTYPE;
 source_state project_output_states%ROWTYPE;root_state text;project_row projects%ROWTYPE;source_plan jsonb;expected_producer jsonb;metadata jsonb;tr media_transcripts%ROWTYPE;operation_row public_operations%ROWTYPE;detail_row media_ingest_operations%ROWTYPE;manual_payload jsonb;manual_impact jsonb;impact_ranges jsonb;impact_body jsonb;manual_impact_text text;affected_output jsonb;
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
   PERFORM w66_assert_materialization_v3(m.id,v."projectId",v."workspaceId");
  ELSE
   IF e."geometryStatus"<>'blocked-v3' OR e."materializationId" IS NOT NULL OR e."geometryProjectionHash" IS NOT NULL
    OR entry_record.element#>>'{consumption,status}' IS DISTINCT FROM 'blocked' OR entry_record.element#>'{consumption,reasons}' IS DISTINCT FROM '["empty-project"]'::jsonb
    OR (pj->>'durationFrames')::bigint<>0 THEN RAISE EXCEPTION 'W66v3 blocked consumption differs' USING ERRCODE='23514'; END IF;
  END IF;
 END LOOP;
EXCEPTION WHEN no_data_found OR too_many_rows THEN RAISE EXCEPTION 'W66v3 reciprocal bundle missing/ambiguous at COMMIT' USING ERRCODE='23514';
END $$;

-- Historical Creation2 was validated at its original COMMIT by the complete
-- v2 guards and is append-only. This local anchor does not reinterpret mutable
-- Project head/status or demand that no later descendant facts exist.
CREATE FUNCTION w66_assert_creation_anchor_v3(p_state text) RETURNS void LANGUAGE plpgsql AS $$
DECLARE s project_output_states%ROWTYPE;v project_versions%ROWTYPE;c project_creation_commands%ROWTYPE;p projects%ROWTYPE;
 payload jsonb;command_doc jsonb;actor jsonb;expected_body jsonb;snap record;row_snapshot project_snapshots%ROWTYPE;entry_record record;entry_row project_output_state_entries%ROWTYPE;
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
 IF NOT w66_v2_exact_json(command_doc,ARRAY['schemaVersion','canonicalPolicyVersion','id','workspaceId','projectId','versionId','actorContextHash','audit','author','createdAt','payload','payloadHash','requestFingerprint','commandHash'])
 OR c."commandBodyJson"::jsonb IS DISTINCT FROM expected_body
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
 OR command_doc-ARRAY['audit','author','payload'] IS DISTINCT FROM c."commandBodyJson"::jsonb||jsonb_build_object('commandHash',c."commandHash")
 OR c."payloadHash" IS DISTINCT FROM w66_v2_sha(c."payloadJson") OR c."commandJson"::jsonb->'payload' IS DISTINCT FROM payload
 OR s."consumptionStatus" IS DISTINCT FROM 'blocked' OR v."baseHash" IS DISTINCT FROM w66_v2_sha(v."outputBaseHashJson")
 OR v."outputVersionJson"::jsonb->>'id' IS DISTINCT FROM v.id OR v."outputVersionJson"::jsonb->>'baseHash' IS DISTINCT FROM v."baseHash"
 OR v."outputVersionJson"::jsonb->>'outputStateId' IS DISTINCT FROM s.id OR v."outputVersionJson"::jsonb->>'outputStateHash' IS DISTINCT FROM s."stateHash"
 OR v."outputVersionJson"::jsonb->>'workspaceId' IS DISTINCT FROM v."workspaceId" OR v."outputVersionJson"::jsonb->>'projectId' IS DISTINCT FROM v."projectId"
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
CREATE FUNCTION w66_operational_event_state_v3(p_table text,p_row jsonb) RETURNS text LANGUAGE plpgsql AS $$
DECLARE identity text;project_id text;workspace_id text;contract integer;
BEGIN
 CASE p_table
 WHEN 'project_output_states' THEN IF p_row->>'schemaVersion'='project-output-state/v3' THEN RETURN p_row->>'id';END IF;
 WHEN 'project_versions' THEN IF p_row->>'outputContractVersion'='3' THEN RETURN p_row->>'outputStateId';END IF;
 WHEN 'project_output_state_entries','project_output_state_overlays','project_output_state_invalidations' THEN
  SELECT s.id INTO identity FROM project_output_states s WHERE s.id=p_row->>'stateId' AND s."schemaVersion"='project-output-state/v3';RETURN identity;
 WHEN 'output_variants','output_spec_revisions' THEN
  SELECT s.id INTO identity FROM project_output_states s WHERE s."producerKind"=p_row->>'createdCommandKind' AND s."producerId"=p_row->>'createdCommandId'
   AND s."provenanceHash"=p_row->>'createdCommandHash' AND s."schemaVersion"='project-output-state/v3';RETURN identity;
 WHEN 'output_materializations' THEN
  SELECT s.id INTO identity FROM project_output_states s WHERE s."resultVersionId"=p_row->>'resultVersionId' AND s."schemaVersion"='project-output-state/v3';RETURN identity;
 WHEN 'output_operational_bundles' THEN RETURN p_row->>'stateId';
 WHEN 'output_materialization_normalizations' THEN
  SELECT s.id INTO identity FROM output_materializations m JOIN project_output_states s ON s."resultVersionId"=m."resultVersionId"
   WHERE m.id=p_row->>'materializationId' AND s."schemaVersion"='project-output-state/v3';RETURN identity;
 WHEN 'projects' THEN project_id:=p_row->>'id';workspace_id:=p_row->>'workspaceId';
 WHEN 'project_snapshots','project_media_assets' THEN project_id:=p_row->>'projectId';workspace_id:=p_row->>'workspaceId';
 ELSE RETURN NULL;
 END CASE;
 IF project_id IS NOT NULL THEN
  SELECT s.id INTO identity FROM projects p JOIN project_versions v ON v.id=p."currentVersionId" AND v."projectId"=p.id AND v."workspaceId"=p."workspaceId"
   JOIN project_output_states s ON s.id=v."outputStateId" AND s."resultVersionId"=v.id AND s."stateHash"=v."outputStateHash"
   WHERE p.id=project_id AND p."workspaceId"=workspace_id AND v."outputContractVersion"=3 AND s."schemaVersion"='project-output-state/v3';
 END IF;
 RETURN identity;
END $$;

CREATE OR REPLACE FUNCTION w66_version_insert_contract() RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN
 IF NEW."outputContractVersion"=3 THEN RETURN NEW;END IF;
 IF NEW."outputContractVersion" IS DISTINCT FROM 1 THEN RAISE EXCEPTION 'W66 contract 0 is migration audit history only' USING ERRCODE='23514';END IF;
 RETURN NEW;
END $$;
CREATE OR REPLACE FUNCTION w66_output_deferred_check() RETURNS trigger LANGUAGE plpgsql AS $$
DECLARE operational_state_id text; state_id text; revision "output_spec_revisions"%ROWTYPE;
BEGIN
  operational_state_id:=w66_operational_event_state_v3(TG_TABLE_NAME,to_jsonb(NEW));
  IF operational_state_id IS NOT NULL THEN PERFORM w66_assert_operational_state_v3(operational_state_id);RETURN NULL;END IF;
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
CREATE OR REPLACE FUNCTION w66_creation_bundle_deferred_v2() RETURNS trigger LANGUAGE plpgsql AS $$
DECLARE operational_state_id text; state_id text; contract integer; final_project projects%ROWTYPE; BEGIN
 operational_state_id:=w66_operational_event_state_v3(TG_TABLE_NAME,to_jsonb(NEW));
 IF operational_state_id IS NOT NULL THEN PERFORM w66_assert_operational_state_v3(operational_state_id);RETURN NULL;END IF;
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
CREATE OR REPLACE FUNCTION w66_creation_project_head_v2() RETURNS trigger LANGUAGE plpgsql AS $$
DECLARE operational_state_id text; final_project projects%ROWTYPE;
BEGIN
 operational_state_id:=w66_operational_event_state_v3('projects',to_jsonb(NEW));
 IF operational_state_id IS NOT NULL THEN
  IF OLD."creationContractVersion" IS DISTINCT FROM 2 OR NEW."creationContractVersion" IS DISTINCT FROM 2 THEN
   RAISE EXCEPTION 'W66v3 Project requires immutable Creation2 discriminator' USING ERRCODE='23514';END IF;
  PERFORM w66_assert_operational_state_v3(operational_state_id);RETURN NULL;
 END IF;
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
CREATE FUNCTION w66_operational_facts_commit_v3() RETURNS trigger LANGUAGE plpgsql AS $$
DECLARE state_id text;
BEGIN
 IF TG_TABLE_NAME='output_normalization_receipts' THEN PERFORM w66_assert_normalization_v3(NEW.id,NEW."projectId",NEW."workspaceId");RETURN NULL;END IF;
 state_id:=w66_operational_event_state_v3(TG_TABLE_NAME,to_jsonb(NEW));
 IF state_id IS NULL THEN RAISE EXCEPTION 'W66v3 operational fact lacks reciprocal State' USING ERRCODE='23514';END IF;
 PERFORM w66_assert_operational_state_v3(state_id);RETURN NULL;
END $$;
DO $$ DECLARE table_name text;BEGIN
 FOREACH table_name IN ARRAY ARRAY['output_normalization_receipts','output_materializations','output_materialization_normalizations','output_operational_bundles'] LOOP
  EXECUTE format('CREATE TRIGGER %I BEFORE UPDATE OR DELETE ON %I FOR EACH ROW EXECUTE FUNCTION w66_output_immutable()',table_name||'_immutable',table_name);
  EXECUTE format('CREATE CONSTRAINT TRIGGER %I AFTER INSERT ON %I DEFERRABLE INITIALLY DEFERRED FOR EACH ROW EXECUTE FUNCTION w66_operational_facts_commit_v3()',table_name||'_w66v3_commit_check',table_name);
 END LOOP;
END $$;
