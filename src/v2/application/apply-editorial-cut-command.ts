import { planMovementPolicyUnder, requestlessEditorialPolicies } from '../domain/editorial-policy-resolution.ts'
import { assertDomain, DomainError } from '../domain/errors.ts'
import {
  createEditCommand,
  type EditCommand,
} from '../domain/edit-command.ts'
import { createMediaTranscript, type MediaTranscript, type TranscriptWord } from '../domain/media-transcript.ts'
import type { DirectedSubtitleCue } from '../domain/director-run.ts'
import { createProjectSnapshot } from '../domain/project-snapshot.ts'
import { createEditorialSourceBindingV1 } from '../domain/output-materialization.ts'
import { materializeEditorialCutPlanV3, createEditorialAudioProjectionV1, createEditorialCutImpactV2, type EditorialCutPayloadV3 } from '../domain/editorial-cut-impact.ts'
import { buildOperationalOutputVersionBundleV3, forkAuthorityPendingV3, operationalBundlePlanV3 } from '../domain/output-version-bundle.ts'
import { createPublicEvent } from '../domain/public-event.ts'
import type {
  EditorialCommandRepository,
  EditorialCommandResult,
} from './ports/editorial-command-repository.ts'
import {
  buildRetainedSourceRanges,
  defineEditorialPhraseRules,
  deriveEditorialExclusions,
  deriveEditorialPhraseMatches,
  type EditorialExclusionRange,
  type SourceTimeRange,
} from './editorial-phrase-rules.ts'
import { calculateVersionHash, stableSerialize } from './version-hash.ts'
import type { ManualCropRegion } from '../domain/manual-editing.ts'
import type { EditorialCutImpactV1 } from '../domain/editorial-cut-impact.ts'
import {
  materializeActorAuditContext,
  requireScope,
  type AuthenticatedExternalActor,
} from './authenticate-api-client.ts'

export interface RemoveSpokenContentRuleInput {
  id: string
  label: string
  alternatives: readonly string[]
}

export interface RemoveSpokenContentPayload {
  schemaVersion: 2
  sourceTranscriptId: string
  sourceArtifactId: string
  rules: readonly Readonly<RemoveSpokenContentRuleInput>[]
  exclusions: readonly Readonly<EditorialExclusionRange>[]
  exclusionOverrides?: readonly Readonly<EditorialExclusionOverrideInput>[]
  impact: Readonly<EditorialCutImpactV1>
}

export interface EditorialExclusionOverrideInput extends SourceTimeRange {
  ruleIds: readonly string[]
  reason: string
}

export interface EditorialCutClip {
  id: string
  sourceArtifactId: string
  /** Optional stable camera identity used by target-scoped ColorPlan overrides. */
  cameraId?: string
  audioSourceArtifactId?: string
  audioSourceInFrame?: number
  audioSourceOutFrame?: number
  sourceInFrame: number
  sourceOutFrame: number
  timelineInFrame: number
  timelineOutFrame: number
  /**
   * Playback speed multiplier applied to the source span. `1` is real time,
   * `2` plays twice as fast, `0.5` half speed. Renderers accept `[0.25, 4]`;
   * reverse playback (`rate <= 0`) is not supported.
   */
  rate: number
  crop?: Readonly<ManualCropRegion>
}

export interface RetimedTranscriptWord {
  text: string
  sourceStartSeconds: number
  sourceEndSeconds: number
  timelineStartFrame: number
  timelineEndFrame: number
}

/** Alignment content only. This intent never configures output subtitles or
 * claims a rendered clock, face-safe anchor, Director approval or ASR execution. */
export interface SourceTranscriptCueIntent {
  schemaVersion: 'source-transcript-cue-intent/v1'
  kind: 'alignment-only'
  emission: 'suppressed-missing-visual-clock-authority'
  trackId: string
  cueIdPrefix: string
}
export interface AlignedSourceSubtitleCue extends Pick<DirectedSubtitleCue, 'id' | 'startFrame' | 'endFrame' | 'text'> {
  clipId: string
  sourceSegmentId: number
  sourceWordIndices: readonly number[]
}
export interface AlignedSourceSubtitleTrack {
  schemaVersion: 'source-transcript-cue-track/v1'
  id: string
  kind: 'captions'
  authority: 'aligned-source-transcript-only'
  emission: 'suppressed-missing-visual-clock-authority'
  sourceTranscriptId: string
  sourceTranscriptHash: string
  cues: readonly Readonly<AlignedSourceSubtitleCue>[]
}
export type SourceTranscriptCueUnavailableReason = 'word-alignment-unavailable' | 'segment-alignment-unavailable' |
  'timeline-clock-unsupported' | 'source-coverage-unavailable' | 'segment-partition-unsupported' |
  'segment-identity-unsupported' | 'word-frame-coverage-unavailable'
