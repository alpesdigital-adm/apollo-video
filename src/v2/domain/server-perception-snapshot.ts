import { calculateCanonicalHash, stableSerialize } from './canonical-hash.ts'
import { DomainError } from './errors.ts'
import {
  collectFaceSourceEvidenceStream,
  type FaceSourceEvidenceSample,
} from './face-source-evidence-stream.ts'
import type { FaceProducerEnvelopeV3 } from './face-producer-envelope-v3.ts'
import {
  frameRangesToCoverageMs, frameSpanToMs, perceptionDurationMs, type FrameRange,
} from './perception-frame-time.ts'
import {
  createPerceptionProducerEnvelope, type PerceptionProducerEnvelope, type PerceptionProducerEnvelopeInput,
} from './perception-producer-envelope.ts'
import {
  coverageState, coveredMs, createPerceptionTimeline, mergeRanges, PERCEPTION_KINDS,
  type PerceptionConfidenceBasis, type PerceptionCoverage, type PerceptionKind, type PerceptionObservation,
  type PerceptionRange, type PerceptionTimeline,
} from './perception-timeline.ts'
import { projectOcrEnvelope } from './projected-ocr-timeline.ts'
import {
  createTemporalProducerEnvelope, type TemporalProducerEnvelope, type TemporalProducerEnvelopeInput,
} from './temporal-producer-envelope.ts'

/**
 * W63a. The server-owned, canonical perception snapshot of ONE ProjectVersion.
 *
 * It fuses only what the server itself sealed - the version's retimed transcript, OCR samples, adjacent-frame temporal
 * measurements and source-keyed face windows - onto the EditPlan's own clock, and it says, per kind, how much of the version
 * was actually examined:
 *
 * - `complete` only when every frame of the version was examined by that kind's producer;
 * - `partial` lists exactly the examined ranges (the rest is NOT examined, never interpolated);
 * - `absent` carries a reason code. A kind never becomes `complete` because another kind has coverage.
 *
 * `object` is always `absent` (`NO_VERIFIED_DETECTOR`): no verified detector exists, and no fixture fills it. `speaker`, `silence`
 * and `image-insert` are `absent` with their own reason until a producer bound to a ProjectVersion exists. A caller's manual
 * timeline (`PUT /perception`, `manual/controlled`) is a different thing and is never part of a snapshot.
 *
 * The snapshot is content-addressed: the same sealed inputs give the same bytes and the same hash, whatever order they arrive in.
 */
export const SERVER_PERCEPTION_SNAPSHOT_SCHEMA = 'server-perception-snapshot/v1' as const
export const SERVER_PERCEPTION_MAX_OBSERVATIONS = 100_000

export const PERCEPTION_REASON = Object.freeze({
  noVerifiedDetector: 'NO_VERIFIED_DETECTOR',
  noProducerRun: 'NO_PRODUCER_RUN',
  diarizationUnavailable: 'DIARIZATION_UNAVAILABLE',
  silenceProducerUnavailable: 'SILENCE_PRODUCER_UNAVAILABLE',
  insertGeometryNotCompiled: 'INSERT_GEOMETRY_NOT_COMPILED',
  noTranscriptWords: 'NO_TRANSCRIPT_WORDS',
  noSamplesObserved: 'NO_SAMPLES_OBSERVED',
  timelineFpsNotInteger: 'TIMELINE_FPS_NOT_INTEGER',
  noUnitRateClip: 'NO_UNIT_RATE_CLIP',
  sourceTimelineLengthMismatch: 'SOURCE_TIMELINE_LENGTH_MISMATCH',
  faceWindowLimitExceeded: 'FACE_WINDOW_LIMIT_EXCEEDED',
  sampledFramesOnly: 'SAMPLED_FRAMES_ONLY',
  adjacentPairWindowOnly: 'ADJACENT_PAIR_WINDOW_ONLY',
  recognizedWordSpansOnly: 'RECOGNIZED_WORD_SPANS_ONLY',
} as const)

export const PERCEPTION_REJECTION = Object.freeze({
  sealInvalid: 'ENVELOPE_SEAL_INVALID',
  authorityInvalid: 'ENVELOPE_AUTHORITY_INVALID',
  scopeMismatch: 'SCOPE_MISMATCH',
  staleVersion: 'STALE_VERSION',
  editPlanMismatch: 'EDIT_PLAN_MISMATCH',
  sourceMismatch: 'SOURCE_MISMATCH',
  timeMapMismatch: 'TIME_MAP_MISMATCH',
  clockMismatch: 'CLOCK_MISMATCH',
  durationMismatch: 'DURATION_MISMATCH',
  sourceNotInTimeline: 'SOURCE_NOT_IN_TIMELINE',
  duplicateEnvelope: 'DUPLICATE_ENVELOPE',
  timelineFpsNotInteger: 'TIMELINE_FPS_NOT_INTEGER',
  wordOutsideTimeline: 'WORD_OUTSIDE_TIMELINE',
  wordSpanInvalid: 'WORD_SPAN_INVALID',
} as const)

export type PerceptionSnapshotClip = Readonly<{
  id: string
  sourceArtifactId: string
  sourceInFrame: number; sourceOutFrame: number
  timelineInFrame: number; timelineOutFrame: number
  rate: number
}>
export type PerceptionSnapshotWord = Readonly<{
  text: string
  sourceStartSeconds: number; sourceEndSeconds: number
  timelineStartFrame: number; timelineEndFrame: number
}>
export type PerceptionSnapshotTranscript = Readonly<{
  id: string; provider: string; model: string; transcriptHash: string
  /** The source the transcript was made from; `null` when it cannot be established (the words are then bound to the plan alone). */
  sourceArtifactId: string | null
}>

export type ServerPerceptionAssemblyInput = Readonly<{
  workspaceId: string
  projectId: string
  projectVersionId: string
  editPlan: Readonly<{
    snapshotId: string
    /** Hash of the sealed EditPlan snapshot. `null` only when the caller could not verify it (never on the product's read path). */
    snapshotHash: string | null
    fps: number
    durationFrames: number
    clips: readonly PerceptionSnapshotClip[]
  }>
  /** Bytes hash of every source the clips play, as the database holds them; `sha256: null` when the caller could not establish it. */
  sources?: readonly Readonly<{ artifactId: string; sha256: string | null }>[]
  transcript?: Readonly<{ transcript: PerceptionSnapshotTranscript; words: readonly PerceptionSnapshotWord[] }>
  ocr?: readonly Readonly<PerceptionProducerEnvelope>[]
  temporal?: readonly Readonly<TemporalProducerEnvelope>[]
  faceWindows?: readonly Readonly<FaceProducerEnvelopeV3>[]
  /**
   * Sources whose face windows the caller refused to read because there are more than it will trust a partial list of. The snapshot
   * says so for that source, and takes no face evidence from it.
   */
  faceWindowRefusals?: readonly Readonly<{ sourceArtifactId: string; reasonCode: 'FACE_WINDOW_LIMIT_EXCEEDED' }>[]
}>

