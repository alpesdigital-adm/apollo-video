import { calculateCanonicalHash, stableSerialize } from './canonical-hash.ts'
import type { CommandArtifactInvalidationV1, CommandImpactOutputReference, CommandImpactRange } from './command-impact.ts'
import { assertDomain } from './errors.ts'
import { createHash } from 'node:crypto'
import { timelineSpanForRate, sourceFrameToTimelineFrame } from './clip-timing.ts'
import { freezeOutputJson, requireOutputId, type OutputJson } from './output-spec-revision.ts'
import { createEditorialAudioTimelineHash } from './production-modes.ts'
import { createDirectedAudioTimelineHash, type DirectedMusicTrack } from './director-run.ts'
import type { MaterializationPlanV3, EditorialSourceBindingV1 } from './output-materialization.ts'

export interface EditorialCutPayloadV3 {
  schemaVersion:3
  sourceTranscriptId:string
  sourceArtifactId:string
  variantId:string
  rules:readonly Readonly<{id:string;label:string;alternatives:readonly string[]}>[]
  exclusions:readonly Readonly<{sourceStartSeconds:number;sourceEndSeconds:number;ruleIds:readonly string[]}>[]
  exclusionOverrides?:readonly Readonly<{sourceStartSeconds:number;sourceEndSeconds:number;ruleIds:readonly string[];reason:string}>[]
  /** Present only when the Command confirms a cut the Apollo proposed for a subject of the request (capability `apollo.projects.speech-removals.confirm`). */
  confirmation?:Readonly<{subject:string;medium:'ui-session'|'api-key-scope'}>
  sourceBinding:Readonly<EditorialSourceBindingV1>
  editPlanHash:string
  audioProjection:Readonly<EditorialAudioProjectionV1>|null
  impact:Readonly<EditorialCutImpactV2>
}

export interface EditorialAudioProjectionV1 {schemaVersion:'editorial-audio-projection/v1';speechCanonicalJson:string;speechHash:string;mixedCanonicalJson:string|null}
export function createEditorialAudioProjectionV1(plan:Readonly<Record<string,any>>):Readonly<EditorialAudioProjectionV1>|null {
  if(plan.audioTimelineHash===undefined)return null
  const clips=plan.videoTracks.filter((t:any)=>t.kind==='base-video').flatMap((t:any)=>t.clips)
  const speechHash=createEditorialAudioTimelineHash({fps:plan.fps,clips})
  const speechCanonicalJson=stableSerialize({schemaVersion:'editorial-audio-timeline/v1',fps:Number(plan.fps.toFixed(6)),
    segments:clips.map((c:any)=>({artifactId:c.audioSourceArtifactId??c.sourceArtifactId,audioSourceInFrame:c.audioSourceInFrame??c.sourceInFrame,
      audioSourceOutFrame:c.audioSourceOutFrame??c.sourceOutFrame,timelineInFrame:c.timelineInFrame,timelineOutFrame:c.timelineOutFrame,rate:c.rate}))})
  const mixedCanonicalJson=plan.audioTracks.length?stableSerialize({schemaVersion:'directed-audio-timeline/v1',speechHash,musicTracks:plan.audioTracks}):null
  assertDomain(plan.audioTimelineHash===(mixedCanonicalJson?calculateCanonicalHash(JSON.parse(mixedCanonicalJson)):speechHash),
    'INVALID_COMMAND','Editorial audio hash must be its real typed rematerialization')
  return Object.freeze({schemaVersion:'editorial-audio-projection/v1',speechCanonicalJson,speechHash,mixedCanonicalJson})
}

/** Only fields validated/produced here are promised. Preserved source and
 * Director metadata stay readonly data; no movement/approval fields are invented. */