export type SourceTranscriptCueProjection = Readonly<{
  schemaVersion: 'source-transcript-cue-projection/v1'
  capability: 'aligned-source-word-cues'
  sourceTranscriptId: string
  sourceTranscriptHash: string
  emission: 'suppressed-missing-visual-clock-authority'
} & (
  {status:'available';cueCount:number} |
  {status:'unavailable';reasons:readonly SourceTranscriptCueUnavailableReason[]}
)>

export interface EditorialCutEditPlan {
  schemaVersion: 2
  state: 'compiled'
  id: string
  projectVersionId: string
  storyPlanId: null
  fps: number
  durationFrames: number
  sources: readonly Readonly<{
    id: string
    artifactId: string
    kind: 'video'
    durationSeconds: number
  }>[]
  videoTracks: readonly Readonly<{
    id: string
    kind: 'base-video'
    clips: readonly Readonly<EditorialCutClip>[]
  }>[]
  overlayTracks: readonly never[]
  subtitleTracks: readonly Readonly<AlignedSourceSubtitleTrack>[]
  sourceTranscriptCueProjection?: SourceTranscriptCueProjection
  audioTracks: readonly never[]
  effectTracks: readonly never[]
  markers: readonly Readonly<{
    kind: 'editorial-cut'
    atFrame: number
    sourceStartSeconds: number
    sourceEndSeconds: number
    ruleIds: readonly string[]
  }>[]
  protectedElements: readonly never[]
  localeVariantRefs: readonly never[]
  formatVariantRefs: readonly never[]
  lineageRefs: readonly string[]
  editorial: Readonly<{
    commandType: 'remove-spoken-content' | 'source-ingest'
    exclusions: readonly Readonly<EditorialExclusionRange>[]
    retainedSourceRanges: readonly Readonly<SourceTimeRange>[]
  }>
  retimedTranscript: Readonly<{
    sourceTranscriptId: string
    sourceTranscriptHash?: string
    words: readonly Readonly<RetimedTranscriptWord>[]
  }>
  movementPolicy: Readonly<{
    automaticZoom: boolean
    protectedOpeningFrames: number
  }>
  subtitlePolicy: Readonly<{
    faceProtection: true
    anchor: 'bottom'
  }>
  createdAt: string
}

export interface ApplyEditorialCutCommandRequest {
  variantId: string
  workspaceId: string
  projectId: string
  baseVersionId: string
  baseHash: string
  sourceTranscriptId: string
  rules: readonly Readonly<RemoveSpokenContentRuleInput>[]
  exclusionOverrides?: readonly Readonly<EditorialExclusionOverrideInput>[]
  reason?: string
  actor: Readonly<AuthenticatedExternalActor>
  idempotency: Readonly<{ clientId: string; key: string }>
}