export type PerceptionSnapshotUnexamined = Readonly<{ startFrame: number; endFrame: number; reasonCode: string }>
export type PerceptionSnapshotInputRecord = Readonly<{
  kind: 'transcript' | 'ocr' | 'temporal' | 'face'
  producer: string
  schemaVersion: string
  envelopeId: string
  envelopeHash: string
  sourceArtifactId: string | null
  sourceSha256: string | null
  /** The producer's own clock, kept as measured: the snapshot never re-derives a frame rate or a PTS. */
  sourceClock: Readonly<{
    fps: Readonly<{ num: number; den: number }>
    timebase: Readonly<{ num: number; den: number }> | null
  }> | null
  /** Observations this input contributed. */
  observationCount: number
  /** Timeline frames the producer did not examine, with its reason, as it declared them (temporal gaps, face windows). */
  unexamined: readonly PerceptionSnapshotUnexamined[]
}>
/**
 * Something the snapshot refused to use, and why. `envelopeId`/`envelopeHash` name the evidence record it is about: an envelope, a
 * transcript, or - for a source whose windows were not read or whose clips could not be mapped - the source (id and bytes hash).
 * `subjects` names what inside that record was dropped (words, clips), when it is not the whole record.
 */
export type PerceptionSnapshotRejection = Readonly<{
  kind: 'ocr' | 'temporal' | 'face' | 'transcript'
  envelopeId: string
  envelopeHash: string
  reasonCodes: readonly string[]
  subjects?: readonly string[]
}>
/** A span of the timeline a kind could not examine for a structural reason (not merely because it was not sampled). */
export type PerceptionSnapshotUnexaminedSpan = Readonly<{ kind: PerceptionKind; startMs: number; endMs: number; reasonCode: string }>

export type ServerPerceptionSnapshot = Readonly<{
  schemaVersion: typeof SERVER_PERCEPTION_SNAPSHOT_SCHEMA
  authority: 'server-assembled'
  faceSafety: 'unknown'
  workspaceId: string
  projectId: string
  projectVersionId: string
  editPlan: Readonly<{ snapshotId: string; snapshotHash: string | null; fps: number; durationFrames: number }>
  timeBase: Readonly<{ unit: 'ms'; frameToMs: 'round-nearest'; fps: number; durationFrames: number; durationMs: number }>
  sources: readonly Readonly<{ artifactId: string; sha256: string | null }>[]
  inputs: readonly PerceptionSnapshotInputRecord[]
  rejected: readonly PerceptionSnapshotRejection[]
  /** Spans no sample could ever cover, with the reason (a clip played at another speed, windows not read): never interpolated. */
  unexaminedSpans: readonly PerceptionSnapshotUnexaminedSpan[]
  timeline: Readonly<PerceptionTimeline>
  snapshotHash: string
}>

const ID = /^[A-Za-z0-9][A-Za-z0-9._:-]{0,127}$/
const SHA = /^[a-f0-9]{64}$/

function invalid(message: string): never { throw new DomainError('INVALID_ARGUMENT', message) }
function identity(value: unknown, field: string): string {
  if (typeof value !== 'string' || !ID.test(value.trim())) invalid(`${field} is invalid`)
  return value.trim()
}
function tokenOf(value: string): string {
  const cleaned = value.trim().replace(/[^A-Za-z0-9._:/@-]/g, '-').replace(/^[^A-Za-z0-9]+/, '')
  return (cleaned || 'unknown').slice(0, 255)
}
const compareText = (left: string, right: string) => left < right ? -1 : left > right ? 1 : 0

export function serverPerceptionSnapshotId(snapshotHash: string): string {
  if (!SHA.test(snapshotHash)) invalid('Snapshot hash is invalid')
  return `perception-snapshot-${snapshotHash.slice(0, 40)}`
}

/** The source-to-timeline map of the clips that play `sourceArtifactId`, exactly as the producers seal it. */
export function editPlanSourceTimeMap(clips: readonly PerceptionSnapshotClip[], sourceArtifactId: string) {
  return clips.filter((clip) => clip.sourceArtifactId === sourceArtifactId)
    .toSorted((left, right) => left.timelineInFrame - right.timelineInFrame)
    .map((clip) => ({ clipId: clip.id, sourceInFrame: clip.sourceInFrame, sourceOutFrame: clip.sourceOutFrame,
      timelineInFrame: clip.timelineInFrame, timelineOutFrame: clip.timelineOutFrame, rate: clip.rate }))
}

function stripOcr(envelope: Readonly<PerceptionProducerEnvelope>): PerceptionProducerEnvelopeInput {
  const { schemaVersion, authority, faceSafety, timeMapHash, envelopeHash, ...input } = envelope
  void schemaVersion; void authority; void faceSafety; void timeMapHash; void envelopeHash
  return input as PerceptionProducerEnvelopeInput
}
function stripTemporal(envelope: Readonly<TemporalProducerEnvelope>): TemporalProducerEnvelopeInput {
  const { schemaVersion, authority, interpretation, faceSafety, timeMapHash, envelopeHash, shot, motion, ...input } = envelope
  void schemaVersion; void authority; void interpretation; void faceSafety; void timeMapHash; void envelopeHash; void shot; void motion
  return input as TemporalProducerEnvelopeInput
}

/** True when the envelope is exactly what its own content seals: rebuilt through the constructor, it serializes the same. */
export function ocrEnvelopeSealIntact(envelope: Readonly<PerceptionProducerEnvelope>): boolean {
  try {
    return createPerceptionProducerEnvelope(stripOcr(envelope)).envelopeHash === envelope.envelopeHash &&
      stableSerialize(createPerceptionProducerEnvelope(stripOcr(envelope))) === stableSerialize(envelope)
  } catch { return false }
}
export function temporalEnvelopeSealIntact(envelope: Readonly<TemporalProducerEnvelope>): boolean {
  try {
    const rebuilt = createTemporalProducerEnvelope(stripTemporal(envelope))
    return rebuilt.envelopeHash === envelope.envelopeHash && stableSerialize(rebuilt) === stableSerialize(envelope)
  } catch { return false }
}

type Accumulator = {
  observations: PerceptionObservation[]
  frameRanges: Map<PerceptionKind, FrameRange[]>
  msRanges: Map<PerceptionKind, PerceptionRange[]>
  absentReason: Map<PerceptionKind, string>
  partialReason: Map<PerceptionKind, string>
  inputs: PerceptionSnapshotInputRecord[]
  rejected: PerceptionSnapshotRejection[]
  spans: PerceptionSnapshotUnexaminedSpan[]
}

function addFrames(acc: Accumulator, kind: PerceptionKind, ranges: readonly FrameRange[]) {
  acc.frameRanges.set(kind, [...(acc.frameRanges.get(kind) ?? []), ...ranges])
}