export type EditorialMaterializedPlanV3 = Readonly<Record<string,unknown> & {
 schemaVersion:2;state:'compiled';id:string;projectVersionId:string;fps:number;durationFrames:number;createdAt:string
 videoTracks:MaterializationPlanV3['videoTracks'];audioTracks:readonly OutputJson[];overlayTracks:readonly OutputJson[];subtitleTracks:readonly OutputJson[]
 editorial:Readonly<{commandType:'remove-spoken-content';exclusions:EditorialCutPayloadV3['exclusions'];retainedSourceRanges:readonly Readonly<{sourceStartSeconds:number;sourceEndSeconds:number}>[]}>
}>
export function readEditorialMaterializedPlanV3(input:OutputJson):EditorialMaterializedPlanV3 {
 const d=freezeOutputJson(input) as Readonly<Record<string,unknown>>
 assertDomain(d.schemaVersion===2&&d.state==='compiled'&&typeof d.fps==='number'&&Number.isFinite(d.fps)&&d.fps>0&&
  Number.isSafeInteger(d.durationFrames)&&Number(d.durationFrames)>0&&typeof d.createdAt==='string'&&
  Array.isArray(d.videoTracks)&&Array.isArray(d.audioTracks)&&Array.isArray(d.overlayTracks)&&Array.isArray(d.subtitleTracks),
  'INVALID_COMMAND','Editorial materialized plan core contract differs')
 requireOutputId(d.id,'editorial plan');requireOutputId(d.projectVersionId,'editorial Version')
 const editorial=d.editorial as Readonly<Record<string,unknown>>
 assertDomain(editorial&&editorial.commandType==='remove-spoken-content'&&Array.isArray(editorial.exclusions)&&Array.isArray(editorial.retainedSourceRanges),
  'INVALID_COMMAND','Editorial result range metadata differs')
 assertDomain((editorial.retainedSourceRanges as readonly Readonly<Record<string,unknown>>[]).every(r=>
  typeof r.sourceStartSeconds==='number'&&Number.isFinite(r.sourceStartSeconds)&&r.sourceStartSeconds>=0&&
  typeof r.sourceEndSeconds==='number'&&Number.isFinite(r.sourceEndSeconds)&&r.sourceEndSeconds>r.sourceStartSeconds),
  'INVALID_COMMAND','Editorial current source ranges differ')
 for(const track of d.videoTracks as MaterializationPlanV3['videoTracks']) {
  requireOutputId(track.id,'editorial track')
  assertDomain(typeof track.kind==='string'&&track.kind.length>0&&Array.isArray(track.clips),'INVALID_COMMAND','Editorial typed track differs')
  for(const c of track.clips) {
   requireOutputId(c.id,'editorial clip');requireOutputId(c.sourceArtifactId,'editorial source')
   assertDomain([c.sourceInFrame,c.sourceOutFrame,c.timelineInFrame,c.timelineOutFrame].every(Number.isSafeInteger)&&c.sourceInFrame>=0&&c.sourceOutFrame>c.sourceInFrame&&
    c.timelineInFrame>=0&&c.timelineOutFrame>c.timelineInFrame&&c.timelineOutFrame<=Number(d.durationFrames)&&Number.isFinite(c.rate)&&c.rate>0,
    'INVALID_COMMAND','Editorial actual clip range/rate differs')
  }
 }
 return d as EditorialMaterializedPlanV3
}

/** Rebuild typed timing containers from the exact parent. Unknown metadata and
 * media identities stay data; no Director/critic/face authority is created. */