function normalizeExclusionOverrides(input: {
  overrides: readonly Readonly<EditorialExclusionOverrideInput>[]
  rules: readonly ReturnType<typeof defineEditorialPhraseRules>[number][]
  transcript: Readonly<MediaTranscript>
  sourceDurationSeconds: number
}): readonly Readonly<EditorialExclusionRange>[] {
  assertDomain(input.overrides.length > 0 && input.overrides.length <= 32, 'INVALID_ARGUMENT', 'exclusionOverrides must contain 1 to 32 entries')
  const ruleById = new Map(input.rules.map((rule) => [rule.id, rule]))
  const matches = deriveEditorialPhraseMatches(input.transcript, input.rules)
  const normalized = [...input.overrides].map((override) => {
    const reason = override.reason.trim()
    const ruleIds = [...new Set(override.ruleIds.map((id) => id.trim()))]
    assertDomain(
      Number.isFinite(override.sourceStartSeconds) && Number.isFinite(override.sourceEndSeconds) &&
        override.sourceStartSeconds >= 0 && override.sourceEndSeconds > override.sourceStartSeconds &&
        override.sourceEndSeconds <= input.sourceDurationSeconds,
      'INVALID_ARGUMENT',
      'Editorial exclusion override must be inside the source duration',
    )
    assertDomain(reason.length > 0 && reason.length <= 500, 'INVALID_ARGUMENT', 'Editorial exclusion override reason is invalid')
    assertDomain(ruleIds.length > 0 && ruleIds.every((id) => ruleById.has(id)), 'INVALID_ARGUMENT', 'Editorial exclusion override ruleIds are invalid')
    const covered = matches.filter((match) =>
      match.ruleIds.some((id) => ruleIds.includes(id)) &&
      match.sourceStartSeconds >= override.sourceStartSeconds - 0.001 &&
      match.sourceEndSeconds <= override.sourceEndSeconds + 0.001,
    )
    assertDomain(covered.length > 0, 'INVALID_ARGUMENT', 'Editorial exclusion override must cover detected speech')
    return Object.freeze({
      sourceStartSeconds: override.sourceStartSeconds,
      sourceEndSeconds: override.sourceEndSeconds,
      ruleIds: Object.freeze(ruleIds),
      labels: Object.freeze(ruleIds.map((id) => ruleById.get(id)!.label)),
      matchedText: covered.map((match) => match.matchedText).join(' | '),
    })
  }).sort((left, right) => left.sourceStartSeconds - right.sourceStartSeconds)
  for (let index = 1; index < normalized.length; index += 1) {
    assertDomain(normalized[index]!.sourceStartSeconds >= normalized[index - 1]!.sourceEndSeconds, 'INVALID_ARGUMENT', 'Editorial exclusion overrides must be disjoint')
  }
  const uncovered = matches.filter((match) => !normalized.some((override) =>
    match.ruleIds.some((id) => override.ruleIds.includes(id)) &&
    match.sourceStartSeconds >= override.sourceStartSeconds - 0.001 &&
    match.sourceEndSeconds <= override.sourceEndSeconds + 0.001,
  ))
  assertDomain(uncovered.length === 0, 'INVALID_ARGUMENT', 'Editorial exclusion overrides must cover every detected phrase')
  return Object.freeze(normalized)
}

export interface ApplyEditorialCutCommandDependencies {
  repository: EditorialCommandRepository
  clock: () => Date
  createId: (kind: 'edit-command' | 'project-version' | 'project-snapshot' | 'output-state' | 'output-materialization' | 'editorial-source-binding') => string
  createEventId: () => string
}

function frameAtOrAfter(seconds: number, fps: number): number {
  return Math.max(0, Math.ceil(seconds * fps - 1e-7))
}

function frameAtOrBefore(seconds: number, fps: number): number {
  return Math.floor(seconds * fps + 1e-7)
}

function compileClips(input: {
  ranges: readonly SourceTimeRange[]
  sourceArtifactId: string
  fps: number
}): { clips: readonly Readonly<EditorialCutClip>[]; durationFrames: number } {
  let timelineCursor = 0
  const clips = input.ranges.map((range, index) => {
    const sourceInFrame = frameAtOrAfter(range.sourceStartSeconds, input.fps)
    const sourceOutFrame = frameAtOrBefore(range.sourceEndSeconds, input.fps)
    assertDomain(sourceOutFrame > sourceInFrame, 'INVALID_COMMAND', 'Editorial cut produced an empty source clip')
    const duration = sourceOutFrame - sourceInFrame
    const clip = Object.freeze({
      id: `clip-${index + 1}`,
      sourceArtifactId: input.sourceArtifactId,
      sourceInFrame,
      sourceOutFrame,
      timelineInFrame: timelineCursor,
      timelineOutFrame: timelineCursor + duration,
      rate: 1 as const,
    })
    timelineCursor += duration
    return clip
  })
  return { clips: Object.freeze(clips), durationFrames: timelineCursor }
}

function timelineFrameAtSourceSecond(
  ranges: readonly SourceTimeRange[],
  sourceSecond: number,
  fps: number,
): number {
  let cursor = 0
  for (const range of ranges) {
    const rangeStartFrame = frameAtOrAfter(range.sourceStartSeconds, fps)
    const rangeEndFrame = frameAtOrBefore(range.sourceEndSeconds, fps)
    if (sourceSecond <= range.sourceStartSeconds) return cursor
    if (sourceSecond < range.sourceEndSeconds) {
      return cursor + Math.max(0, frameAtOrAfter(sourceSecond, fps) - rangeStartFrame)
    }
    cursor += rangeEndFrame - rangeStartFrame
  }
  return cursor
}

function rangeContainingWord(
  ranges: readonly SourceTimeRange[],
  word: Readonly<TranscriptWord>,
): SourceTimeRange | undefined {
  return ranges.find((range) =>
    word.start >= range.sourceStartSeconds - 0.001 && word.end <= range.sourceEndSeconds + 0.001,
  )
}