type Bound = Readonly<{
  workspaceId: string; projectId: string; projectVersionId: string
  editPlanSnapshotId: string; editPlanSnapshotHash: string
  sourceArtifactId: string; sourceSha256: string
  timelineDurationFrames: number
  timeMap: readonly Readonly<{ clipId: string; sourceInFrame: number; sourceOutFrame: number
    timelineInFrame: number; timelineOutFrame: number; rate: number }>[]
  timelineFps: Readonly<{ num: number; den: number }>
  authority: string; faceSafety: string
}>

/** Why a producer envelope is not about THIS version, its EditPlan, its bytes and its clock. Empty means it is. */
function bindingReasons(envelope: Bound, input: ServerPerceptionAssemblyInput, knownSources: ReadonlyMap<string, string | null>): string[] {
  const reasons: string[] = []
  if (envelope.authority !== 'server-produced' || envelope.faceSafety !== 'unknown') reasons.push(PERCEPTION_REJECTION.authorityInvalid)
  if (envelope.workspaceId !== input.workspaceId || envelope.projectId !== input.projectId) reasons.push(PERCEPTION_REJECTION.scopeMismatch)
  if (envelope.projectVersionId !== input.projectVersionId) reasons.push(PERCEPTION_REJECTION.staleVersion)
  if (envelope.editPlanSnapshotId !== input.editPlan.snapshotId ||
      (input.editPlan.snapshotHash !== null && envelope.editPlanSnapshotHash !== input.editPlan.snapshotHash)) {
    reasons.push(PERCEPTION_REJECTION.editPlanMismatch)
  }
  if (!knownSources.has(envelope.sourceArtifactId)) reasons.push(PERCEPTION_REJECTION.sourceNotInTimeline)
  else {
    const sha = knownSources.get(envelope.sourceArtifactId)
    if (sha !== null && sha !== undefined && envelope.sourceSha256 !== sha) reasons.push(PERCEPTION_REJECTION.sourceMismatch)
  }
  if (stableSerialize(envelope.timeMap) !== stableSerialize(editPlanSourceTimeMap(input.editPlan.clips, envelope.sourceArtifactId))) {
    reasons.push(PERCEPTION_REJECTION.timeMapMismatch)
  }
  if (envelope.timelineDurationFrames !== input.editPlan.durationFrames) reasons.push(PERCEPTION_REJECTION.durationMismatch)
  if (Math.abs(envelope.timelineFps.num / envelope.timelineFps.den - input.editPlan.fps) > 1e-9) reasons.push(PERCEPTION_REJECTION.clockMismatch)
  return reasons
}

function reject(acc: Accumulator, kind: PerceptionSnapshotRejection['kind'], envelope: { id: string; envelopeHash: string }, reasonCodes: readonly string[],
  subjects?: readonly string[]) {
  acc.rejected.push(Object.freeze({ kind, envelopeId: envelope.id, envelopeHash: envelope.envelopeHash,
    reasonCodes: Object.freeze([...new Set(reasonCodes)].sort(compareText)),
    ...(subjects && subjects.length ? { subjects: Object.freeze([...subjects].sort(compareText)) } : {}) }))
}

function addSpan(acc: Accumulator, kind: PerceptionKind, span: FrameRange, reasonCode: string, input: ServerPerceptionAssemblyInput, durationMs: number) {
  const [startMs, endMs] = frameSpanToMs(span, input.editPlan.fps, input.editPlan.durationFrames, durationMs)
  acc.spans.push(Object.freeze({ kind, startMs, endMs, reasonCode }))
}

function serverProvenance(input: {
  source: string; model: string; version: string; confidence: number; producer: string
  envelopeId: string; envelopeHash: string; confidenceBasis: PerceptionConfidenceBasis
}) {
  return Object.freeze({ source: input.source, model: input.model, version: input.version, confidence: input.confidence,
    origin: 'server' as const, producer: input.producer, envelopeId: input.envelopeId,
    envelopeHash: input.envelopeHash, confidenceBasis: input.confidenceBasis })
}

function assembleTranscript(acc: Accumulator, input: ServerPerceptionAssemblyInput, durationMs: number, sha: string | null) {
  const transcript = input.transcript
  if (!transcript || transcript.words.length === 0) return
  const fps = input.editPlan.fps
  const durationFrames = input.editPlan.durationFrames
  const provenance = serverProvenance({
    source: transcript.transcript.id, model: tokenOf(`${transcript.transcript.provider}/${transcript.transcript.model}`),
    version: transcript.transcript.transcriptHash, confidence: 0.82, producer: tokenOf(transcript.transcript.provider),
    envelopeId: transcript.transcript.id, envelopeHash: transcript.transcript.transcriptHash, confidenceBasis: 'policy-prior',
  })
  // A word the plan does not place inside the timeline has no placement to report: it is dropped and named, never clamped onto an edge.
  const outside: string[] = [], invalidSpan: string[] = []
  const words: PerceptionObservation[] = []
  transcript.words.forEach((word, index) => {
    const id = `transcript-word-${index + 1}`
    const start = word.timelineStartFrame, end = word.timelineEndFrame
    if (!Number.isSafeInteger(start) || !Number.isSafeInteger(end) || end <= start) { invalidSpan.push(id); return }
    if (start < 0 || end > durationFrames) { outside.push(id); return }
    const startMs = Math.min(durationMs - 1, Math.round(start / fps * 1000))
    const endMs = Math.min(durationMs, Math.round(end / fps * 1000))
    words.push({
      id, kind: 'transcript-word', startMs, endMs: endMs <= startMs ? Math.min(durationMs, startMs + 1) : endMs,
      value: Object.freeze({ text: word.text, sourceStartSeconds: word.sourceStartSeconds, sourceEndSeconds: word.sourceEndSeconds }),
      provenance,
    })
  })
  const record = { id: transcript.transcript.id, envelopeHash: transcript.transcript.transcriptHash }
  if (outside.length) reject(acc, 'transcript', record, [PERCEPTION_REJECTION.wordOutsideTimeline], outside)
  if (invalidSpan.length) reject(acc, 'transcript', record, [PERCEPTION_REJECTION.wordSpanInvalid], invalidSpan)
  if (words.length === 0) {
    acc.absentReason.set('transcript-word', outside.length ? PERCEPTION_REJECTION.wordOutsideTimeline : PERCEPTION_REJECTION.wordSpanInvalid)
    return
  }
  acc.observations.push(...words)
  acc.msRanges.set('transcript-word', words.map((word) => [word.startMs, word.endMs] as const))
  acc.partialReason.set('transcript-word', PERCEPTION_REASON.recognizedWordSpansOnly)
  acc.inputs.push(Object.freeze({
    kind: 'transcript' as const, producer: provenance.producer, schemaVersion: 'retimed-transcript/v1',
    envelopeId: transcript.transcript.id, envelopeHash: transcript.transcript.transcriptHash,
    sourceArtifactId: transcript.transcript.sourceArtifactId, sourceSha256: sha, sourceClock: null,
    observationCount: words.length, unexamined: Object.freeze([]),
  }))
}