export function materializeEditorialCutPlanV3(input:Readonly<{
  before:Readonly<Record<string,unknown>>;versionId:string;planId:string;commandId:string;createdAt:string;
  sourceBinding:EditorialSourceBindingV1;exclusions:EditorialCutPayloadV3['exclusions']
}>):EditorialMaterializedPlanV3 {
  const p=structuredClone(input.before) as Record<string,any>,b=input.sourceBinding.document,fps=Number(p.fps),duration=Number(p.durationFrames)
  assertDomain(p.schemaVersion===2&&p.state==='compiled'&&Number.isFinite(fps)&&fps>0&&Number.isSafeInteger(duration)&&duration>0&&
    b.resultVersionId===input.versionId&&b.createdAt===input.createdAt,'INVALID_COMMAND','Editorial materialization parent/clock differs')
  const unique=(kind:string,id:string,start:number,end:number)=>'editorial-'+kind+'-'+createHash('sha256')
    .update(stableSerialize({commandId:input.commandId,id,start,end})).digest('hex').slice(0,48)
  const originalSourceClips=p.videoTracks.filter((t:any)=>t.kind==='base-video').flatMap((t:any)=>t.clips)
    .filter((c:any)=>c.sourceArtifactId===b.transcript.sourceArtifactId)
  const parentRanges=p.editorial?.retainedSourceRanges??originalSourceClips.map((c:any)=>({sourceStartSeconds:c.sourceInFrame/fps,sourceEndSeconds:c.sourceOutFrame/fps}))
  assertDomain(parentRanges.length===originalSourceClips.length&&parentRanges.every((r:any,i:number)=>
    Math.ceil(r.sourceStartSeconds*fps-1e-7)===originalSourceClips[i].sourceInFrame&&Math.floor(r.sourceEndSeconds*fps+1e-7)===originalSourceClips[i].sourceOutFrame),
    'PRECONDITION_REQUIRED','Parent planned source ranges contradict actual current clip frame geometry')
  const retainedSourceRanges=parentRanges.flatMap((r:any)=>{
    const ranges:{sourceStartSeconds:number;sourceEndSeconds:number}[]=[];let start=r.sourceStartSeconds
    for(const x of input.exclusions) {
      if(x.sourceEndSeconds<=start||x.sourceStartSeconds>=r.sourceEndSeconds)continue
      if(x.sourceStartSeconds>start)ranges.push({sourceStartSeconds:start,sourceEndSeconds:Math.min(x.sourceStartSeconds,r.sourceEndSeconds)})
      start=Math.max(start,Math.min(x.sourceEndSeconds,r.sourceEndSeconds))
    }
    if(start<r.sourceEndSeconds)ranges.push({sourceStartSeconds:start,sourceEndSeconds:r.sourceEndSeconds})
    return ranges
  })
  const removed:{start:number;end:number}[]=[]
  for(const t of p.videoTracks)if(t.kind==='base-video')for(const c of t.clips)if(c.sourceArtifactId===b.transcript.sourceArtifactId) {
    for(const x of input.exclusions) {
      // Preserve the existing frameAtOrAfter/Before editorial clock semantics.
      const start=Math.max(c.sourceInFrame,Math.floor(x.sourceStartSeconds*fps+1e-7)),end=Math.min(c.sourceOutFrame,Math.ceil(x.sourceEndSeconds*fps-1e-7))
      if(end>start)removed.push({start:sourceFrameToTimelineFrame(start,c),end:sourceFrameToTimelineFrame(end,c)})
    }
  }
  assertDomain(removed.length>0,'INVALID_COMMAND','Editorial rules do not intersect the actual parent source clips')
  removed.sort((a,b)=>a.start-b.start||a.end-b.end)
  const merged:{start:number;end:number}[]=[]
  for(const r of removed) {
    assertDomain(Number.isSafeInteger(r.start)&&Number.isSafeInteger(r.end)&&r.start>=0&&r.end>r.start&&r.end<=duration,
      'INVALID_COMMAND','Editorial exclusion timeline boundary differs')
    const last=merged[merged.length-1]
    if(last&&r.start<=last.end)last.end=Math.max(last.end,r.end);else merged.push({...r})
  }
  const kept:{start:number;end:number;offset:number}[]=[];let cursor=0,total=0
  for(const r of merged){if(r.start>cursor){kept.push({start:cursor,end:r.start,offset:total});total+=r.start-cursor}cursor=r.end}
  if(cursor<duration){kept.push({start:cursor,end:duration,offset:total});total+=duration-cursor}
  assertDomain(total>0,'INVALID_COMMAND','Editorial Command removes the whole current timeline')
  const boundary=(frame:number)=>{let elapsed=0;for(const r of kept){if(frame<r.start)return elapsed;if(frame<=r.end)return r.offset+frame-r.start;elapsed=r.offset+r.end-r.start}return elapsed}
  const pieces=new Map<string,any[]>()
  p.videoTracks=p.videoTracks.map((t:any)=>({...t,clips:t.clips.flatMap((c:any)=>{
    const out:any[]=[]
    for(const r of kept) {
      const start=Math.max(c.timelineInFrame,r.start),end=Math.min(c.timelineOutFrame,r.end);if(end<=start)continue
      const sourceIn=c.sourceInFrame+Math.round((start-c.timelineInFrame)*c.rate),sourceOut=c.sourceInFrame+Math.round((end-c.timelineInFrame)*c.rate)
      assertDomain(sourceIn>=c.sourceInFrame&&sourceOut<=c.sourceOutFrame&&sourceOut>sourceIn&&timelineSpanForRate(sourceOut-sourceIn,c.rate)===end-start,
        'PRECONDITION_REQUIRED','Editorial rate boundary requires exact source-frame coverage')
      const next={...c,id:out.length===0?c.id:unique('clip',c.id,start,end),sourceInFrame:sourceIn,sourceOutFrame:sourceOut,
        timelineInFrame:r.offset+start-r.start,timelineOutFrame:r.offset+end-r.start}
      if(c.audioSourceArtifactId!==undefined) {
        assertDomain(Number.isSafeInteger(c.audioSourceInFrame)&&Number.isSafeInteger(c.audioSourceOutFrame),'PRECONDITION_REQUIRED','Editorial secondary audio authority is missing')
        next.audioSourceInFrame=c.audioSourceInFrame+sourceIn-c.sourceInFrame;next.audioSourceOutFrame=c.audioSourceInFrame+sourceOut-c.sourceInFrame
        assertDomain(next.audioSourceOutFrame<=c.audioSourceOutFrame,'INVALID_COMMAND','Editorial audio source boundary differs')
      }
      out.push(next)
    }
    pieces.set(c.id,out);return out
  })}))
  const sourceWords=p.retimedTranscript?.words
  assertDomain(Array.isArray(sourceWords),'PRECONDITION_REQUIRED','Editorial parent aligned word timeline is missing')
  const wordMap=new Map<number,any>()
  sourceWords.forEach((word:any,index:number)=>{
    const r=kept.find(r=>word.timelineStartFrame>=r.start&&word.timelineEndFrame<=r.end)
    if(r)wordMap.set(index,{...word,timelineStartFrame:r.offset+word.timelineStartFrame-r.start,timelineEndFrame:r.offset+word.timelineEndFrame-r.start})
  })
  p.subtitleTracks=p.subtitleTracks.map((t:any)=>({...t,cues:t.cues.flatMap((cue:any)=>{
    const out:any[]=[]
    for(const r of kept) {
      const start=Math.max(cue.startFrame,r.start),end=Math.min(cue.endFrame,r.end);if(end<=start)continue
      let text=cue.text,wordIndices=cue.sourceWordIndices
      if(start!==cue.startFrame||end!==cue.endFrame) {
        assertDomain(t.schemaVersion==='source-transcript-cue-track/v1'&&t.sourceTranscriptId===b.transcript.id&&
          t.sourceTranscriptHash===b.transcript.document.transcriptHash&&Array.isArray(wordIndices),
          'PRECONDITION_REQUIRED','Partially cut cue needs its actual aligned transcript authority')
        // Initial cue indices name original transcript words. Resolve by source
        // content/clock, never by treating that index as a new execution ID.
        const selected=wordIndices.filter((index:number)=>{
          const original=b.transcript.document.words[index]
          return original&&sourceWords.some((w:any,i:number)=>wordMap.has(i)&&w.text===original.word&&w.sourceStartSeconds===original.start&&
            w.sourceEndSeconds===original.end&&w.timelineStartFrame>=start&&w.timelineEndFrame<=end)
        })
        if(!selected.length)continue
        wordIndices=selected;text=selected.map((index:number)=>b.transcript.document.words[index]!.word).join(' ')
      }
      const clip=cue.clipId===undefined?null:pieces.get(cue.clipId)?.find(c=>c.timelineInFrame<=boundary(start)&&c.timelineOutFrame>=boundary(end))
      assertDomain(cue.clipId===undefined||clip!==undefined,'INVALID_COMMAND','Editorial cue clip reference lost its exact retained part')
      out.push({...cue,id:out.length===0?cue.id:unique('cue',cue.id,start,end),startFrame:boundary(start),endFrame:boundary(end),text,
        ...(wordIndices?{sourceWordIndices:wordIndices}:{}),...(clip?{clipId:clip.id}:{})})
    }
    return out
  })}))
  const retimeRows=(rows:any[])=>rows.flatMap(row=>{
    if(row.startFrame===undefined&&row.endFrame===undefined)return [{...row}]
    assertDomain(Number.isSafeInteger(row.startFrame)&&Number.isSafeInteger(row.endFrame)&&row.endFrame>row.startFrame,
      'PRECONDITION_REQUIRED','Editorial timing container has no exact frame authority')
    let pieceIndex=0
    return kept.flatMap(r=>{
      const start=Math.max(row.startFrame,r.start),end=Math.min(row.endFrame,r.end);if(end<=start)return []
      const clip=row.clipId===undefined?null:pieces.get(row.clipId)?.find(c=>c.timelineInFrame<=boundary(start)&&c.timelineOutFrame>=boundary(end))
      assertDomain(row.clipId===undefined||clip!==undefined,'INVALID_COMMAND','Editorial overlay/effect clip reference differs')
      assertDomain(typeof row.id==='string','PRECONDITION_REQUIRED','Timed editorial element requires its existing owned identity')
      return [{...row,id:pieceIndex++===0?row.id:unique('element',row.id,start,end),startFrame:boundary(start),endFrame:boundary(end),...(clip?{clipId:clip.id}:{})}]
    })
  })
  for(const key of ['overlayTracks','effectTracks','protectedElements'])p[key]=retimeRows(p[key]??[])
  p.audioTracks=(p.audioTracks??[]).map((t:any)=>{
    assertDomain(t.kind==='background-music'&&t.timelineInFrame===0&&t.timelineOutFrame===duration&&t.sourceOutFrame-t.sourceInFrame>=total,
      'PRECONDITION_REQUIRED','Editorial background audio needs an actual continuous full-timeline source')
    return {...t,timelineOutFrame:total,fadeInFrames:Math.min(t.fadeInFrames,total),fadeOutFrames:Math.min(t.fadeOutFrames,total)}
  })
  p.markers=(p.markers??[]).map((m:any)=>({...m,...(Number.isSafeInteger(m.atFrame)?{atFrame:boundary(m.atFrame)}:{})}))
  const retiredTransitions:unknown[]=[]
  if(p.transitions!==undefined)p.transitions=p.transitions.flatMap((t:any)=>{
    const from=pieces.get(t.fromClipId)?.at(-1),to=pieces.get(t.toClipId)?.[0]
    if(!from||!to){retiredTransitions.push({...t,reasonCode:'editorial-endpoint-removed'});return []}
    assertDomain(from.timelineOutFrame===to.timelineInFrame,'PRECONDITION_REQUIRED','Retained transition requires contiguous actual clip endpoints')
    return [{...t,fromClipId:from.id,toClipId:to.id,atFrame:to.timelineInFrame}]
  })
  p.id=input.planId;p.projectVersionId=input.versionId;p.createdAt=input.createdAt;p.durationFrames=total
  p.retimedTranscript={...p.retimedTranscript,sourceTranscriptId:b.transcript.id,sourceTranscriptHash:b.transcript.document.transcriptHash,
    sourceBindingRef:{schemaVersion:'editorial-source-binding-ref/v1',id:b.id,hash:input.sourceBinding.bindingHash,projectId:b.projectId},words:[...wordMap.values()]}
  const targetSourceClips=p.videoTracks.filter((t:any)=>t.kind==='base-video').flatMap((t:any)=>t.clips).filter((c:any)=>c.sourceArtifactId===b.transcript.sourceArtifactId)
  assertDomain(retainedSourceRanges.length===targetSourceClips.length&&retainedSourceRanges.every((r:any,i:number)=>
    Math.ceil(r.sourceStartSeconds*fps-1e-7)===targetSourceClips[i].sourceInFrame&&Math.floor(r.sourceEndSeconds*fps+1e-7)===targetSourceClips[i].sourceOutFrame),
    'PRECONDITION_REQUIRED','Editorial planned source boundary is not representable by the exact preserved rate map')
  p.editorial={...p.editorial,commandType:'remove-spoken-content',exclusions:input.exclusions,retainedSourceRanges,
    retainedTimelineRanges:kept.map(({start,end,offset})=>({startFrame:start,endFrame:end,targetStartFrame:offset})),
    retiredTransitions}
  if(p.audioTimelineHash!==undefined)p.audioTimelineHash=createDirectedAudioTimelineHash({fps,clips:p.videoTracks.filter((t:any)=>t.kind==='base-video').flatMap((t:any)=>t.clips),musicTracks:p.audioTracks as DirectedMusicTrack[]})
  if(p.sourceTranscriptCueProjection?.status==='available')p.sourceTranscriptCueProjection={...p.sourceTranscriptCueProjection,
    cueCount:p.subtitleTracks.reduce((sum:number,t:any)=>sum+t.cues.length,0)}
  for(const key of ['directorRunId','director','manualEditing','qualityReport','approval'])delete p[key]
  return readEditorialMaterializedPlanV3(p as OutputJson)
}

