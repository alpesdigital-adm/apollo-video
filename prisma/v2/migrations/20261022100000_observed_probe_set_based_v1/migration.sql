-- W70 readiness (cost of the integrity assertions). `w66_assert_probe_v3` verifies an observed probe against the raw ffprobe document it carries:
-- every raw frame is checked, then the frame sequence of the probe is compared with the raw frames of the stream, one by one. Both checks ran as a
-- PL/pgSQL loop that planned and executed a sub-SELECT (the stream lookup) and a dozen expressions for each frame: about a hundred microseconds a
-- frame, so a 103 s master (3,085 video and 4,430 audio frames) cost over half a second per verification, and a commit that re-verifies the
-- receipts of a project (every State of the project carries them) spent seconds there, past the 10 s statement budget of the commit.
--
-- The verdict is unchanged. Each loop is now one set-based statement that raises when ANY frame violates the SAME predicate, written in the SAME
-- order (the predicate is one OR expression, so the guards that precede a cast still precede it):
--   * the raw-frame check is `EXISTS(frame that violates the old per-frame predicate)`;
--   * the sequence check zips the probe frames, their end PTS and the raw frames of the stream by position (the three lengths were already proved
--     equal) and compares each with its predecessor through lag(), where the loop carried `previous_pts`;
--   * the terminal boundary is the last frame's PTS plus its raw duration, exactly what the loop left in `observed_end`.
-- The key-set check of a probe frame is written inline (an object holding exactly frame, pts and timeBase): a call to the PL/pgSQL helper per frame was
-- the largest remaining cost of the loop.
-- A value that cannot be cast still raises invalid_text_representation / numeric_value_out_of_range, which the function maps to the same refusal.
-- The function reads no table and keeps its signature: it is replaced in place.
CREATE OR REPLACE FUNCTION w66_assert_probe_v3(p_probe jsonb,p_manifest jsonb) RETURNS void LANGUAGE plpgsql AS $$
DECLARE raw jsonb;stream_doc jsonb;frames jsonb;rotations jsonb;measured text;observed_end bigint;frame_count integer;
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
 IF EXISTS(SELECT 1 FROM jsonb_array_elements(raw->'frames') AS fi(element) CROSS JOIN LATERAL (SELECT coalesce(fi.element->>'duration',fi.element->>'pkt_duration') AS duration_value) AS dv
  WHERE jsonb_typeof(fi.element) IS DISTINCT FROM 'object' OR (fi.element->>'stream_index') !~ '^(0|[1-9][0-9]*)$'
  OR NOT EXISTS(SELECT 1 FROM jsonb_array_elements(raw->'streams') AS si(element) WHERE si.element->'index'=fi.element->'stream_index' AND si.element->'codec_type'=fi.element->'media_type')
  OR (fi.element->>'best_effort_timestamp') !~ '^-?(0|[1-9][0-9]*)$' OR dv.duration_value IS NULL OR dv.duration_value !~ '^[1-9][0-9]*$'
  OR (jsonb_typeof(fi.element->'best_effort_timestamp')='number' AND abs((fi.element->>'best_effort_timestamp')::numeric)>9007199254740991)
  OR (jsonb_typeof(coalesce(fi.element->'duration',fi.element->'pkt_duration'))='number' AND dv.duration_value::numeric>9007199254740991)) THEN
  RAISE EXCEPTION 'W66v3 malformed/unsafe raw frame' USING ERRCODE='23514'; END IF;
 SELECT coalesce(jsonb_agg(fi.element ORDER BY fi.ordinal),'[]'::jsonb) INTO frames
 FROM jsonb_array_elements(raw->'frames') WITH ORDINALITY AS fi(element,ordinal)
 WHERE fi.element->>'media_type'=p_probe->>'mediaType' AND fi.element->'stream_index'=p_probe->'streamIndex';
 IF jsonb_array_length(frames)=0 OR jsonb_array_length(frames)<>jsonb_array_length(p_probe->'frames')
 OR jsonb_array_length(frames)<>jsonb_array_length(p_probe->'frameEndPts') THEN
  RAISE EXCEPTION 'W66v3 full probe frame sequence missing' USING ERRCODE='23514'; END IF;
 frame_count:=jsonb_array_length(frames);
 IF EXISTS(SELECT 1 FROM (
   SELECT z.element,z.end_pts,z.raw_frame,z.ordinal,(z.element->>'pts')::bigint AS pts,lag((z.element->>'pts')::bigint) OVER (ORDER BY z.ordinal) AS previous_pts
   FROM ROWS FROM (jsonb_array_elements(p_probe->'frames'),jsonb_array_elements(p_probe->'frameEndPts'),jsonb_array_elements(frames)) WITH ORDINALITY AS z(element,end_pts,raw_frame,ordinal)
  ) AS q
  WHERE NOT (jsonb_typeof(q.element)='object' AND q.element ?& ARRAY['frame','pts','timeBase'] AND (q.element-ARRAY['frame','pts','timeBase'])='{}'::jsonb) OR (q.element->>'frame')::bigint IS DISTINCT FROM q.ordinal-1
  OR q.element->'timeBase' IS DISTINCT FROM p_probe->'timeBase'
  OR q.element->>'pts' IS DISTINCT FROM q.raw_frame->>'best_effort_timestamp'
  OR (q.previous_pts IS NOT NULL AND q.pts<=q.previous_pts)
  OR q.pts=-9223372036854775808 OR (q.end_pts#>>'{}')::bigint IS DISTINCT FROM q.pts+coalesce(q.raw_frame->>'duration',q.raw_frame->>'pkt_duration')::bigint) THEN
  RAISE EXCEPTION 'W66v3 raw PTS/end sequence differs' USING ERRCODE='23514'; END IF;
 observed_end:=((p_probe->'frames')->(frame_count-1)->>'pts')::bigint+coalesce(frames->(frame_count-1)->>'duration',frames->(frame_count-1)->>'pkt_duration')::bigint;
 IF (p_probe->>'endPts')::bigint IS DISTINCT FROM observed_end THEN RAISE EXCEPTION 'W66v3 terminal measured boundary differs' USING ERRCODE='23514'; END IF;
 SELECT coalesce(jsonb_agg(si.element->'rotation'),'[]'::jsonb) INTO rotations FROM jsonb_array_elements(coalesce(stream_doc->'side_data_list','[]'::jsonb)) AS si(element) WHERE si.element ? 'rotation';
 IF (jsonb_array_length(rotations)=0 AND NOT coalesce(stream_doc->'tags' ? 'rotate',false) AND p_probe->'rotationDegrees' IS DISTINCT FROM '0'::jsonb)
 OR EXISTS(SELECT 1 FROM jsonb_array_elements(rotations) AS rr(element) WHERE (rr.element#>>'{}')::double precision IS DISTINCT FROM (p_probe->>'rotationDegrees')::double precision)
 OR (stream_doc->'tags' ? 'rotate' AND (stream_doc#>>'{tags,rotate}')::double precision IS DISTINCT FROM (p_probe->>'rotationDegrees')::double precision) THEN
  RAISE EXCEPTION 'W66v3 observed rotation differs' USING ERRCODE='23514'; END IF;
EXCEPTION WHEN no_data_found OR too_many_rows OR invalid_text_representation OR numeric_value_out_of_range OR division_by_zero THEN
 RAISE EXCEPTION 'W66v3 malformed observed probe authority' USING ERRCODE='23514';
END $$;