function assembleOcr(acc: Accumulator, input: ServerPerceptionAssemblyInput, knownSources: ReadonlyMap<string, string | null>) {
  const seen = new Set<string>()
  for (const envelope of input.ocr ?? []) {
    if (seen.has(envelope.envelopeHash)) { reject(acc, 'ocr', envelope, [PERCEPTION_REJECTION.duplicateEnvelope]); continue }
    seen.add(envelope.envelopeHash)
    const reasons = ocrEnvelopeSealIntact(envelope)
      ? [...(envelope.modality === 'ocr' ? [] : [PERCEPTION_REJECTION.authorityInvalid]),
          ...bindingReasons(envelope, input, knownSources),
          ...(envelope.sourceFps.num * envelope.timelineFps.den !== envelope.timelineFps.num * envelope.sourceFps.den
            ? [PERCEPTION_REJECTION.clockMismatch] : [])]
      : [PERCEPTION_REJECTION.sealInvalid]
    if (reasons.length) { reject(acc, 'ocr', envelope, reasons); continue }
    const projection = projectOcrEnvelope(envelope, input.editPlan.fps, input.editPlan.durationFrames)
    acc.observations.push(...projection.observations)
    addFrames(acc, 'ocr', envelope.samples.map((sample) => ({ startFrame: sample.timelineFrame, endFrame: sample.timelineFrame + 1 })))
    acc.partialReason.set('ocr', PERCEPTION_REASON.sampledFramesOnly)
    acc.inputs.push(Object.freeze({
      kind: 'ocr' as const, producer: 'tesseract', schemaVersion: envelope.schemaVersion,
      envelopeId: envelope.id, envelopeHash: envelope.envelopeHash,
      sourceArtifactId: envelope.sourceArtifactId, sourceSha256: envelope.sourceSha256,
      sourceClock: Object.freeze({ fps: envelope.sourceFps, timebase: envelope.sourceTimebase }),
      observationCount: projection.observations.length,
      unexamined: Object.freeze(envelope.gaps.map((gap) => Object.freeze({ startFrame: gap.startTimelineFrame,
        endFrame: gap.endTimelineFrame, reasonCode: gap.reasonCode }))),
    }))
  }
}

function assembleTemporal(acc: Accumulator, input: ServerPerceptionAssemblyInput, knownSources: ReadonlyMap<string, string | null>) {
  const fps = input.editPlan.fps
  const durationFrames = input.editPlan.durationFrames
  const durationMs = perceptionDurationMs(durationFrames, fps)
  const seen = new Set<string>()
  for (const envelope of input.temporal ?? []) {
    if (seen.has(envelope.envelopeHash)) { reject(acc, 'temporal', envelope, [PERCEPTION_REJECTION.duplicateEnvelope]); continue }
    seen.add(envelope.envelopeHash)
    const reasons = temporalEnvelopeSealIntact(envelope) ? bindingReasons(envelope, input, knownSources) : [PERCEPTION_REJECTION.sealInvalid]
    if (reasons.length) { reject(acc, 'temporal', envelope, reasons); continue }
    const hash12 = envelope.envelopeHash.slice(0, 12)
    const provenance = (basis: PerceptionConfidenceBasis) => serverProvenance({
      source: envelope.id, model: envelope.analysis.algorithmVersion, version: envelope.analysis.algorithmVersion, confidence: 1,
      producer: envelope.analysis.algorithmVersion, envelopeId: envelope.id, envelopeHash: envelope.envelopeHash, confidenceBasis: basis,
    })
    const span = (pair: { startTimelineFrame: number; endTimelineFrame: number }) => {
      const [startMs, endMs] = frameSpanToMs({ startFrame: pair.startTimelineFrame, endFrame: pair.endTimelineFrame }, fps, durationFrames, durationMs)
      return { startMs, endMs }
    }
    const pairBase = (pair: Readonly<{
      clipId: string; previousFrame: number; currentFrame: number; startSourcePts: number; endSourcePts: number
      startTimelineFrame: number; endTimelineFrame: number
    }>) => ({
      clipId: pair.clipId, previousFrame: pair.previousFrame, currentFrame: pair.currentFrame,
      startSourcePts: pair.startSourcePts, endSourcePts: pair.endSourcePts,
      startTimelineFrame: pair.startTimelineFrame, endTimelineFrame: pair.endTimelineFrame,
    })
    const shots = envelope.shot.observations.map((pair): PerceptionObservation => ({
      id: `shot-${hash12}-${pair.startTimelineFrame}`, kind: 'shot', ...span(pair),
      value: Object.freeze({ interpretation: 'raw-adjacent-frame-change-score', changeScore: pair.changeScore,
        previousGridSha256: pair.previousGridSha256, currentGridSha256: pair.currentGridSha256, ...pairBase(pair) }),
      provenance: provenance('deterministic-measurement'),
    }))
    const motions = envelope.motion.observations.map((pair): PerceptionObservation => ({
      id: `motion-${hash12}-${pair.startTimelineFrame}`, kind: 'motion', ...span(pair),
      value: Object.freeze({ interpretation: 'raw-global-translation-estimate', vectorPxPerSecond: pair.vectorPxPerSecond,
        residualMeanAbsoluteLuma: pair.residualMeanAbsoluteLuma, ambiguity: pair.ambiguity, ...pairBase(pair) }),
      provenance: provenance('deterministic-measurement'),
    }))
    acc.observations.push(...shots, ...motions)
    addFrames(acc, 'shot', envelope.shot.coverage.map((range) => ({ startFrame: range.startTimelineFrame, endFrame: range.endTimelineFrame })))
    addFrames(acc, 'motion', envelope.motion.coverage.map((range) => ({ startFrame: range.startTimelineFrame, endFrame: range.endTimelineFrame })))
    acc.partialReason.set('shot', PERCEPTION_REASON.adjacentPairWindowOnly)
    acc.partialReason.set('motion', PERCEPTION_REASON.adjacentPairWindowOnly)
    acc.inputs.push(Object.freeze({
      kind: 'temporal' as const, producer: envelope.analysis.algorithmVersion, schemaVersion: envelope.schemaVersion,
      envelopeId: envelope.id, envelopeHash: envelope.envelopeHash,
      sourceArtifactId: envelope.sourceArtifactId, sourceSha256: envelope.sourceSha256,
      sourceClock: Object.freeze({ fps: envelope.analysis.sourceFps, timebase: envelope.analysis.sourceTimebase }),
      observationCount: shots.length + motions.length,
      unexamined: Object.freeze([
        ...envelope.shot.gaps.map((gap) => Object.freeze({ startFrame: gap.startTimelineFrame, endFrame: gap.endTimelineFrame, reasonCode: `SHOT_${gap.reasonCode}` })),
        ...envelope.motion.gaps.map((gap) => Object.freeze({ startFrame: gap.startTimelineFrame, endFrame: gap.endTimelineFrame, reasonCode: `MOTION_${gap.reasonCode}` })),
      ]),
    }))
  }
}