export interface EditorialCutImpactV1 {
  schemaVersion: 'editorial-cut-impact/v1'
  commandId: string
  commandType: 'remove-spoken-content'
  baseVersionId: string
  resultVersionId: string
  sourceTranscriptId: string
  sourceTranscriptHash: string
  changeKinds: readonly ['spoken-content-removal']
  dependencyTypes: readonly ['audio', 'content', 'timing', 'visual']
  affectedRanges: readonly Readonly<CommandImpactRange>[]
  affectedVariantIds: readonly string[]
  affectedArtifacts: readonly Readonly<CommandImpactOutputReference>[]
  minimalRenders: readonly Readonly<{
    kind: 'proxy'
    variantId: string
    ranges: readonly Readonly<CommandImpactRange>[]
  }>[]
  renderSemanticsChanged: true
  impactHash: string
}

type MutableRecord = Record<string, unknown>
const ID = /^[A-Za-z0-9][A-Za-z0-9._:-]{2,127}$/

function identifier(value: unknown, field: string): string {
  assertDomain(typeof value === 'string' && ID.test(value), 'INVALID_ARGUMENT', `${field} is invalid`)
  return value
}

function sha256(value: unknown, field: string): string {
  assertDomain(typeof value === 'string' && /^[a-f0-9]{64}$/.test(value), 'INVALID_ARGUMENT', `${field} is invalid`)
  return value
}

