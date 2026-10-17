import { createHash } from 'node:crypto'
import { calculateCanonicalHash } from './canonical-hash.ts'
import { assertDomain } from './errors.ts'
import { assertClipRate, timelineSpanForRate } from './clip-timing.ts'
import { assertMediaArtifactManifest, type MediaArtifactManifest } from './media-artifact.ts'
import { validateManualCropRegion, type ManualCropRegion } from './manual-editing.ts'
import type { ObservedClockFrame, ClockTimeBase } from './materialized-subtitle-clock.ts'
import { calculateOutputCanonicalHash, OUTPUT_CANONICAL_POLICY_VERSION, serializeOutputCanonicalJson } from './output-canonical-policy.ts'
import { createOutputSpecRevisionBody, freezeOutputJson, requireOutputHash, requireOutputId, type OutputJson, type OutputSpecRevisionBody } from './output-spec-revision.ts'
import type { ForkOutputSpecRevisionBodyV3 } from './output-spec-revision.ts'
import { createMediaTranscript, type MediaTranscript } from './media-transcript.ts'

/** Clock fields use the same observed PTS/TB types as W69. This is source/range
 * authority, never a pre-libass or MP4 clock and never an ASS emission grant. */
export interface OutputObservedProbeV3 {
  schemaVersion: 'output-observed-probe/v3'
  binarySha256: string
  rawJson: string
  rawSha256: string
  streamIndex: number
  mediaType:'video'|'audio'
  sampleRateHz:number|null
  channels:number|null
  originSource:'format-start-time'|'stream-start-time'
  originSeconds:Readonly<{numerator:string;denominator:string}>
  width: number
  height: number
  fps: Readonly<ClockTimeBase>|null
  rotationDegrees: number
  timeBase: Readonly<ClockTimeBase>
  frames: readonly Readonly<ObservedClockFrame>[]
  /** Each observed frame end; gaps are retained rather than filled by next PTS. */
  frameEndPts: readonly string[]
  /** End from the last frame's observed packet duration; no FPS inference. */
  endPts: string
}
export interface OutputArtifactFactV3 {
  artifactId: string
  manifestId: string
  manifest: Readonly<MediaArtifactManifest>
}
export interface OutputNormalizationReceiptV3 {
  schemaVersion: 'output-normalization-receipt/v3'
  canonicalPolicyVersion: typeof OUTPUT_CANONICAL_POLICY_VERSION
  id: string
  kind:'ffmpeg-video-derivative'|'ffprobe-original-audio'
  workspaceId: string
  projectId: string
  operationId: string
  attempt: number
  leaseOwner: string
  source: Readonly<OutputArtifactFactV3>
  derivative: Readonly<OutputArtifactFactV3>
  sourceProbe: Readonly<OutputObservedProbeV3>
  derivativeProbe: Readonly<OutputObservedProbeV3>
  audioProbes:Readonly<{source:Readonly<OutputObservedProbeV3>|null;derivative:Readonly<OutputObservedProbeV3>|null}>
  execution: Readonly<{
    provider: 'ffmpeg'|'ffprobe'
    recipeVersion:'media-normalization-execution/2026-10-14-v3'
    binarySha256: string
    argv: readonly string[]
    spawnObserved: true
    closeObserved: true
    exitCode: 0
    sourceSha256Before: string
    sourceSha256After: string
    derivativeSha256: string
    autorotate: boolean
  }>
  createdAt: string
}
export interface SealedOutputNormalizationV3 {
  document: Readonly<OutputNormalizationReceiptV3>
  receiptHash: string
}
export interface OutputMaterializedClipV3 {
  id: string
  trackId: string
  trackKind: string
  sourceArtifactId: string
  sourceInFrame: number
  sourceOutFrame: number
  timelineInFrame: number
  timelineOutFrame: number
  rate: number
  crop: Readonly<ManualCropRegion> | null
  videoNormalizationId: string
  videoNormalizationHash: string
  range:Readonly<ObservedOutputRangeV3>
  renderSource:Readonly<{artifactId:string;manifestId:string;manifestHash:string;artifactKey:string;sha256:string;byteSize:number}>
  audio: Readonly<{ artifactId: string; sourceInFrame: number; sourceOutFrame: number;
    normalizationId: string; normalizationHash: string;range:Readonly<ObservedOutputRangeV3>;
    renderSource:OutputMaterializedClipV3['renderSource'] }> | null
}
export interface OutputMaterializationBodyV3 {
  schemaVersion: 'output-materialization/v3'
  canonicalPolicyVersion: typeof OUTPUT_CANONICAL_POLICY_VERSION
  id: string
  workspaceId: string
  projectId: string
  resultVersionId: string
  variantId: string
  outputSpecRevisionId: string
  specHash: string
  planSnapshotId: string
  planHash: string
  fps: number
  durationFrames: number
  /** All plan containers retained; no generic recursive ID remap. */
  videoTracks: readonly Readonly<{ id: string; kind: string; clipIds: readonly string[] }>[]
  clips: readonly Readonly<OutputMaterializedClipV3>[]
  audioTracks: OutputJson
  music:Readonly<{trackId:string;artifactId:string;normalizationId:string;normalizationHash:string;range:ObservedOutputRangeV3;renderSource:OutputMaterializedClipV3['renderSource']}>[]
  overlayTracks: OutputJson
  subtitleTracks: OutputJson
  composition: OutputJson
  normalizations: readonly Readonly<SealedOutputNormalizationV3>[]
  emission: Readonly<{ subtitles: 'suppressed-missing-visual-clock-authority';
    cta: 'suppressed-missing-visual-clock-authority' }>
  createdAt: string
}
export interface OutputMaterializationV3 { document: Readonly<OutputMaterializationBodyV3>; materializationHash: string }