function assembleFace(acc: Accumulator, input: ServerPerceptionAssemblyInput, knownSources: ReadonlyMap<string, string | null>, durationMs: number) {
  const refused = new Set((input.faceWindowRefusals ?? []).map((refusal) => refusal.sourceArtifactId))
  for (const sourceArtifactId of [...refused].sort(compareText)) {
    // The windows of this source were more than will be trusted as a partial list: none of them is used, and the clips say why.
    const clips = input.editPlan.clips.filter((clip) => clip.sourceArtifactId === sourceArtifactId)
    const sha = knownSources.get(sourceArtifactId)
    acc.rejected.push(Object.freeze({ kind: 'face' as const, envelopeId: sourceArtifactId,
      envelopeHash: sha ?? calculateCanonicalHash({ faceWindowSource: sourceArtifactId }),
      reasonCodes: Object.freeze([PERCEPTION_REASON.faceWindowLimitExceeded]) }))
    for (const clip of clips) {
      addSpan(acc, 'face', { startFrame: clip.timelineInFrame, endFrame: clip.timelineOutFrame }, PERCEPTION_REASON.faceWindowLimitExceeded, input, durationMs)
    }
    acc.absentReason.set('face', PERCEPTION_REASON.faceWindowLimitExceeded)
  }
  const windows = (input.faceWindows ?? []).filter((envelope) => !refused.has(envelope.sourceArtifactId))
  if (windows.length === 0) return
  const fps = input.editPlan.fps
  if (!Number.isInteger(fps)) {
    // A source frame is mapped onto the timeline by an integer frame offset, which needs the same integer frame rate.
    for (const envelope of windows) reject(acc, 'face', envelope, [PERCEPTION_REJECTION.timelineFpsNotInteger])
    acc.absentReason.set('face', PERCEPTION_REASON.timelineFpsNotInteger)
    addSpan(acc, 'face', { startFrame: 0, endFrame: input.editPlan.durationFrames }, PERCEPTION_REASON.timelineFpsNotInteger, input, durationMs)
    return
  }
  const bySource = new Map<string, FaceProducerEnvelopeV3[]>()
  for (const envelope of windows) {
    bySource.set(envelope.sourceArtifactId, [...(bySource.get(envelope.sourceArtifactId) ?? []), envelope as FaceProducerEnvelopeV3])
  }
  const frameClock = Object.freeze({ num: fps, den: 1 })
  const used = new Set<string>()
  let mappable = 0
  const unmappedReasons = new Set<string>()
  for (const sourceArtifactId of [...bySource.keys()].sort(compareText)) {
    const envelopes = bySource.get(sourceArtifactId)!
    const unique: FaceProducerEnvelopeV3[] = []
    for (const envelope of envelopes) {
      if (used.has(envelope.envelopeHash)) { reject(acc, 'face', envelope, [PERCEPTION_REJECTION.duplicateEnvelope]); continue }
      used.add(envelope.envelopeHash)
      unique.push(envelope)
    }
    const clips = input.editPlan.clips.filter((clip) => clip.sourceArtifactId === sourceArtifactId)
    const sha = knownSources.get(sourceArtifactId)
    if (clips.length === 0 || sha === undefined || sha === null) {
      // No clip plays this source, or its bytes are not established: the windows are about something else or unprovable.
      for (const envelope of unique) reject(acc, 'face', envelope, [clips.length === 0
        ? PERCEPTION_REJECTION.sourceNotInTimeline : PERCEPTION_REJECTION.sourceMismatch])
      continue
    }
    // Only a unit-rate clip whose source and timeline spans have the same length is a pure frame offset; any other is not mapped.
    const mapped = clips.filter((clip) => clip.rate === 1 &&
      clip.sourceOutFrame - clip.sourceInFrame === clip.timelineOutFrame - clip.timelineInFrame)
    mappable += mapped.length
    for (const clip of clips) {
      if (mapped.includes(clip)) continue
      // A clip that is not a pure frame offset is not mapped: its span carries the reason, instead of looking merely unsampled.
      const reasonCode = clip.rate !== 1 ? PERCEPTION_REASON.noUnitRateClip : PERCEPTION_REASON.sourceTimelineLengthMismatch
      unmappedReasons.add(reasonCode)
      addSpan(acc, 'face', { startFrame: clip.timelineInFrame, endFrame: clip.timelineOutFrame }, reasonCode, input, durationMs)
    }
    const stream = collectFaceSourceEvidenceStream(unique, {
      workspaceId: input.workspaceId, sourceArtifactId, sourceSha256: sha, sourceFps: frameClock,
      sourceDurationFrames: Math.max(...clips.map((clip) => clip.sourceOutFrame)),
    })
    const byHash = new Map(unique.map((envelope) => [envelope.envelopeHash, envelope]))
    for (const untrusted of stream.untrusted) {
      const envelope = byHash.get(untrusted.envelopeHash)
      if (envelope) reject(acc, 'face', envelope, untrusted.reasons)
    }
    const unknownByEnvelope = new Map<string, PerceptionSnapshotUnexamined[]>()
    const observationsByEnvelope = new Map<string, number>()
    const overlapping = new Set<string>()
    for (const window of stream.trustedWindows) {
      if (clips.some((clip) => window.startSourceFrame < clip.sourceOutFrame && window.endSourceFrame > clip.sourceInFrame)) {
        overlapping.add(window.envelopeHash)
      }
    }
    for (const sample of stream.samples as readonly FaceSourceEvidenceSample[]) {
      const envelope = byHash.get(sample.envelopeHash)!
      const stored = envelope.samples.find((candidate) => candidate.sourceFrame === sample.sourceFrame)!
      for (const clip of mapped) {
        if (sample.sourceFrame < clip.sourceInFrame || sample.sourceFrame >= clip.sourceOutFrame) continue
        const timelineFrame = sample.sourceFrame + clip.timelineInFrame - clip.sourceInFrame
        if (sample.status === 'unknown') {
          unknownByEnvelope.set(envelope.envelopeHash, [...(unknownByEnvelope.get(envelope.envelopeHash) ?? []),
            Object.freeze({ startFrame: timelineFrame, endFrame: timelineFrame + 1, reasonCode: stored.reasonCode ?? 'UNKNOWN_SAMPLE' })])
          continue
        }
        addFrames(acc, 'face', [{ startFrame: timelineFrame, endFrame: timelineFrame + 1 }])
        acc.partialReason.set('face', PERCEPTION_REASON.sampledFramesOnly)
        const provenanceBase = {
          source: envelope.id, model: envelope.detectorConfig.model, version: envelope.policyId,
          producer: envelope.producer.name, envelopeId: envelope.id, envelopeHash: envelope.envelopeHash,
          confidenceBasis: 'producer-reported' as const,
        }
        sample.detections.forEach((box, boxIndex) => {
          const [startMs, endMs] = frameSpanToMs({ startFrame: timelineFrame, endFrame: timelineFrame + 1 }, fps,
            input.editPlan.durationFrames, perceptionDurationMs(input.editPlan.durationFrames, fps))
          acc.observations.push({
            id: `face-${envelope.envelopeHash.slice(0, 12)}-${timelineFrame}-${boxIndex}`, kind: 'face', startMs, endMs,
            value: Object.freeze({ boxXYXY: box.boxXYXY, confidence: box.confidence, clipped: box.clipped,
              classification: box.classification, identity: 'not-performed', sourceFrame: sample.sourceFrame,
              sourcePts: stored.sourcePts, timelineFrame, clipId: clip.id, frameWidth: sample.frameWidth,
              frameHeight: sample.frameHeight, sampleImageSha256: sample.imageSha256, rawOutputSha256: sample.rawOutputSha256 }),
            provenance: serverProvenance({ ...provenanceBase, confidence: box.confidence }),
          })
          observationsByEnvelope.set(envelope.envelopeHash, (observationsByEnvelope.get(envelope.envelopeHash) ?? 0) + 1)
        })
      }
    }
    for (const window of stream.trustedWindows) {
      if (!overlapping.has(window.envelopeHash)) continue
      const envelope = byHash.get(window.envelopeHash)!
      acc.inputs.push(Object.freeze({
        kind: 'face' as const, producer: envelope.producer.name, schemaVersion: envelope.schemaVersion,
        envelopeId: envelope.id, envelopeHash: envelope.envelopeHash,
        sourceArtifactId, sourceSha256: envelope.sourceSha256,
        sourceClock: Object.freeze({ fps: envelope.sourceFps, timebase: envelope.sourceTimebase }),
        observationCount: observationsByEnvelope.get(envelope.envelopeHash) ?? 0,
        unexamined: Object.freeze([
          ...(unknownByEnvelope.get(envelope.envelopeHash) ?? []),
          ...envelope.gaps.flatMap((gap) => mapped.flatMap((clip) => {
            const start = Math.max(gap.startSourceFrame, clip.sourceInFrame), end = Math.min(gap.endSourceFrame, clip.sourceOutFrame)
            const offset = clip.timelineInFrame - clip.sourceInFrame
            return end > start ? [Object.freeze({ startFrame: start + offset, endFrame: end + offset, reasonCode: gap.reasonCode })] : []
          })),
        ].toSorted((left, right) => left.startFrame - right.startFrame || left.endFrame - right.endFrame ||
          compareText(left.reasonCode, right.reasonCode))),
      }))
    }
  }
  // No clip is a pure frame offset: the kind says which structural reason it was, when it was only one.
  if (mappable === 0 && !acc.absentReason.has('face')) {
    acc.absentReason.set('face', unmappedReasons.size === 1 ? [...unmappedReasons][0]! : PERCEPTION_REASON.noUnitRateClip)
  }
}