function record(value: unknown, field: string): MutableRecord {
  assertDomain(typeof value === 'object' && value !== null && !Array.isArray(value), 'INVALID_ARGUMENT', `${field} must be an object`)
  return value as MutableRecord
}

export function createEditorialCutImpact(input: {
  commandId: string
  baseVersionId: string
  resultVersionId: string
  sourceTranscriptId: string
  sourceTranscriptHash: string
  affectedEndFrame: number
  renderEndFrame: number
  proxyVariantId: string
  outputReferences: readonly Readonly<CommandImpactOutputReference>[]
}): Readonly<EditorialCutImpactV1> {
  assertDomain(Number.isSafeInteger(input.affectedEndFrame) && input.affectedEndFrame > 0, 'INVALID_ARGUMENT', 'affectedEndFrame is invalid')
  assertDomain(Number.isSafeInteger(input.renderEndFrame) && input.renderEndFrame > 0 && input.renderEndFrame <= input.affectedEndFrame, 'INVALID_ARGUMENT', 'renderEndFrame is invalid')
  const baseVersionId = identifier(input.baseVersionId, 'baseVersionId')
  const seenArtifacts = new Set<string>()
  const outputs = input.outputReferences.map((item, index) => {
    const artifactId = identifier(item.artifactId, `outputReferences[${index}].artifactId`)
    const sourceVersionId = identifier(item.sourceVersionId, `outputReferences[${index}].sourceVersionId`)
    const variantId = identifier(item.variantId, `outputReferences[${index}].variantId`)
    assertDomain(item.kind === 'proxy' || item.kind === 'final', 'INVALID_ARGUMENT', `outputReferences[${index}].kind is invalid`)
    assertDomain(sourceVersionId === baseVersionId, 'INVALID_ARGUMENT', `outputReferences[${index}] belongs to another version`)
    assertDomain(!seenArtifacts.has(artifactId), 'INVALID_ARGUMENT', `outputReferences[${index}].artifactId is duplicated`)
    seenArtifacts.add(artifactId)
    return Object.freeze({ artifactId, sourceVersionId, variantId, kind: item.kind })
  }).sort((left, right) => `${left.kind}:${left.artifactId}`.localeCompare(`${right.kind}:${right.artifactId}`))
  const affectedRanges = Object.freeze([Object.freeze({ startFrame: 0, endFrame: input.affectedEndFrame })])
  const renderRanges = Object.freeze([Object.freeze({ startFrame: 0, endFrame: input.renderEndFrame })])
  const affectedVariantIds = Object.freeze([...new Set(outputs.map((item) => item.variantId))].sort())
  const proxyVariantId = identifier(input.proxyVariantId, 'proxyVariantId')
  const body = {
    schemaVersion: 'editorial-cut-impact/v1' as const,
    commandId: identifier(input.commandId, 'commandId'),
    commandType: 'remove-spoken-content' as const,
    baseVersionId,
    resultVersionId: identifier(input.resultVersionId, 'resultVersionId'),
    sourceTranscriptId: identifier(input.sourceTranscriptId, 'sourceTranscriptId'),
    sourceTranscriptHash: sha256(input.sourceTranscriptHash, 'sourceTranscriptHash'),
    changeKinds: Object.freeze(['spoken-content-removal'] as const),
    dependencyTypes: Object.freeze(['audio', 'content', 'timing', 'visual'] as const),
    affectedRanges,
    affectedVariantIds,
    affectedArtifacts: Object.freeze(outputs),
    minimalRenders: Object.freeze([Object.freeze({ kind: 'proxy' as const, variantId: proxyVariantId, ranges: renderRanges })]),
    renderSemanticsChanged: true as const,
  }
  return Object.freeze({ ...body, impactHash: calculateCanonicalHash(body) })
}