/** New target binding, not a target transcript/normalization execution. Every
 * original producer identity and receipt remains in its original project. */
export interface EditorialSourceBindingBodyV1 {
  schemaVersion:'editorial-source-binding/v1'
  canonicalPolicyVersion:typeof OUTPUT_CANONICAL_POLICY_VERSION
  id:string;workspaceId:string;projectId:string;parentVersionId:string;parentStateId:string;parentStateHash:string;resultVersionId:string
  authority:Readonly<{kind:'same-project-state3'|'fork-derivation3';sourceProjectId:string;sourceVersionId:string;sourceBaseHash:string;
    sourceStateId:string;sourceStateHash:string;forkRootVersionId:string|null;forkRootStateId:string|null;forkRootStateHash:string|null;
    derivationId:string|null;derivationHash:string|null}>
  transcript:Readonly<{id:string;workspaceId:string;projectId:string;sourceArtifactId:string;sourceManifestId:string;document:MediaTranscript;createdAt:string}>
  normalizationRefs:readonly Readonly<{id:string;projectId:string;receiptHash:string}>[]
  inventory:readonly Readonly<{linkId:string;artifactId:string;role:string;manifestId:string;manifestHash:string;artifactSha256:string;
    rightsSnapshotId:string|null;rightsHash:string|null;rightsRevision:number}>[]
  createdAt:string
}
export interface EditorialSourceBindingV1 {document:Readonly<EditorialSourceBindingBodyV1>;bindingHash:string}
export function createEditorialSourceBindingV1(input:EditorialSourceBindingBodyV1):Readonly<EditorialSourceBindingV1> {
  const d=json(input)
  check(Object.keys(d).sort().join('|')===['schemaVersion','canonicalPolicyVersion','id','workspaceId','projectId','parentVersionId','parentStateId','parentStateHash',
    'resultVersionId','authority','transcript','normalizationRefs','inventory','createdAt'].sort().join('|') &&
    d.schemaVersion==='editorial-source-binding/v1'&&d.canonicalPolicyVersion===policy,'Editorial source binding contract differs')
  for(const [key,value]of Object.entries({id:d.id,workspaceId:d.workspaceId,projectId:d.projectId,parentVersionId:d.parentVersionId,
    parentStateId:d.parentStateId,resultVersionId:d.resultVersionId}))requireOutputId(value,key)
  requireOutputHash(d.parentStateHash,'editorial parent State');utc(d.createdAt)
  const a=d.authority,t=d.transcript
  check(Object.keys(a).sort().join('|')===['kind','sourceProjectId','sourceVersionId','sourceBaseHash','sourceStateId','sourceStateHash',
    'forkRootVersionId','forkRootStateId','forkRootStateHash','derivationId','derivationHash'].sort().join('|') &&
    ['same-project-state3','fork-derivation3'].includes(a.kind),'Editorial source authority kind differs')
  for(const key of ['sourceProjectId','sourceVersionId','sourceStateId']as const)requireOutputId(a[key],key)
  for(const h of [a.sourceBaseHash,a.sourceStateHash])requireOutputHash(h,'source authority hash')
  const fork=[a.forkRootVersionId,a.forkRootStateId,a.forkRootStateHash,a.derivationId,a.derivationHash]
  check(a.kind==='same-project-state3'?a.sourceProjectId===d.projectId&&fork.every(v=>v===null):fork.every(v=>typeof v==='string'),
    'Editorial fork provenance presence differs')
  if(a.kind==='fork-derivation3') {
    for(const id of [a.forkRootVersionId,a.forkRootStateId,a.derivationId])requireOutputId(id,'fork provenance')
    for(const h of [a.forkRootStateHash,a.derivationHash])requireOutputHash(h,'fork provenance hash')
  }
  check(Object.keys(t).sort().join('|')===['id','workspaceId','projectId','sourceArtifactId','sourceManifestId','document','createdAt'].sort().join('|')&&
    t.workspaceId===d.workspaceId&&t.projectId===a.sourceProjectId,'Editorial transcript retains original producer scope')
  for(const id of [t.id,t.sourceArtifactId,t.sourceManifestId])requireOutputId(id,'original transcript reference')
  utc(t.createdAt)
  const {schemaVersion,transcriptHash,...facts}=t.document,fresh=createMediaTranscript(facts)
  check(schemaVersion===fresh.schemaVersion&&same(fresh,t.document)&&transcriptHash===fresh.transcriptHash,'Editorial original transcript seal differs')
  check(d.normalizationRefs.length>0&&new Set(d.normalizationRefs.map(r=>r.id)).size===d.normalizationRefs.length&&
    d.inventory.length>0&&new Set(d.inventory.map(r=>r.linkId)).size===d.inventory.length,'Editorial source membership is empty or repeated')
  for(const r of d.normalizationRefs) {
    check(Object.keys(r).sort().join('|')===['id','projectId','receiptHash'].sort().join('|'),'Editorial normalization reference fields differ')
    requireOutputId(r.id,'normalization');requireOutputId(r.projectId,'normalization original project');requireOutputHash(r.receiptHash,'original normalization seal')
  }
  for(const r of d.inventory) {
    check(Object.keys(r).sort().join('|')===['linkId','artifactId','role','manifestId','manifestHash','artifactSha256','rightsSnapshotId','rightsHash','rightsRevision'].sort().join('|') &&
      Number.isSafeInteger(r.rightsRevision)&&r.rightsRevision>=0&&(r.rightsSnapshotId===null)===(r.rightsHash===null),'Editorial target inventory fields differ')
    for(const id of [r.linkId,r.artifactId,r.manifestId])requireOutputId(id,'target inventory identity')
    for(const h of [r.manifestHash,r.artifactSha256])requireOutputHash(h,'target inventory bytes')
    if(r.rightsSnapshotId!==null){requireOutputId(r.rightsSnapshotId,'target current rights');requireOutputHash(r.rightsHash,'target current rights hash')}
  }
  return Object.freeze({document:d,bindingHash:calculateOutputCanonicalHash(d)})
}
export interface EditorialDerivedMaterializationBodyV1 extends Omit<OutputMaterializationBodyV3,'schemaVersion'> {
  schemaVersion:'editorial-derived-materialization/v1'
  sourceBinding:Readonly<EditorialSourceBindingV1>
}
export interface EditorialDerivedMaterializationV1 {document:Readonly<EditorialDerivedMaterializationBodyV1>;materializationHash:string}