/** Fuses the sealed server evidence of one ProjectVersion into its canonical perception snapshot. */
export function assembleServerPerceptionSnapshot(input: ServerPerceptionAssemblyInput): Readonly<ServerPerceptionSnapshot> {
  const workspaceId = identity(input.workspaceId, 'workspaceId')
  const projectId = identity(input.projectId, 'projectId')
  const projectVersionId = identity(input.projectVersionId, 'projectVersionId')
  const plan = input.editPlan
  identity(plan.snapshotId, 'editPlan.snapshotId')
  if ((plan.snapshotHash !== null && !SHA.test(plan.snapshotHash)) || !Number.isFinite(plan.fps) || plan.fps <= 0 ||
      !Number.isSafeInteger(plan.durationFrames) || plan.durationFrames <= 0) invalid('EditPlan clock is invalid')
  for (const clip of plan.clips) {
    if (!ID.test(clip.id) || !ID.test(clip.sourceArtifactId) || !Number.isFinite(clip.rate) || clip.rate <= 0 ||
        ![clip.sourceInFrame, clip.sourceOutFrame, clip.timelineInFrame, clip.timelineOutFrame].every((frame) =>
          Number.isSafeInteger(frame) && frame >= 0) ||
        clip.sourceOutFrame <= clip.sourceInFrame || clip.timelineOutFrame <= clip.timelineInFrame ||
        clip.timelineOutFrame > plan.durationFrames) invalid(`EditPlan clip ${clip.id} is invalid`)
  }
  const durationMs = perceptionDurationMs(plan.durationFrames, plan.fps)
  const sourceIds = [...new Set(plan.clips.map((clip) => clip.sourceArtifactId))].sort(compareText)
  const declared = new Map((input.sources ?? []).map((source) => [source.artifactId, source.sha256] as const))
  for (const [artifactId, sha] of declared) {
    if (!ID.test(artifactId) || (sha !== null && !SHA.test(sha))) invalid('Source identity is invalid')
  }
  const knownSources = new Map(sourceIds.map((id) => [id, declared.get(id) ?? null] as const))
  const acc: Accumulator = { observations: [], frameRanges: new Map(), msRanges: new Map(), absentReason: new Map(),
    partialReason: new Map(), inputs: [], rejected: [], spans: [] }

  const transcriptSource = input.transcript?.transcript.sourceArtifactId
  assembleTranscript(acc, input, durationMs, transcriptSource ? (knownSources.get(transcriptSource) ?? null) : null)
  assembleOcr(acc, input, knownSources)
  assembleTemporal(acc, input, knownSources)
  assembleFace(acc, input, knownSources, durationMs)

  if (acc.observations.length > SERVER_PERCEPTION_MAX_OBSERVATIONS) {
    invalid(`Perception snapshot would exceed ${SERVER_PERCEPTION_MAX_OBSERVATIONS} observations`)
  }
  // Kinds no producer bound to a version exists for. They are absent for a stated reason; nothing fills them.
  const fixedAbsent: Partial<Record<PerceptionKind, string>> = {
    speaker: PERCEPTION_REASON.diarizationUnavailable,
    silence: PERCEPTION_REASON.silenceProducerUnavailable,
    object: PERCEPTION_REASON.noVerifiedDetector,
    'image-insert': PERCEPTION_REASON.insertGeometryNotCompiled,
  }
  const noEvidenceReason: Partial<Record<PerceptionKind, string>> = {
    'transcript-word': PERCEPTION_REASON.noTranscriptWords,
    ocr: PERCEPTION_REASON.noProducerRun, face: PERCEPTION_REASON.noProducerRun,
    shot: PERCEPTION_REASON.noProducerRun, motion: PERCEPTION_REASON.noProducerRun,
  }
  const producedBy: Partial<Record<PerceptionKind, PerceptionSnapshotInputRecord['kind']>> = {
    'transcript-word': 'transcript', ocr: 'ocr', face: 'face', shot: 'temporal', motion: 'temporal',
  }
  const coverage = PERCEPTION_KINDS.map((kind) => {
    const fixed = fixedAbsent[kind]
    const ranges: readonly PerceptionRange[] = fixed ? [] : acc.msRanges.has(kind)
      ? mergeRanges(acc.msRanges.get(kind)!)
      : frameRangesToCoverageMs(acc.frameRanges.get(kind) ?? [], plan.fps, plan.durationFrames, durationMs)
    const state = coverageState(coveredMs(ranges), durationMs)
    // `absent` always says why: no producer ran, or it ran and examined nothing the timeline plays.
    const reasonCode = fixed ?? (state === 'absent'
      ? (acc.absentReason.get(kind) ?? (acc.inputs.some((item) => item.kind === producedBy[kind])
        ? PERCEPTION_REASON.noSamplesObserved : noEvidenceReason[kind]!))
      : state === 'partial' ? acc.partialReason.get(kind) : undefined)
    return { kind, ranges, ...(reasonCode ? { reasonCode } : {}) }
  })
  const observations = acc.observations.filter((item) => !fixedAbsent[item.kind])
  const timeline = createPerceptionTimeline({ durationMs, observations, coverage, origin: 'server' })
  return sealSnapshot({
    schemaVersion: SERVER_PERCEPTION_SNAPSHOT_SCHEMA, authority: 'server-assembled' as const, faceSafety: 'unknown' as const,
    workspaceId, projectId, projectVersionId,
    editPlan: Object.freeze({ snapshotId: plan.snapshotId, snapshotHash: plan.snapshotHash, fps: plan.fps, durationFrames: plan.durationFrames }),
    timeBase: Object.freeze({ unit: 'ms' as const, frameToMs: 'round-nearest' as const, fps: plan.fps, durationFrames: plan.durationFrames, durationMs }),
    sources: Object.freeze(sourceIds.map((artifactId) => Object.freeze({ artifactId, sha256: knownSources.get(artifactId) ?? null }))),
    inputs: Object.freeze(acc.inputs.toSorted((left, right) => compareText(left.kind, right.kind) ||
      compareText(left.sourceArtifactId ?? '', right.sourceArtifactId ?? '') || compareText(left.envelopeHash, right.envelopeHash) ||
      compareText(left.envelopeId, right.envelopeId))),
    rejected: Object.freeze(acc.rejected.toSorted((left, right) => compareText(left.kind, right.kind) ||
      compareText(left.envelopeHash, right.envelopeHash) || compareText(left.envelopeId, right.envelopeId) ||
      compareText(left.reasonCodes.join(','), right.reasonCodes.join(',')) ||
      compareText((left.subjects ?? []).join(','), (right.subjects ?? []).join(',')))),
    unexaminedSpans: Object.freeze(acc.spans.toSorted((left, right) => PERCEPTION_KINDS.indexOf(left.kind) - PERCEPTION_KINDS.indexOf(right.kind) ||
      left.startMs - right.startMs || left.endMs - right.endMs || compareText(left.reasonCode, right.reasonCode))),
    timeline,
  })
}