/** Version two records all exact State siblings affected by a global edit.
 * The historical v1 constructor/parser and hashes stay unchanged. */
export interface EditorialCutImpactV2 extends Omit<EditorialCutImpactV1,'schemaVersion'> {schemaVersion:'editorial-cut-impact/v2'}
export function createEditorialCutImpactV2(input:Parameters<typeof createEditorialCutImpact>[0]&Readonly<{variantIds:readonly string[]}>):Readonly<EditorialCutImpactV2> {
  const prior=createEditorialCutImpact(input),ids=[...new Set(input.variantIds.map(id=>identifier(id,'variantId')))].sort()
  assertDomain(ids.length===input.variantIds.length&&ids.includes(input.proxyVariantId)&&prior.affectedArtifacts.every(a=>ids.includes(a.variantId)),
    'INVALID_COMMAND','Editorial affected variants must be exact State membership')
  const {impactHash:_hash,...body}=prior,document={...body,schemaVersion:'editorial-cut-impact/v2' as const,affectedVariantIds:Object.freeze(ids),
    affectedArtifacts:Object.freeze([...prior.affectedArtifacts].sort((a,b)=>{const x=a.kind+':'+a.artifactId,y=b.kind+':'+b.artifactId;return x<y?-1:x>y?1:0}))}
  return Object.freeze({...document,impactHash:calculateCanonicalHash(document)})
}
export function parseEditorialCutImpactV2(input:EditorialCutImpactV2):Readonly<EditorialCutImpactV2> {
  const fresh=createEditorialCutImpactV2({commandId:input.commandId,baseVersionId:input.baseVersionId,resultVersionId:input.resultVersionId,
    sourceTranscriptId:input.sourceTranscriptId,sourceTranscriptHash:input.sourceTranscriptHash,affectedEndFrame:input.affectedRanges[0]!.endFrame,
    renderEndFrame:input.minimalRenders[0]!.ranges[0]!.endFrame,proxyVariantId:input.minimalRenders[0]!.variantId,
    outputReferences:input.affectedArtifacts,variantIds:input.affectedVariantIds})
  assertDomain(stableSerialize(fresh)===stableSerialize(input),'PERSISTENCE_CONFLICT','Editorial2 impact seal differs')
  return fresh
}

