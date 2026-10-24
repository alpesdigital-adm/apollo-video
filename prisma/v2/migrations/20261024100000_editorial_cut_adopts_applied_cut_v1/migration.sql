-- A remove-spoken-content whose rules match only speech the parent plan's own cut already removed (a copy of a cut project, which owns no authority
-- until a cut binds it) removes nothing more and adopts that cut: the plan keeps its clips, the Version carries the editorial binding. The database
-- replica of the plan keeps its refusal for a parent with no cut lineage and no longer demands a removed range from one that has it.
CREATE OR REPLACE FUNCTION w66_editorial_plan_v1(p_before jsonb,p_binding jsonb,p_command text,p_version text,p_plan text,p_created text,p_exclusions jsonb) RETURNS jsonb LANGUAGE plpgsql AS $$
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
 -- A cut whose every range was already removed by the cut the parent plan carries removes nothing more: it adopts the parent's cut (a copy of a
 -- cut project binds its authority with it). Without that lineage a cut must still remove an actual source range.
 IF jsonb_array_length(removed)=0 AND p_before#>'{editorial,retainedSourceRanges}' IS NULL THEN RAISE EXCEPTION 'W66 editorial excludes no actual source range' USING ERRCODE='23514';END IF;
 FOR r IN SELECT x.element FROM jsonb_array_elements(removed) AS x(element) ORDER BY (x.element->>'startFrame')::bigint,(x.element->>'endFrame')::bigint LOOP
  start_frame:=(r.element->>'startFrame')::bigint;end_frame:=(r.element->>'endFrame')::bigint;
  IF last_end=0 THEN last_start:=start_frame;last_end:=end_frame;
  ELSIF start_frame<=last_end THEN last_end:=greatest(last_end,end_frame);
  ELSE merged:=merged||jsonb_build_array(jsonb_build_object('startFrame',last_start,'endFrame',last_end));last_start:=start_frame;last_end:=end_frame;END IF;
 END LOOP;
 IF jsonb_array_length(removed)>0 THEN merged:=merged||jsonb_build_array(jsonb_build_object('startFrame',last_start,'endFrame',last_end));END IF;
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