const policy = OUTPUT_CANONICAL_POLICY_VERSION
const json = <T>(v: T): Readonly<T> => freezeOutputJson(v as unknown as OutputJson) as unknown as Readonly<T>
const same = (a: unknown, b: unknown) => serializeOutputCanonicalJson(a) === serializeOutputCanonicalJson(b)
const check = (v: unknown, m: string) => assertDomain(Boolean(v), 'INVALID_RENDER_INPUT', m)
const sha = (v: string) => createHash('sha256').update(v, 'utf8').digest('hex')
function exact(v: object, keys: readonly string[]) {
  check(v && typeof v === 'object' && !Array.isArray(v) &&
    Object.keys(v).length === keys.length && keys.every(k => Object.hasOwn(v,k)), 'Materialization fields missing or unsupported')
}
function utc(v: string) { check(typeof v === 'string' && Number.isFinite(Date.parse(v)) && new Date(v).toISOString()===v,'Noncanonical materialization time') }
function integer(v: unknown): v is number { return typeof v === 'number' && Number.isSafeInteger(v) && v >= 0 }

export function decimalSeconds(value:string):Readonly<{numerator:string;denominator:string}> {
  check(typeof value==='string'&&/^-?\d+(?:\.\d{1,18})?$/.test(value),'Observed decimal timestamp missing')
  const negative=value.startsWith('-'),unsigned=negative?value.slice(1):value
  const [whole,fraction='']=unsigned.split('.')
  let numerator=BigInt(whole+fraction)*(negative?-BigInt(1):BigInt(1)),denominator=BigInt(10)**BigInt(fraction.length)
  const gcd=(a:bigint,b:bigint):bigint=>{if(a<BigInt(0))a=-a;while(b!==BigInt(0)){const r=a%b;a=b;b=r}return a}
  const g=gcd(numerator,denominator);numerator/=g;denominator/=g
  return Object.freeze({numerator:numerator.toString(),denominator:denominator.toString()})
}