export function parseEditorialCutImpact(value: unknown): Readonly<EditorialCutImpactV1> {
  const impact = record(value, 'Editorial cut impact') as unknown as EditorialCutImpactV1
  const expectedKeys = [
    'schemaVersion', 'commandId', 'commandType', 'baseVersionId', 'resultVersionId',
    'sourceTranscriptId', 'sourceTranscriptHash', 'changeKinds', 'dependencyTypes',
    'affectedRanges', 'affectedVariantIds', 'affectedArtifacts', 'minimalRenders',
    'renderSemanticsChanged', 'impactHash',
  ].sort()
  const actualKeys = Object.keys(impact).sort()
  assertDomain(actualKeys.length === expectedKeys.length && actualKeys.every((key, index) => key === expectedKeys[index]), 'PERSISTENCE_CONFLICT', 'Stored editorial cut impact fields are invalid')
  assertDomain(
    impact.schemaVersion === 'editorial-cut-impact/v1' && impact.commandType === 'remove-spoken-content' &&
    impact.renderSemanticsChanged === true && JSON.stringify(impact.changeKinds) === JSON.stringify(['spoken-content-removal']) &&
    JSON.stringify(impact.dependencyTypes) === JSON.stringify(['audio', 'content', 'timing', 'visual']) &&
    Array.isArray(impact.affectedRanges) && impact.affectedRanges.length === 1 && impact.affectedRanges[0]?.startFrame === 0 &&
    Number.isSafeInteger(impact.affectedRanges[0]?.endFrame) && Number(impact.affectedRanges[0]?.endFrame) > 0 &&
    Array.isArray(impact.affectedVariantIds) && Array.isArray(impact.affectedArtifacts) &&
    Array.isArray(impact.minimalRenders) && impact.minimalRenders.length === 1 &&
    impact.minimalRenders[0]?.kind === 'proxy' && Array.isArray(impact.minimalRenders[0].ranges) &&
    impact.minimalRenders[0].ranges.length === 1 && impact.minimalRenders[0].ranges[0]?.startFrame === 0 &&
    Number.isSafeInteger(impact.minimalRenders[0].ranges[0]?.endFrame) &&
    Number(impact.minimalRenders[0].ranges[0]?.endFrame) > 0 &&
    Number(impact.minimalRenders[0].ranges[0]?.endFrame) <= Number(impact.affectedRanges[0]?.endFrame),
    'PERSISTENCE_CONFLICT',
    'Stored editorial cut impact is invalid',
  )
  identifier(impact.commandId, 'impact commandId')
  identifier(impact.baseVersionId, 'impact baseVersionId')
  identifier(impact.resultVersionId, 'impact resultVersionId')
  identifier(impact.sourceTranscriptId, 'impact sourceTranscriptId')
  sha256(impact.sourceTranscriptHash, 'impact sourceTranscriptHash')
  sha256(impact.impactHash, 'impactHash')
  const recreated = createEditorialCutImpact({
    commandId: impact.commandId,
    baseVersionId: impact.baseVersionId,
    resultVersionId: impact.resultVersionId,
    sourceTranscriptId: impact.sourceTranscriptId,
    sourceTranscriptHash: impact.sourceTranscriptHash,
    affectedEndFrame: impact.affectedRanges[0]!.endFrame,
    renderEndFrame: impact.minimalRenders[0]!.ranges[0]!.endFrame,
    proxyVariantId: impact.minimalRenders[0]!.variantId,
    outputReferences: impact.affectedArtifacts,
  })
  assertDomain(stableSerialize(recreated) === stableSerialize(impact), 'PERSISTENCE_CONFLICT', 'Stored editorial cut impact is inconsistent')
  return Object.freeze(impact)
}