function retimeTranscriptWords(input: {
  transcript: Readonly<MediaTranscript>
  ranges: readonly SourceTimeRange[]
  fps: number
}): readonly Readonly<RetimedTranscriptWord>[] {
  let elapsedFrames = 0
  const offsets = new Map<SourceTimeRange, number>()
  for (const range of input.ranges) {
    offsets.set(range, elapsedFrames)
    elapsedFrames += frameAtOrBefore(range.sourceEndSeconds, input.fps) -
      frameAtOrAfter(range.sourceStartSeconds, input.fps)
  }
  return Object.freeze(input.transcript.words.flatMap((word) => {
    const range = rangeContainingWord(input.ranges, word)
    if (!range) return []
    const sourceRangeStartFrame = frameAtOrAfter(range.sourceStartSeconds, input.fps)
    const sourceRangeEndFrame = frameAtOrBefore(range.sourceEndSeconds, input.fps)
    const timelineOffset = offsets.get(range)!
    const timelineStartFrame = timelineOffset + Math.max(0, frameAtOrAfter(word.start, input.fps) - sourceRangeStartFrame)
    const timelineEndFrame = timelineOffset + Math.min(
      sourceRangeEndFrame - sourceRangeStartFrame,
      Math.max(timelineStartFrame - timelineOffset + 1, frameAtOrBefore(word.end, input.fps) - sourceRangeStartFrame),
    )
    return [Object.freeze({
      text: word.word,
      sourceStartSeconds: word.start,
      sourceEndSeconds: word.end,
      timelineStartFrame,
      timelineEndFrame: Math.max(timelineStartFrame + 1, timelineEndFrame),
    })]
  }))
}