function rational(tb: ClockTimeBase) {
  exact(tb,['numerator','denominator'])
  check(/^[1-9][0-9]{0,9}$/.test(tb.numerator) && /^[1-9][0-9]{0,9}$/.test(tb.denominator) &&
    BigInt(tb.numerator)<=BigInt(2147483647) && BigInt(tb.denominator)<=BigInt(2147483647),'Invalid observed rational')
}
export function validateOutputObservedProbeV3(input: OutputObservedProbeV3): Readonly<OutputObservedProbeV3> {
  const p=json(input)
  exact(p,['schemaVersion','binarySha256','rawJson','rawSha256','streamIndex','mediaType','sampleRateHz','channels','originSource','originSeconds','width','height','fps','rotationDegrees','timeBase','frames','frameEndPts','endPts'])
  check(p.schemaVersion==='output-observed-probe/v3','Unsupported observed probe')
  requireOutputHash(p.binarySha256,'probe binary'); requireOutputHash(p.rawSha256,'probe raw JSON')
  check(typeof p.rawJson==='string' && Buffer.byteLength(p.rawJson,'utf8')<=64*1024*1024 &&
    sha(p.rawJson)===p.rawSha256,'Observed probe raw bytes differ')
  const raw=JSON.parse(p.rawJson) as {streams?: Record<string,unknown>[];frames?: Record<string,unknown>[];format?:Record<string,unknown>}
  check(Array.isArray(raw.streams)&&raw.streams.every(s=>s!==null&&typeof s==='object'&&!Array.isArray(s)&&integer(s.index)) &&
    new Set(raw.streams.map(s=>s.index)).size===raw.streams.length,'Malformed or duplicate observed stream index')
  const selected=raw.streams!.filter(s=>s.index===p.streamIndex)
  check(selected.length===1,'Observed stream index missing or ambiguous')
  const stream=selected[0]
  check(stream && stream.codec_type===p.mediaType && integer(p.streamIndex),'Observed stream type differs')
  if(p.mediaType==='video') {
    check(stream!.width===p.width && stream!.height===p.height && p.width>0 && p.height>0 &&
      p.sampleRateHz===null && p.channels===null && p.fps!==null,'Observed video geometry differs')
    rational(p.fps!)
    check(stream!.avg_frame_rate===p.fps!.numerator+'/'+p.fps!.denominator,'Observed video FPS differs')
  } else {
    check(p.mediaType==='audio' && p.width===0 && p.height===0 && p.fps===null &&
      Number(stream!.sample_rate)===p.sampleRateHz && integer(p.sampleRateHz)&&p.sampleRateHz>0 &&
      stream!.channels===p.channels && integer(p.channels)&&p.channels>0 && p.channels<=8,'Observed audio clock/channels differ')
  }
  rational(p.timeBase)
  check(stream!.time_base===p.timeBase.numerator+'/'+p.timeBase.denominator,'Observed stream timebase differs')
  exact(p.originSeconds,['numerator','denominator'])
  check(p.originSource==='format-start-time'||p.originSource==='stream-start-time','Observed origin source missing')
  const measuredOrigin=p.originSource==='format-start-time'?raw.format?.start_time:stream!.start_time
  check(typeof measuredOrigin==='string','Observed demux/stream start time is required')
  const origin=decimalSeconds(measuredOrigin as string)
  check(same(origin,p.originSeconds),'Observed demux origin differs from raw bytes')
  const side=(stream!.side_data_list as {rotation?:unknown}[]|undefined)?.filter(x=>x.rotation!==undefined) ?? []
  const tags=stream!.tags as {rotate?:unknown}|undefined
  const rotations=[...side.map(x=>Number(x.rotation)),...(tags?.rotate!==undefined?[Number(tags.rotate)]:[])]
  check(Number.isFinite(p.rotationDegrees) && (rotations.length===0?p.rotationDegrees===0:
    rotations.every(r=>Number.isFinite(r)&&r===p.rotationDegrees)),'Observed orientation differs')
  check(Array.isArray(raw.frames)&&raw.frames.every(f=>f!==null&&typeof f==='object'&&!Array.isArray(f)&&
    integer(f.stream_index)&&typeof f.media_type==='string'&&
    (typeof f.best_effort_timestamp==='string'&&/^-?(?:0|[1-9][0-9]*)$/.test(f.best_effort_timestamp)||
      typeof f.best_effort_timestamp==='number'&&Number.isSafeInteger(f.best_effort_timestamp))&&
    (f.stream_index!==p.streamIndex||f.media_type===p.mediaType)&&
    (typeof (f.duration??f.pkt_duration)==='string'&&/^[1-9][0-9]*$/.test((f.duration??f.pkt_duration) as string)||
      typeof (f.duration??f.pkt_duration)==='number'&&Number.isSafeInteger(f.duration??f.pkt_duration)&&Number(f.duration??f.pkt_duration)>0)),'Malformed or unsafe raw frame record')
  const rawFrames=raw.frames!.filter(f=>f.media_type===p.mediaType && f.stream_index===p.streamIndex)
  check(rawFrames && rawFrames.length>0 && rawFrames.length===p.frames.length,'Full observed frame sequence missing')
  check(Array.isArray(p.frameEndPts)&&p.frameEndPts.length===p.frames.length,'Observed frame end sequence missing')
  let previous: bigint|null=null
  for(const [i,f] of p.frames.entries()) {
    exact(f,['frame','pts','timeBase'])
    const r=rawFrames![i]!
    check(typeof r.best_effort_timestamp==='string'||typeof r.best_effort_timestamp==='number'&&Number.isSafeInteger(r.best_effort_timestamp),
      'Unsafe observed timestamp must not be rounded by JSON.parse')
    check(f.frame===i && same(f.timeBase,p.timeBase) && /^-?(?:0|[1-9][0-9]{0,18})$/.test(f.pts) &&
      String(r.best_effort_timestamp)===f.pts,'Observed PTS sequence differs from raw JSON')
    const pts=BigInt(f.pts),duration=r.duration??r.pkt_duration
    check(/^-?(?:0|[1-9][0-9]{0,18})$/.test(p.frameEndPts[i]!)&&
      BigInt(p.frameEndPts[i]!)===pts+BigInt(String(duration)),'Observed frame end differs from raw duration')
    check(pts!==-(BigInt(1)<<BigInt(63)) && pts>=(previous??pts-BigInt(1)) && (previous===null||pts>previous),
      'Observed PTS missing, duplicate or nonmonotonic')
    previous=pts
  }
  const last=rawFrames![rawFrames!.length-1]!,duration=last.duration??last.pkt_duration
  check(typeof duration==='string'&&/^[1-9][0-9]*$/.test(duration)||typeof duration==='number'&&Number.isSafeInteger(duration)&&duration>0,
    'Measured terminal frame duration missing or unsafe')
  check(/^-?(?:0|[1-9][0-9]{0,18})$/.test(p.endPts) &&
    BigInt(p.endPts)===BigInt(p.frames[p.frames.length-1]!.pts)+BigInt(String(duration)),
    'Terminal PTS must match observed last-frame duration')
  return p
}
export function sealOutputNormalizationV3(input: OutputNormalizationReceiptV3): Readonly<SealedOutputNormalizationV3> {
  const d=json(input)
  exact(d,['schemaVersion','canonicalPolicyVersion','id','kind','workspaceId','projectId','operationId','attempt','leaseOwner',
    'source','derivative','sourceProbe','derivativeProbe','audioProbes','execution','createdAt'])
  check(d.schemaVersion==='output-normalization-receipt/v3' && d.canonicalPolicyVersion===policy,'Unsupported normalization authority')
  for(const [k,v] of Object.entries({id:d.id,workspaceId:d.workspaceId,projectId:d.projectId,operationId:d.operationId,leaseOwner:d.leaseOwner}))requireOutputId(v,k)
  check(integer(d.attempt)&&d.attempt>0,'Normalization requires actual attempt')
  utc(d.createdAt)
  for(const f of [d.source,d.derivative]) {
    exact(f,['artifactId','manifestId','manifest']);requireOutputId(f.artifactId,'artifact');requireOutputId(f.manifestId,'manifest')
    assertMediaArtifactManifest(f.manifest);check(['video','audio'].includes(f.manifest.artifact.mediaType),'Unsupported source normalization media')
  }
  check(d.kind==='ffmpeg-video-derivative'||d.kind==='ffprobe-original-audio','Normalization kind required')
  const a=validateOutputObservedProbeV3(d.sourceProbe),b=validateOutputObservedProbeV3(d.derivativeProbe),e=d.execution

  exact(d.audioProbes,['source','derivative'])
  for(const [audio,video] of [[d.audioProbes.source,a],[d.audioProbes.derivative,b]] as const) {
    if(audio!==null) {
      const checked=validateOutputObservedProbeV3(audio)
      check(checked.mediaType==='audio' && checked.rawJson===video.rawJson && checked.rawSha256===video.rawSha256 &&
        checked.binarySha256===video.binarySha256,'Audio must bind identical observed probe bytes')
    } else {
      const raw=JSON.parse(video.rawJson) as {streams:Record<string,unknown>[]}
      check(!raw.streams.some(s=>s.codec_type==='audio'),'Observed audio stream authority omitted')
    }
  }

  exact(e,['provider','recipeVersion','binarySha256','argv','spawnObserved','closeObserved','exitCode','sourceSha256Before','sourceSha256After','derivativeSha256','autorotate'])
  requireOutputHash(e.binarySha256,'normalization binary')
  check(e.recipeVersion==='media-normalization-execution/2026-10-14-v3' && e.spawnObserved===true && e.closeObserved===true && e.exitCode===0 &&
    e.sourceSha256Before===d.source.manifest.artifact.sha256 && e.sourceSha256After===e.sourceSha256Before &&
    e.derivativeSha256===d.derivative.manifest.artifact.sha256 && e.argv.length>0 &&
    e.argv.every(x=>typeof x==='string'&&!x.includes('\0')),'Normalization execution bytes/terminality mismatch')
  if(d.kind==='ffprobe-original-audio') {
    check(e.provider==='ffprobe' && e.autorotate===false && same(d.source,d.derivative) && same(a,b) &&
      a.mediaType==='audio' && a.binarySha256===e.binarySha256,'Original audio identity/probe differs')
  } else {
    const expectedArgv=['-hide_banner','-loglevel','error','-y','-i',e.argv[5],'-map','0:v:0','-map','0:a:0?',
      '-vf','scale=w=1280:h=1280:force_original_aspect_ratio=decrease:force_divisible_by=2:flags=lanczos',
      '-c:v','libx264','-preset','veryfast','-crf','24','-pix_fmt','yuv420p','-c:a','aac','-b:a','128k','-ar','48000',
      '-movflags','+faststart',e.argv.at(-1)]
    check(typeof e.argv[5]==='string'&&e.argv[5].length>0&&e.argv.at(-1)!==e.argv[5]&&same(e.argv,expectedArgv),
      'Normalization argv differs from the fixed versioned recipe')
    check(d.derivative.manifest.recipe.id==='editing-proxy'&&d.derivative.manifest.recipe.version==='1.2.0'&&d.derivative.manifest.recipe.parametersHash===calculateCanonicalHash({
        normalizationPolicy:'output-normalization-receipt/v3',maxWidth:1280,maxHeight:1280,videoCodec:'h264',audioCodec:'aac'}),
      'Normalization derivative recipe differs')
    check(e.provider==='ffmpeg' && e.autorotate===true && a.mediaType==='video' && b.mediaType==='video' &&
      d.source.artifactId!==d.derivative.artifactId,'Video derivative execution differs')
    const lineage=d.derivative.manifest.sources.filter(s=>s.artifactKey===d.source.manifest.artifact.artifactKey &&
      s.sha256===d.source.manifest.artifact.sha256 && s.role==='source-master')
    check(lineage.length===1 && 'execution' in lineage[0]! &&
      (lineage[0] as unknown as {execution:{tool:{id:string;digest:string}}}).execution.tool.id==='ffmpeg' &&
      (lineage[0] as unknown as {execution:{tool:{id:string;digest:string}}}).execution.tool.digest===e.binarySha256,'Normalization manifest lacks actual FFmpeg lineage')
    for(const [probe,f] of [[a,d.source],[b,d.derivative]] as const) {
      const m=f.manifest.probe
      check(m && m.width===probe.width && m.height===probe.height && probe.fps!==null &&
        m.fps===Number(probe.fps.numerator)/Number(probe.fps.denominator),'Manifest and measured probe differ')
    }
    check(b.rotationDegrees===0,'Derivative still carries unapplied display rotation')
  }
  return Object.freeze({document:d,receiptHash:calculateOutputCanonicalHash(d)})
}
export function validateOutputNormalizationV3(value: SealedOutputNormalizationV3) {
  const result=sealOutputNormalizationV3(value.document)
  check(result.receiptHash===value.receiptHash,'Normalization seal differs')
  return result
}