type SnapshotBody = Omit<ServerPerceptionSnapshot, 'snapshotHash'>
function sealSnapshot(body: SnapshotBody): Readonly<ServerPerceptionSnapshot> {
  return Object.freeze({ ...body, snapshotHash: calculateCanonicalHash(body) })
}

const SNAPSHOT_KEYS = ['schemaVersion', 'authority', 'faceSafety', 'workspaceId', 'projectId', 'projectVersionId', 'editPlan',
  'timeBase', 'sources', 'inputs', 'rejected', 'unexaminedSpans', 'timeline', 'snapshotHash']
const ENVELOPE_INPUT_KINDS: Readonly<Record<PerceptionKind, PerceptionSnapshotInputRecord['kind'] | null>> = Object.freeze({
  'transcript-word': 'transcript', speaker: null, silence: null, face: 'face', object: null, shot: 'temporal', motion: 'temporal',
  ocr: 'ocr', 'image-insert': null,
})

/**
 * Rebuilds a stored snapshot from its own content and refuses anything that is not exactly what the assembler would have
 * sealed: the hash, the timeline (every state and range recomputed), the per-kind invariants and the provenance of every
 * observation, which must name an envelope the snapshot lists as an input.
 */
export function verifyServerPerceptionSnapshot(value: unknown): Readonly<ServerPerceptionSnapshot> {
  const fail = (message: string): never => { throw new DomainError('PERSISTENCE_CONFLICT', `Server perception snapshot is invalid: ${message}`) }
  if (typeof value !== 'object' || value === null || Array.isArray(value)) fail('not an object')
  const record = value as Record<string, unknown>
  if (Object.keys(record).sort().join('|') !== [...SNAPSHOT_KEYS].sort().join('|')) fail('unsupported or missing fields')
  if (record.schemaVersion !== SERVER_PERCEPTION_SNAPSHOT_SCHEMA || record.authority !== 'server-assembled' ||
      record.faceSafety !== 'unknown') fail('schema or authority')
  const stored = record as unknown as ServerPerceptionSnapshot
  const { snapshotHash, ...body } = stored
  if (typeof snapshotHash !== 'string' || !SHA.test(snapshotHash) || calculateCanonicalHash(body) !== snapshotHash) fail('hash')
  let rebuilt: Readonly<PerceptionTimeline>
  try {
    rebuilt = createPerceptionTimeline({
      durationMs: stored.timeline.durationMs, observations: stored.timeline.observations, origin: 'server',
      coverage: stored.timeline.coverage.map((entry) => ({ kind: entry.kind, ranges: entry.ranges,
        ...(entry.reasonCode === undefined ? {} : { reasonCode: entry.reasonCode }) })),
    })
  } catch { return fail('timeline') }
  if (stableSerialize(rebuilt) !== stableSerialize(stored.timeline)) fail('timeline content')
  if (stored.timeBase.durationMs !== stored.timeline.durationMs ||
      stored.timeBase.durationMs !== perceptionDurationMs(stored.timeBase.durationFrames, stored.timeBase.fps) ||
      stored.editPlan.fps !== stored.timeBase.fps || stored.editPlan.durationFrames !== stored.timeBase.durationFrames) fail('time base')
  const coverage = new Map(stored.timeline.coverage.map((entry) => [entry.kind, entry] as const))
  for (const kind of PERCEPTION_KINDS) {
    const entry = coverage.get(kind)! as Readonly<PerceptionCoverage>
    if (entry.state === 'absent' && !entry.reasonCode) fail(`${kind} is absent without a reason`)
    if (entry.state === 'complete' && entry.reasonCode) fail(`${kind} is complete with a reason`)
    if (entry.state === 'absent' && stored.timeline.observations.some((item) => item.kind === kind)) fail(`${kind} has observations but no coverage`)
  }
  const object = coverage.get('object')!
  if (object.state !== 'absent' || object.reasonCode !== PERCEPTION_REASON.noVerifiedDetector ||
      stored.timeline.observations.some((item) => item.kind === 'object')) fail('object must be absent without a verified detector')
  for (const kind of ['speaker', 'silence', 'image-insert'] as const) {
    if (coverage.get(kind)!.state !== 'absent' || stored.timeline.observations.some((item) => item.kind === kind)) {
      fail(`${kind} has no producer bound to a version`)
    }
  }
  if (!Array.isArray(stored.unexaminedSpans)) fail('unexamined spans')
  for (const span of stored.unexaminedSpans) {
    if (!span || typeof span !== 'object' || Object.keys(span).sort().join('|') !== 'endMs|kind|reasonCode|startMs' ||
        !PERCEPTION_KINDS.includes(span.kind) || !Number.isSafeInteger(span.startMs) || !Number.isSafeInteger(span.endMs) ||
        span.startMs < 0 || span.endMs <= span.startMs || span.endMs > stored.timeline.durationMs ||
        typeof span.reasonCode !== 'string' || !/^[A-Z][A-Z0-9_]{2,63}$/.test(span.reasonCode)) fail('unexamined span')
  }
  const inputs = new Map<string, PerceptionSnapshotInputRecord>()
  for (const input of stored.inputs) inputs.set(`${input.kind}|${input.envelopeId}|${input.envelopeHash}`, input)
  if (inputs.size !== stored.inputs.length) fail('duplicate input')
  for (const observation of stored.timeline.observations) {
    const provenance = observation.provenance
    const inputKind = ENVELOPE_INPUT_KINDS[observation.kind]
    if (provenance.origin !== 'server' || !inputKind ||
        !inputs.has(`${inputKind}|${provenance.envelopeId}|${provenance.envelopeHash}`)) {
      fail(`observation ${observation.id} is not bound to a listed input`)
    }
  }
  return Object.freeze(stored)
}