function compileAlignedSourceSubtitleProjection(input: {
  intent: Readonly<SourceTranscriptCueIntent>
  transcriptId: string
  transcript: Readonly<MediaTranscript>
  words: readonly Readonly<RetimedTranscriptWord>[]
  clips: readonly Readonly<EditorialCutClip>[]
  sourceDurationSeconds: number
  durationFrames: number
  fps: number
}): Readonly<{projection:SourceTranscriptCueProjection;tracks:readonly Readonly<AlignedSourceSubtitleTrack>[]}> {
  const intent = input.intent, id = /^[A-Za-z0-9][A-Za-z0-9._:-]{2,127}$/
  assertDomain(intent !== null && typeof intent === 'object' && !Array.isArray(intent) &&
    (Object.getPrototypeOf(intent) === Object.prototype || Object.getPrototypeOf(intent) === null) &&
    Object.getOwnPropertySymbols(intent).length === 0 && Object.values(Object.getOwnPropertyDescriptors(intent))
      .every(descriptor => 'value' in descriptor && descriptor.enumerable) &&
    Object.keys(intent).sort().join('|') === ['schemaVersion','kind','emission','trackId','cueIdPrefix'].sort().join('|') &&
    intent.schemaVersion === 'source-transcript-cue-intent/v1' && intent.kind === 'alignment-only' &&
    intent.emission === 'suppressed-missing-visual-clock-authority' && typeof intent.trackId === 'string' && id.test(intent.trackId) &&
    typeof intent.cueIdPrefix === 'string' && id.test(intent.cueIdPrefix) && intent.cueIdPrefix.length <= 96 &&
    typeof input.transcriptId === 'string' && id.test(input.transcriptId),
  'INVALID_COMMAND', 'Initial transcript cue intent must be explicit non-emitting alignment')
  const {schemaVersion,transcriptHash,...body} = input.transcript
  const fresh = createMediaTranscript(body)
  assertDomain(schemaVersion === fresh.schemaVersion && transcriptHash === fresh.transcriptHash &&
    stableSerialize(fresh) === stableSerialize(input.transcript), 'INVALID_COMMAND', 'Initial cue transcript seal differs')
  const common = {schemaVersion:'source-transcript-cue-projection/v1' as const,capability:'aligned-source-word-cues' as const,
    sourceTranscriptId:input.transcriptId,sourceTranscriptHash:transcriptHash,emission:intent.emission}
  const unavailable = (reason:SourceTranscriptCueUnavailableReason) => Object.freeze({
    projection:Object.freeze({...common,status:'unavailable' as const,reasons:Object.freeze([reason])}),tracks:Object.freeze([]),
  })
  const segments = input.transcript.segments
  assertDomain(input.clips.length === 1 &&
    input.clips[0].timelineInFrame === 0 && input.clips[0].timelineOutFrame === input.durationFrames &&
    input.clips[0].rate === 1 && intent.trackId !== 'track-primary-video' &&
    intent.trackId !== input.transcriptId && !input.clips.some(clip => clip.id === intent.trackId || clip.sourceArtifactId === intent.trackId),
  'INVALID_COMMAND', 'Initial cue intent requires independent identities and the actual full-source clip')
  // The transcript contract permits segment-only/partial/overlapping alignment.
  // A valid transcript can lack this cue projection capability; its original
  // content/hash and full-source plan remain intact, with explicit suppression.
  if (input.transcript.words.length === 0) return unavailable('word-alignment-unavailable')
  if (segments.length === 0) return unavailable('segment-alignment-unavailable')
  if (!Number.isFinite(input.fps) || input.fps <= 0 ||
    !Number.isSafeInteger(input.durationFrames) || input.durationFrames <= 0) return unavailable('timeline-clock-unsupported')
  if (input.words.length !== input.transcript.words.length) return unavailable('source-coverage-unavailable')
  for (let index = 0; index < segments.length; index++) {
    const segment = segments[index]
    if (!Number.isSafeInteger(segment.id)) return unavailable('segment-identity-unsupported')
    if (segment.start < 0 || segment.end > input.sourceDurationSeconds) return unavailable('source-coverage-unavailable')
    if (segment.end === segment.start || index > 0 && segments[index - 1].end > segment.start)
      return unavailable('segment-partition-unsupported')
  }
  const clip = input.clips[0], groups: {id:string;startFrame:number;endFrame:number;clipId:string;
    sourceSegmentId:number;sourceWordIndices:number[];texts:string[]}[] = []
  let segmentIndex = 0, previousEndFrame = 0
  for (let index = 0; index < input.words.length; index++) {
    const word = input.words[index], sourceWord = input.transcript.words[index]
    while (segmentIndex + 1 < segments.length && sourceWord.start >= segments[segmentIndex].end) segmentIndex++
    const segment = segments[segmentIndex]
    assertDomain(word.text === sourceWord.word && word.sourceStartSeconds === sourceWord.start && word.sourceEndSeconds === sourceWord.end,
    'INVALID_COMMAND', 'Initial cue retimed transcript contradicts the sealed source words')
    if (sourceWord.start < segment.start || sourceWord.end > segment.end ||
      sourceWord.start < 0 || sourceWord.end > input.sourceDurationSeconds) return unavailable('source-coverage-unavailable')
    if (sourceWord.end === sourceWord.start || !Number.isSafeInteger(word.timelineStartFrame) || !Number.isSafeInteger(word.timelineEndFrame) || !(
      word.timelineStartFrame >= clip.timelineInFrame && word.timelineEndFrame > word.timelineStartFrame &&
      word.timelineEndFrame <= clip.timelineOutFrame)) return unavailable('word-frame-coverage-unavailable')
    const previous = groups[groups.length - 1]
    if (previous?.sourceSegmentId === segment.id) {
      const endFrame = Math.max(previous.endFrame, word.timelineEndFrame)
      previous.startFrame = Math.min(previous.startFrame, word.timelineStartFrame)
      previous.endFrame = endFrame
      previous.texts.push(word.text); previous.sourceWordIndices.push(index)
      previousEndFrame = endFrame
    } else {
      const cueId = intent.cueIdPrefix + '-' + segment.id
      assertDomain(id.test(cueId) && cueId !== intent.trackId && cueId !== clip.id,
        'INVALID_COMMAND', 'Initial cue identity differs from its explicit intent')
      if (word.timelineStartFrame < previousEndFrame) return unavailable('word-frame-coverage-unavailable')
      groups.push({id:cueId,startFrame:word.timelineStartFrame,endFrame:word.timelineEndFrame,
        texts:[word.text],clipId:clip.id,sourceSegmentId:segment.id,sourceWordIndices:[index]})
      previousEndFrame = word.timelineEndFrame
    }
  }
  const cues = groups.map(({texts,sourceWordIndices,...cue}) => Object.freeze({...cue,
    text:texts.join(' '),sourceWordIndices:Object.freeze(sourceWordIndices)}))
  const track:Readonly<AlignedSourceSubtitleTrack> = Object.freeze({schemaVersion:'source-transcript-cue-track/v1',id:intent.trackId,kind:'captions',
    authority:'aligned-source-transcript-only',emission:intent.emission,sourceTranscriptId:input.transcriptId,
    sourceTranscriptHash:input.transcript.transcriptHash,cues:Object.freeze(cues)})
  return Object.freeze({projection:Object.freeze({...common,status:'available' as const,cueCount:cues.length}),
    tracks:Object.freeze([track])})
}