export interface ObservedRangeCoverageV3 {
  originSeconds:Readonly<{numerator:string;denominator:string}>
  firstFrame:number
  lastFrame:number
  endExclusivePts:string
  timeBase:ClockTimeBase
  coverage:'complete'|'contains-measured-gaps'
  segments:readonly Readonly<{frame:number;startPts:string;endPts:string}>[]
  gaps:readonly Readonly<{startPts:string;endPts:string}>[]
}
export interface ObservedOutputRangeV3 {
  schemaVersion:'observed-output-range/v3'
  startSeconds:Readonly<{numerator:string;denominator:string}>
  endSeconds:Readonly<{numerator:string;denominator:string}>
  source:Readonly<ObservedRangeCoverageV3>
  derivative:Readonly<ObservedRangeCoverageV3>
}
/** Exact fraction of the existing finite binary64 FPS value. This describes the
 * request's frame domain, not FFmpeg/libass conversion or a sampled n/fps clock. */
function frameSeconds(frame:number,fps:number):Readonly<{numerator:string;denominator:string}> {
  const bytes=new DataView(new ArrayBuffer(8));bytes.setFloat64(0,fps,false)
  const hi=bytes.getUint32(0,false),lo=bytes.getUint32(4,false),exponent=(hi>>>20)&2047
  let numerator=(BigInt(hi&0xfffff)<<BigInt(32))|BigInt(lo),denominator=BigInt(1)
  check(exponent>0 && exponent<2047 && (hi>>>31)===0,'Invalid range FPS')
  numerator|=BigInt(1)<<BigInt(52)
  const power=exponent-1023-52
  if(power>=0)numerator<<=BigInt(power);else denominator<<=BigInt(-power)
  let n=BigInt(frame)*denominator,d=numerator
  const gcd=(a:bigint,b:bigint):bigint=>{while(b!==BigInt(0)){const r=a%b;a=b;b=r}return a}
  const g=gcd(n,d);n/=g;d/=g
  return Object.freeze({numerator:n.toString(),denominator:d.toString()})
}
function observedRange(probe:OutputObservedProbeV3,start:Readonly<{numerator:string;denominator:string}>,
  end:Readonly<{numerator:string;denominator:string}>) {
  const origin=probe.originSeconds,tb=probe.timeBase
  const compare=(pts:string,seconds:Readonly<{numerator:string;denominator:string}>)=>{
    const left=(BigInt(pts)*BigInt(tb.numerator)*BigInt(origin.denominator)-BigInt(origin.numerator)*BigInt(tb.denominator))*BigInt(seconds.denominator)
    const right=BigInt(seconds.numerator)*BigInt(tb.denominator)*BigInt(origin.denominator)
    return left<right?-1:left>right?1:0
  }
  check(compare(probe.endPts,end)>=0,'Range end exceeds measured terminal frame boundary')
  check(compare(probe.frames[0]!.pts,start)<=0,'Requested range begins before measured initial coverage')
  let first=-1,last=-1,coveredEnd:bigint|null=null
  const segments:{frame:number;startPts:string;endPts:string}[]=[],gaps:{startPts:string;endPts:string}[]=[]
  for(let i=0;i<probe.frames.length;i++) {
    const f=probe.frames[i]!,frameEnd=probe.frameEndPts[i]!
    if(compare(frameEnd,start)>0 && compare(f.pts,end)<0) {
      if(first<0)first=i
      if(coveredEnd!==null && BigInt(f.pts)>coveredEnd)gaps.push({startPts:coveredEnd.toString(),endPts:f.pts})
      segments.push({frame:i,startPts:f.pts,endPts:frameEnd});last=i
      coveredEnd=coveredEnd===null||BigInt(frameEnd)>coveredEnd?BigInt(frameEnd):coveredEnd
    }
  }
  check(first>=0&&last>=first&&compare(probe.frames[first]!.pts,start)<=0,
    'Requested range starts in an observed gap or has no observed source frames')
  check(coveredEnd!==null&&compare(coveredEnd.toString(),end)>=0,'Requested range ends in an observed gap')
  return Object.freeze({originSeconds:origin,firstFrame:first,lastFrame:last,
    endExclusivePts:coveredEnd!.toString(),timeBase:tb,coverage:gaps.length?'contains-measured-gaps' as const:'complete' as const,
    segments:Object.freeze(segments),gaps:Object.freeze(gaps)})
}
export function materializeObservedOutputRangeV3(receipt:SealedOutputNormalizationV3,
  startFrame:number,endFrame:number,fps:number):Readonly<ObservedOutputRangeV3> {
  check(integer(startFrame)&&integer(endFrame)&&endFrame>startFrame,'Invalid normalized frame range')
  const startSeconds=frameSeconds(startFrame,fps),endSeconds=frameSeconds(endFrame,fps)
  return Object.freeze({schemaVersion:'observed-output-range/v3',startSeconds,endSeconds,
    source:observedRange(receipt.document.sourceProbe,startSeconds,endSeconds),
    derivative:observedRange(receipt.document.derivativeProbe,startSeconds,endSeconds)})
}