export function createEditorialCutInvalidations(input: {
  impact: Readonly<EditorialCutImpactV1|EditorialCutImpactV2>
  createdAt: string
}): readonly Readonly<CommandArtifactInvalidationV1>[] {
  const impact = input.impact.schemaVersion==='editorial-cut-impact/v2'?parseEditorialCutImpactV2(input.impact):parseEditorialCutImpact(input.impact)
  assertDomain(typeof input.createdAt === 'string' && !Number.isNaN(Date.parse(input.createdAt)), 'INVALID_ARGUMENT', 'createdAt must be an ISO timestamp')
  return Object.freeze(impact.affectedArtifacts.map((artifact) => {
    const identity = {
      schemaVersion: 'command-artifact-invalidation/v1' as const,
      status: 'stale' as const,
      commandId: impact.commandId,
      baseVersionId: impact.baseVersionId,
      resultVersionId: impact.resultVersionId,
      artifactId: artifact.artifactId,
      kind: artifact.kind,
      variantId: artifact.variantId,
      dependencyTypes: impact.dependencyTypes,
      affectedRanges: impact.affectedRanges,
      impactHash: impact.impactHash,
      createdAt: input.createdAt,
    }
    return Object.freeze({ ...identity, id: calculateCanonicalHash(identity) })
  }))
}