function compileEditPlan(input: {
  id: string
  projectVersionId: string
  transcriptId: string
  transcript: Readonly<MediaTranscript>
  sourceArtifactId: string
  sourceDurationSeconds: number
  fps: number
  exclusions: readonly EditorialExclusionRange[]
  retainedSourceRanges: readonly SourceTimeRange[]
  createdAt: string
  commandType?: 'remove-spoken-content' | 'source-ingest'
  sourceTranscriptCueIntent?: Readonly<SourceTranscriptCueIntent>
}): Readonly<EditorialCutEditPlan> {
  const { clips, durationFrames } = compileClips({
    ranges: input.retainedSourceRanges,
    sourceArtifactId: input.sourceArtifactId,
    fps: input.fps,
  })
  const markers = input.exclusions.map((exclusion) => ({
    kind: 'editorial-cut' as const,
    atFrame: timelineFrameAtSourceSecond(
      input.retainedSourceRanges,
      exclusion.sourceStartSeconds,
      input.fps,
    ),
    sourceStartSeconds: exclusion.sourceStartSeconds,
    sourceEndSeconds: exclusion.sourceEndSeconds,
    ruleIds: Object.freeze([...exclusion.ruleIds]),
  }))
  const retimedWords = retimeTranscriptWords({transcript:input.transcript,ranges:input.retainedSourceRanges,fps:input.fps})
  const cueProjection = input.sourceTranscriptCueIntent === undefined ? null :
    compileAlignedSourceSubtitleProjection({intent:input.sourceTranscriptCueIntent,transcriptId:input.transcriptId,
      transcript:input.transcript,words:retimedWords,clips,sourceDurationSeconds:input.sourceDurationSeconds,durationFrames,fps:input.fps})
  return Object.freeze({
    schemaVersion: 2 as const,
    state: 'compiled' as const,
    id: input.id,
    projectVersionId: input.projectVersionId,
    storyPlanId: null,
    fps: input.fps,
    durationFrames,
    sources: Object.freeze([Object.freeze({
      id: input.sourceArtifactId,
      artifactId: input.sourceArtifactId,
      kind: 'video' as const,
      durationSeconds: input.sourceDurationSeconds,
    })]),
    videoTracks: Object.freeze([Object.freeze({
      id: 'track-primary-video',
      kind: 'base-video' as const,
      clips,
    })]),
    overlayTracks: Object.freeze([]),
    subtitleTracks: cueProjection?.tracks ?? Object.freeze([]),
    ...(cueProjection ? {sourceTranscriptCueProjection:cueProjection.projection} : {}),
    audioTracks: Object.freeze([]),
    effectTracks: Object.freeze([]),
    markers: Object.freeze(markers.map((marker) => Object.freeze(marker))),
    protectedElements: Object.freeze([]),
    localeVariantRefs: Object.freeze([]),
    formatVariantRefs: Object.freeze([]),
    lineageRefs: Object.freeze([input.sourceArtifactId, input.transcriptId]),
    editorial: Object.freeze({
      commandType: input.commandType ?? 'remove-spoken-content',
      exclusions: input.exclusions,
      retainedSourceRanges: input.retainedSourceRanges,
    }),
    retimedTranscript: Object.freeze({
      sourceTranscriptId: input.transcriptId,
      sourceTranscriptHash: input.transcript.transcriptHash,
      words: retimedWords,
    }),
    // A cut of the source is made without an editorial request of its own: its movement is that of a silent request, resolved like any other.
    movementPolicy: planMovementPolicyUnder(requestlessEditorialPolicies(), input.fps),
    subtitlePolicy: Object.freeze({ faceProtection: true as const, anchor: 'bottom' as const }),
    createdAt: input.createdAt,
  })
}

export function compileInitialSourceEditPlan(input: {
  id: string
  projectVersionId: string
  transcriptId: string
  transcript: Readonly<MediaTranscript>
  sourceArtifactId: string
  sourceDurationSeconds: number
  fps: number
  createdAt: string
  sourceTranscriptCueIntent?: Readonly<SourceTranscriptCueIntent>
}): Readonly<EditorialCutEditPlan> {
  assertDomain(
    Number.isFinite(input.sourceDurationSeconds) && input.sourceDurationSeconds > 0,
    'INVALID_COMMAND',
    'Initial source duration is invalid',
  )
  return compileEditPlan({
    ...input,
    exclusions: Object.freeze([]),
    retainedSourceRanges: Object.freeze([Object.freeze({
      sourceStartSeconds: 0,
      sourceEndSeconds: input.sourceDurationSeconds,
    })]),
    commandType: 'source-ingest',
  })
}