function renderSourceV3(fact:Readonly<OutputArtifactFactV3>):OutputMaterializedClipV3['renderSource'] {
  return {artifactId:fact.artifactId,manifestId:fact.manifestId,manifestHash:fact.manifest.manifestHash,
    artifactKey:fact.manifest.artifact.artifactKey,sha256:fact.manifest.artifact.sha256,byteSize:fact.manifest.artifact.byteSize}
}
export interface MaterializationPlanV3 {
  schemaVersion: 2
  id: string
  projectVersionId: string
  fps: number
  durationFrames: number
  videoTracks: readonly Readonly<{id:string;kind:string;clips:readonly Readonly<{
    id:string;sourceArtifactId:string;sourceInFrame:number;sourceOutFrame:number;
    timelineInFrame:number;timelineOutFrame:number;rate:number;crop?:ManualCropRegion;
    audioSourceArtifactId?:string;audioSourceInFrame?:number;audioSourceOutFrame?:number
  }>[]}>[]
  audioTracks: OutputJson
  overlayTracks: OutputJson
  subtitleTracks: OutputJson
  composition?: OutputJson
}
interface ObservedMaterializationInputV3 {
  id:string; workspaceId:string; projectId:string; resultVersionId:string; planSnapshotId:string;
  planHash:string; plan:MaterializationPlanV3; spec:OutputSpecRevisionBody;
  normalizations:readonly SealedOutputNormalizationV3[]; createdAt:string
}
export function materializeOutputV3(input:Readonly<ObservedMaterializationInputV3>):Readonly<OutputMaterializationV3> {
  return materializeObservedPlan(input,null)
}
export function materializeEditorialDerivedOutputV1(input:Readonly<Omit<ObservedMaterializationInputV3,'spec'> & {
  spec:OutputSpecRevisionBody|ForkOutputSpecRevisionBodyV3;sourceBinding:EditorialSourceBindingV1
}>):Readonly<EditorialDerivedMaterializationV1> {
  const binding=createEditorialSourceBindingV1(input.sourceBinding.document),b=binding.document
  check(binding.bindingHash===input.sourceBinding.bindingHash&&b.workspaceId===input.workspaceId&&b.projectId===input.projectId&&
    b.resultVersionId===input.resultVersionId&&b.createdAt===input.createdAt,'Editorial materialization binding/target differs')
  const revision=input.spec,effective=revision.schemaVersion==='output-spec-revision/v1'?revision:revision.effectiveSpec
  check(revision.workspaceId===input.workspaceId&&revision.projectId===input.projectId&&effective.id===revision.id&&effective.variantId===revision.variantId&&
    effective.projectId===revision.projectId&&effective.workspaceId===revision.workspaceId,'Editorial effective geometry cannot relabel its revision')
  // effectiveSpec configures geometry only; the actual revision3 seal remains
  // the document's specHash and the existing scoped composite foreign key.
  const projection=materializeObservedPlan({...input,spec:effective},binding)
  const document=json({...projection.document,schemaVersion:'editorial-derived-materialization/v1' as const,
    specHash:calculateOutputCanonicalHash(revision),sourceBinding:binding})
  return Object.freeze({document,materializationHash:calculateOutputCanonicalHash(document)})
}
function materializeObservedPlan(input:Readonly<ObservedMaterializationInputV3>,binding:EditorialSourceBindingV1|null): Readonly<OutputMaterializationV3> {
  const spec=createOutputSpecRevisionBody(input.spec),p=json(input.plan)
  for(const [k,v] of Object.entries({id:input.id,workspaceId:input.workspaceId,projectId:input.projectId,
    resultVersionId:input.resultVersionId,planSnapshotId:input.planSnapshotId}))requireOutputId(v,k)
  requireOutputHash(input.planHash,'plan hash');utc(input.createdAt)
  check(p.schemaVersion===2 && p.projectVersionId===input.resultVersionId && integer(p.durationFrames) &&
    p.durationFrames>0 && Number.isFinite(p.fps) && p.fps>0 && spec.workspaceId===input.workspaceId &&
    spec.projectId===input.projectId,'Materialization plan/revision scope differs')
  // Plans already use timeline-normalized frame ranges. Different native/output
  // FPS is explicitly retained, never used to relabel native frame ordinals.
  const receipts=input.normalizations.map(validateOutputNormalizationV3),seen=new Set<string>(),used=new Set<string>()
  check(new Set(receipts.map(r=>r.document.id)).size===receipts.length,'Duplicate normalization identity')
  if(binding===null)for(const r of receipts)check(r.document.workspaceId===input.workspaceId && r.document.projectId===input.projectId,'Foreign normalization receipt')
  else {
    const b=binding.document,refs=new Map(b.normalizationRefs.map(r=>[r.id,r]))
    check(refs.size===receipts.length&&receipts.every(r=>r.document.workspaceId===input.workspaceId&&
      refs.get(r.document.id)?.projectId===r.document.projectId&&refs.get(r.document.id)?.receiptHash===r.receiptHash),
      'Editorial reuse must retain exact original receipt identities and hashes')
    for(const r of receipts)for(const fact of [r.document.source,r.document.derivative])check(b.inventory.some(i=>
      i.artifactId===fact.artifactId&&i.manifestId===fact.manifestId&&i.manifestHash===fact.manifest.manifestHash&&
      i.artifactSha256===fact.manifest.artifact.sha256),'Editorial target inventory must cover every actual observed artifact')
    check(receipts.some(r=>r.document.source.artifactId===b.transcript.sourceArtifactId&&r.document.source.manifestId===b.transcript.sourceManifestId&&
      r.document.projectId===b.transcript.projectId),'Editorial transcript needs its exact original normalization source')
  }
  const forArtifact=(id:string)=>{
    const found=receipts.filter(r=>r.document.source.artifactId===id)
    check(found.length===1,'Missing or ambiguous source normalization')
    used.add(found[0]!.document.id);return found[0]!
  }
  const clips:OutputMaterializedClipV3[]=[]
  const tracks=p.videoTracks.map(t=>{
    requireOutputId(t.id,'track')
    check(typeof t.kind==='string' && t.kind.length>0,'Missing track kind')
    for(const c of t.clips) {
      requireOutputId(c.id,'clip');check(!seen.has(c.id),'Duplicate clip');seen.add(c.id)
      check([c.sourceInFrame,c.sourceOutFrame,c.timelineInFrame,c.timelineOutFrame].every(integer) &&
        c.sourceOutFrame>c.sourceInFrame && c.timelineOutFrame>c.timelineInFrame &&
        c.timelineOutFrame<=p.durationFrames,'Invalid source/timeline range')
      assertClipRate(c.rate)
      check(timelineSpanForRate(c.sourceOutFrame-c.sourceInFrame,c.rate)===c.timelineOutFrame-c.timelineInFrame,'Rate map differs from shared timing')
      const n=forArtifact(c.sourceArtifactId)
      check(n.document.sourceProbe.mediaType==='video','Video clip requires observed video source')
      const audioArtifactId=c.audioSourceArtifactId??c.sourceArtifactId
      const audioReceipt=forArtifact(audioArtifactId),sourceAudio=audioReceipt.document.kind==='ffprobe-original-audio'?
        audioReceipt.document.sourceProbe:audioReceipt.document.audioProbes.source
      const derivativeAudio=audioReceipt.document.kind==='ffprobe-original-audio'?audioReceipt.document.derivativeProbe:
        audioReceipt.document.audioProbes.derivative
      const audio=sourceAudio===null||derivativeAudio===null?null:(()=>{
        const start=c.audioSourceInFrame??c.sourceInFrame,end=c.audioSourceOutFrame??c.sourceOutFrame
        check(integer(start)&&integer(end)&&end>start&&timelineSpanForRate(end-start,c.rate)===c.timelineOutFrame-c.timelineInFrame,'Primary/secondary audio rate map invalid')
        const audioRange={...audioReceipt,document:{...audioReceipt.document,sourceProbe:sourceAudio,derivativeProbe:derivativeAudio}}
        return {artifactId:audioArtifactId,sourceInFrame:start,sourceOutFrame:end,normalizationId:audioReceipt.document.id,
          normalizationHash:audioReceipt.receiptHash,range:materializeObservedOutputRangeV3(audioRange,start,end,p.fps),
          renderSource:renderSourceV3(audioReceipt.document.derivative)}
      })()
      check(c.audioSourceArtifactId===undefined||audio!==null,'Explicit clip audio authority missing')
      const render=n.document.derivative
      clips.push({id:c.id,trackId:t.id,trackKind:t.kind,sourceArtifactId:c.sourceArtifactId,sourceInFrame:c.sourceInFrame,
        sourceOutFrame:c.sourceOutFrame,timelineInFrame:c.timelineInFrame,timelineOutFrame:c.timelineOutFrame,rate:c.rate,
        crop:c.crop===undefined?null:validateManualCropRegion(c.crop),videoNormalizationId:n.document.id,
        videoNormalizationHash:n.receiptHash,range:materializeObservedOutputRangeV3(n,c.sourceInFrame,c.sourceOutFrame,p.fps),
        renderSource:{artifactId:render.artifactId,manifestId:render.manifestId,manifestHash:render.manifest.manifestHash,
          artifactKey:render.manifest.artifact.artifactKey,sha256:render.manifest.artifact.sha256,byteSize:render.manifest.artifact.byteSize},audio})
    }
    return {id:t.id,kind:t.kind,clipIds:t.clips.map(c=>c.id)}
  })
  check(clips.length>0 && new Set(tracks.map(t=>t.id)).size===tracks.length,'Materialization needs explicit tracks')
  check(Array.isArray(p.audioTracks) && Array.isArray(p.overlayTracks) && Array.isArray(p.subtitleTracks),
    'All plan track containers must be explicit')
  // Background music/audio-only facts have distinct contracts. Never silently
  // omit them from the consumed source inventory.

  const music:OutputMaterializationBodyV3['music']=[]
  for(const track of p.audioTracks as readonly Readonly<Record<string,OutputJson>>[]) {
    check(track.kind==='background-music' && typeof track.id==='string' && typeof track.artifactId==='string' &&
      typeof track.analysisId==='string' && typeof track.analysisHash==='string' && typeof track.rightsSnapshotId==='string',
      'Background music requires its actual analysis/rights references')
    requireOutputHash(track.analysisHash,'music analysis')
    const n=forArtifact(track.artifactId as string)
    check(n.document.kind==='ffprobe-original-audio' && n.document.sourceProbe.mediaType==='audio',
      'Music requires an observed original audio source')
    check(integer(track.sourceInFrame)&&integer(track.sourceOutFrame)&&integer(track.timelineInFrame)&&integer(track.timelineOutFrame)&&
      track.timelineInFrame===0 && track.timelineOutFrame===p.durationFrames && track.sourceOutFrame>track.sourceInFrame &&
      track.sourceOutFrame-track.sourceInFrame>=p.durationFrames && typeof track.gainDb==='number'&&Number.isFinite(track.gainDb)&&
      track.gainDb>=-60&&track.gainDb<=-12 && integer(track.fadeInFrames)&&integer(track.fadeOutFrames),
      'Music range/gain/fades differ from the existing contract')
    music.push({trackId:track.id as string,artifactId:track.artifactId as string,normalizationId:n.document.id,
      normalizationHash:n.receiptHash,range:materializeObservedOutputRangeV3(n,track.sourceInFrame as number,track.sourceOutFrame as number,p.fps),
      renderSource:renderSourceV3(n.document.derivative)})
  }

  check(binding===null?used.size===receipts.length:used.size>0,'Hidden or unused normalization authority')
  const document:OutputMaterializationBodyV3={schemaVersion:'output-materialization/v3',canonicalPolicyVersion:policy,
    id:input.id,workspaceId:input.workspaceId,projectId:input.projectId,resultVersionId:input.resultVersionId,
    variantId:spec.variantId,outputSpecRevisionId:spec.id,specHash:calculateOutputCanonicalHash(spec),
    planSnapshotId:input.planSnapshotId,planHash:input.planHash,fps:p.fps,durationFrames:p.durationFrames,
    videoTracks:tracks,clips,audioTracks:p.audioTracks,music,overlayTracks:p.overlayTracks,subtitleTracks:p.subtitleTracks,
    composition:p.composition??null,normalizations:receipts,
    emission:{subtitles:'suppressed-missing-visual-clock-authority',cta:'suppressed-missing-visual-clock-authority'},
    createdAt:input.createdAt}
  return Object.freeze({document:json(document),materializationHash:calculateOutputCanonicalHash(document)})
}