// ---------------------------------------------------------------------------------------------------------------------------
// Range query
// ---------------------------------------------------------------------------------------------------------------------------

export type ServerPerceptionCoverageInRange = Readonly<{
  kind: PerceptionKind
  state: PerceptionCoverage['state']
  ranges: readonly PerceptionRange[]
  /** The part of the requested range this kind did NOT examine, as ranges; empty only when the state is `complete`. */
  unexaminedRanges: readonly PerceptionRange[]
  /** The same unexamined ranges, split where the reason changes: a structural span (speed, unread windows) keeps its own reason. */
  unexaminedReasons: readonly Readonly<{ startMs: number; endMs: number; reasonCode: string }>[]
  observedMs: number
  reasonCode?: string
}>

export function queryServerPerceptionSnapshot(snapshot: Readonly<ServerPerceptionSnapshot>, input: {
  fromMs?: number; toMs?: number; kinds?: readonly PerceptionKind[]
}) {
  const timeline = snapshot.timeline
  const fromMs = input.fromMs ?? 0
  const toMs = input.toMs ?? timeline.durationMs
  if (!Number.isSafeInteger(fromMs) || !Number.isSafeInteger(toMs) || fromMs < 0 || toMs > timeline.durationMs || toMs <= fromMs) {
    invalid('Requested range is outside the snapshot timeline')
  }
  const requested = input.kinds ?? PERCEPTION_KINDS
  if (requested.length < 1 || new Set(requested).size !== requested.length ||
      requested.some((kind) => !PERCEPTION_KINDS.includes(kind))) invalid('Requested perception kinds are invalid')
  const observations = timeline.observations.filter((item) => requested.includes(item.kind) && item.startMs < toMs && item.endMs > fromMs)
  const requestedMs = toMs - fromMs
  const coverage = requested.map((kind): ServerPerceptionCoverageInRange => {
    const whole = timeline.coverage.find((entry) => entry.kind === kind)!
    const ranges = mergeRanges(whole.ranges.flatMap((range) => {
      const start = Math.max(range[0], fromMs), end = Math.min(range[1], toMs)
      return end > start ? [[start, end] as const] : []
    }))
    const observedMs = coveredMs(ranges)
    const state = coverageState(observedMs, requestedMs)
    const unexamined: PerceptionRange[] = []
    let cursor = fromMs
    for (const range of ranges) {
      if (range[0] > cursor) unexamined.push(Object.freeze([cursor, range[0]]) as PerceptionRange)
      cursor = range[1]
    }
    if (cursor < toMs) unexamined.push(Object.freeze([cursor, toMs]) as PerceptionRange)
    // What is not examined is either under a structural span (a clip that cannot be mapped, windows not read) with that span's reason,
    // or simply not sampled / not reached, with the generic one.
    const generic = whole.state === 'absent' ? (whole.reasonCode ?? 'NOT_EXAMINED')
      : state === 'absent' ? 'RANGE_NOT_EXAMINED' : (whole.reasonCode ?? 'NOT_EXAMINED')
    const spans = snapshot.unexaminedSpans.filter((span) => span.kind === kind).toSorted((left, right) => left.startMs - right.startMs || left.endMs - right.endMs)
    const reasons: { startMs: number; endMs: number; reasonCode: string }[] = []
    for (const piece of unexamined) {
      let at = piece[0]
      for (const span of spans) {
        const start = Math.max(span.startMs, at), end = Math.min(span.endMs, piece[1])
        if (end <= start) continue
        if (start > at) reasons.push({ startMs: at, endMs: start, reasonCode: generic })
        reasons.push({ startMs: start, endMs: end, reasonCode: span.reasonCode })
        at = end
      }
      if (at < piece[1]) reasons.push({ startMs: at, endMs: piece[1], reasonCode: generic })
    }
    const distinct = [...new Set(reasons.map((entry) => entry.reasonCode))]
    const reasonCode = state === 'complete' ? undefined : distinct.length === 1 ? distinct[0] : generic
    return Object.freeze({ kind, state, ranges, unexaminedRanges: Object.freeze(unexamined),
      unexaminedReasons: Object.freeze(reasons.map((entry) => Object.freeze(entry))), observedMs,
      ...(reasonCode ? { reasonCode } : {}) })
  })
  return Object.freeze({
    schemaVersion: 'server-perception-range/v1' as const,
    snapshotHash: snapshot.snapshotHash,
    timelineHash: timeline.timelineHash,
    range: Object.freeze({ startMs: fromMs, endMs: toMs }),
    kinds: Object.freeze([...requested]),
    observations: Object.freeze(observations),
    coverage: Object.freeze(coverage),
    inventedValues: 0 as const,
  })
}