export function applyEditorialCutCommandService(dependencies: ApplyEditorialCutCommandDependencies) {
  return async function execute(request: ApplyEditorialCutCommandRequest): Promise<EditorialCommandResult> {
    const workspaceId = request.workspaceId.trim()
    const projectId = request.projectId.trim()
    const baseVersionId = request.baseVersionId.trim()
    const sourceTranscriptId = request.sourceTranscriptId.trim()
    const variantId = request.variantId?.trim()
    assertDomain(typeof variantId==='string'&&variantId.length>=3,'INVALID_COMMAND','Editorial Command requires an explicit stable variant identity')
    const idempotencyKey = request.idempotency.key.trim()
    assertDomain(workspaceId.length >= 3 && projectId.length >= 3, 'INVALID_COMMAND', 'Editorial command scope is invalid')
    assertDomain(baseVersionId.length >= 3 && /^[a-f0-9]{64}$/.test(request.baseHash), 'INVALID_COMMAND', 'Editorial command base version is invalid')
    assertDomain(sourceTranscriptId.length >= 3, 'INVALID_COMMAND', 'Editorial command transcript is required')
    assertDomain(idempotencyKey.length > 0 && idempotencyKey.length <= 128, 'INVALID_COMMAND', 'Editorial command idempotency key is invalid')
    requireScope(request.actor, 'projects:write')
    const authenticationAudit = materializeActorAuditContext(request.actor)
    assertDomain(
      authenticationAudit.workspaceId === workspaceId &&
        request.idempotency.clientId === authenticationAudit.clientId,
      'AUTH_INVALID',
      'Editorial command actor does not match its workspace or idempotency client',
    )
    const rules = defineEditorialPhraseRules(request.rules)
    const normalizedRules = rules.map((rule) => ({
      id: rule.id,
      label: rule.label,
      alternatives: rule.alternatives.map((tokens) => tokens.join(' ')),
    }))
    const requestFingerprint = calculateVersionHash({
      type: 'remove-spoken-content',
      workspaceId,
      projectId,
      baseVersionId,
      baseHash: request.baseHash,
      sourceTranscriptId,
      variantId,
      rules: normalizedRules,
      exclusionOverrides: request.exclusionOverrides ?? null,
      reason: request.reason?.trim() || null,
      actorContextHash: authenticationAudit.contextHash,
    })
    const existing = await dependencies.repository.findIdempotentResult({
      workspaceId,
      projectId,
      idempotencyKey,
      actorContextHash: authenticationAudit.contextHash,
    })
    if (existing) {
      if (existing.requestFingerprint !== requestFingerprint) {
        throw new DomainError('IDEMPOTENCY_PAYLOAD_MISMATCH', 'Idempotency key was already used with a different editorial command')
      }
      return Object.freeze({ ...existing.result, replayed: true })
    }
    const context = await dependencies.repository.readContext({ workspaceId, projectId, transcriptId: sourceTranscriptId, variantId })
    if (!context) throw new DomainError('PROJECT_NOT_FOUND', 'Project or aligned transcript was not found')
    if (context.currentVersion.id !== baseVersionId || context.currentVersion.baseHash !== request.baseHash) {
      throw new DomainError('VERSION_CONFLICT', 'Editorial command base version is stale', {
        currentVersionId: context.currentVersion.id,
        currentBaseHash: context.currentVersion.baseHash,
      })
    }
    const exclusions = request.exclusionOverrides
      ? normalizeExclusionOverrides({
          overrides: request.exclusionOverrides,
          rules,
          transcript: context.transcript,
          sourceDurationSeconds: context.sourceDurationSeconds,
        })
      : deriveEditorialExclusions(context.transcript, rules)
    const matchedRuleIds = new Set(exclusions.flatMap((range) => range.ruleIds))
    const missingRuleIds = rules.map((rule) => rule.id).filter((ruleId) => !matchedRuleIds.has(ruleId))
    if (missingRuleIds.length > 0) {
      throw new DomainError('INVALID_COMMAND', 'One or more spoken-content rules were not found in the aligned transcript', { missingRuleIds })
    }
    const retainedSourceRanges = buildRetainedSourceRanges(context.sourceDurationSeconds, exclusions)
    assertDomain(retainedSourceRanges.length > 0, 'INVALID_COMMAND', 'Editorial command would remove the entire source')
    const createdAt = dependencies.clock().toISOString()
    const commandId = dependencies.createId('edit-command')
    const versionId = dependencies.createId('project-version')
    const snapshotId = dependencies.createId('project-snapshot')
    const stateId=dependencies.createId('output-state')
    const sourceBinding=createEditorialSourceBindingV1({...context.sourceBindingFacts,
      id:dependencies.createId('editorial-source-binding'),parentVersionId:context.currentVersion.id,
      parentStateId:context.parent.state.document.id,parentStateHash:context.parent.state.stateHash,resultVersionId:versionId,createdAt})
    const editPlan=materializeEditorialCutPlanV3({before:JSON.parse(operationalBundlePlanV3(context.parent).contentJson),
      versionId,planId:'edit-plan-'+versionId,commandId,createdAt,sourceBinding,exclusions,
      adoptsAppliedCut:forkAuthorityPendingV3(context.parent)})
    const editPlanJson = stableSerialize(editPlan)
    const editPlanHash = calculateVersionHash(editPlan)
    const impact = createEditorialCutImpactV2({
      commandId,
      baseVersionId,
      resultVersionId: versionId,
      sourceTranscriptId: context.transcriptId,
      sourceTranscriptHash: context.transcript.transcriptHash,
      affectedEndFrame: Math.max(context.currentDurationFrames, editPlan.durationFrames),
      renderEndFrame: editPlan.durationFrames,
      proxyVariantId: variantId,
      variantIds:context.parent.state.document.entries.map(e=>e.variantId),
      outputReferences: context.outputReferences,
    })
    const command = createEditCommand<EditorialCutPayloadV3>({
      id: commandId,
      workspaceId,
      projectId,
      baseVersionId,
      baseHash: request.baseHash,
      author: {
        type: 'api-client',
        id: authenticationAudit.clientId,
        ...(authenticationAudit.delegatedUserId
          ? { delegatedUserId: authenticationAudit.delegatedUserId }
          : {}),
      },
      type: 'remove-spoken-content',
      scope: { project: true },
      payload: Object.freeze({
        schemaVersion: 3,
        sourceTranscriptId: context.transcriptId,
        variantId,sourceBinding,editPlanHash,audioProjection:createEditorialAudioProjectionV1(editPlan),
        sourceArtifactId: context.sourceArtifactId,
        rules: Object.freeze(normalizedRules.map((rule) => Object.freeze(rule))),
        exclusions,
        ...(request.exclusionOverrides ? { exclusionOverrides: Object.freeze(request.exclusionOverrides.map((override) => Object.freeze({ ...override, ruleIds: Object.freeze([...override.ruleIds]) }))) } : {}),
        impact,
      }),
      ...(request.reason?.trim() ? { reason: request.reason.trim() } : {}),
      idempotencyKey,
      createdAt,
    })
    const snapshot = createProjectSnapshot({
      id: snapshotId,
      workspaceId,
      projectId,
      kind: 'edit-plan',
      contentSchemaVersion: 2,
      contentJson: editPlanJson,
      contentHash: editPlanHash,
      createdAt,
    })
    const proposal={allocation:{workspaceId,projectId,resultVersionId:versionId,stateId,parentVersionId:context.currentVersion.id,
      sequence:context.currentVersion.sequence+1,createdBy:authenticationAudit.clientId,createdAt},parent:context.parent,
      origin:{kind:'editorial-cut-command' as const,command,audit:authenticationAudit,requestFingerprint},restoreTarget:null,
      ...(context.forkRoot?{forkRoot:context.forkRoot}:{}),
      editPlanSnapshot:snapshot,normalizations:context.normalizations,
      materializationIds:Object.fromEntries(context.parent.state.document.entries.map(e=>[e.variantId,dependencies.createId('output-materialization')]))}
    const outputBundle=buildOperationalOutputVersionBundleV3(proposal),version=outputBundle.version
    const event = createPublicEvent({
      id: dependencies.createEventId(),
      type: 'project.version.created',
      version: '1.0.0',
      workspaceId,
      occurredAt: createdAt,
      sequence: version.sequence,
      actor: {
        clientId: authenticationAudit.clientId,
        ...(authenticationAudit.delegatedUserId
          ? { userId: authenticationAudit.delegatedUserId }
          : {}),
      },
      resource: { type: 'project-version', id: version.id },
      data: {
        projectId,
        sequence: version.sequence,
        parentVersionId: version.parentVersionId,
        baseHash: version.baseHash,
        commandId,
        commandType: command.type,
        commandImpactHash: impact.impactHash,
        invalidatedArtifactCount: impact.affectedArtifacts.length,
        snapshotRefs: version.snapshotRefs,
        createdAt,
      },
    })
    return dependencies.repository.commitOrReplay({
      proposal,
      command,
      authenticationAudit,
      requestFingerprint,
      snapshot,
      version,
      event,
      sourceEvidence: {
        transcriptId: context.transcriptId,
        transcriptHash: context.transcript.transcriptHash,
        sourceArtifactId: context.sourceArtifactId,
      },
    })
  }
}
