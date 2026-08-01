import { calculateCanonicalHash } from './canonical-hash.ts'
import {
  isSupportedClipRate,
  MAX_CLIP_RATE,
  MIN_CLIP_RATE,
  sourceFrameToTimelineFrame,
  timelineSpanForRate,
} from './clip-timing.ts'
import type { CommandArtifactInvalidationV1, CommandImpactOutputReference, CommandImpactRange } from './command-impact.ts'
import { assertDomain } from './errors.ts'
import type { MediaTranscript } from './media-transcript.ts'

type MutableRecord = Record<string, unknown>

export interface SourceTranscriptReplacementImpactV1 {
  schemaVersion: 'source-transcript-replacement-impact/v1'
  commandId: string
  commandType: 'replace-source-transcript'
  baseVersionId: string
  resultVersionId: string
  previousTranscriptId: string
  previousTranscriptHash: string
  replacementTranscriptId: string
  replacementTranscriptHash: string
  changeKinds: readonly ['source-transcript']
  dependencyTypes: readonly ['audio', 'content', 'policy', 'timing', 'visual']
  affectedRanges: readonly Readonly<CommandImpactRange>[]
  affectedVariantIds: readonly string[]
  affectedArtifacts: readonly Readonly<CommandImpactOutputReference>[]
  requiredRecomputations: readonly ['perception', 'treatment', 'story', 'edit-plan', 'proxy', 'final']
  renderBlockedUntilDirectorRun: true
  impactHash: string
}

function record(value: unknown, field: string): MutableRecord {
  assertDomain(
    typeof value === 'object' && value !== null && !Array.isArray(value),
    'INVALID_ARGUMENT',
    `${field} must be an object`,
  )
  return value as MutableRecord
}

function records(value: unknown, field: string): MutableRecord[] {
  assertDomain(Array.isArray(value), 'INVALID_ARGUMENT', `${field} must be an array`)
  return value.map((item) => record(item, field))
}

function identifier(value: unknown, field: string): string {
  assertDomain(
    typeof value === 'string' && /^[A-Za-z0-9][A-Za-z0-9._:-]{2,127}$/.test(value),
    'INVALID_ARGUMENT',
    `${field} is invalid`,
  )
  return value
}

function sha256(value: unknown, field: string): string {
  assertDomain(
    typeof value === 'string' && /^[a-f0-9]{64}$/.test(value),
    'INVALID_ARGUMENT',
    `${field} is invalid`,
  )
  return value
}

export function materializeSourceTranscriptReplacement(input: {
  editPlan: Readonly<Record<string, unknown>>
  replacement: Readonly<{
    id: string
    sourceArtifactId: string
    transcript: Readonly<MediaTranscript>
  }>
  newVersionId: string
  createdAt: string
}): Readonly<Record<string, unknown>> {
  const plan = structuredClone(input.editPlan) as MutableRecord
  assertDomain(
    plan.schemaVersion === 2 && plan.state === 'compiled',
    'PRECONDITION_REQUIRED',
    'Source transcript replacement requires a compiled EditPlan v2',
  )
  const fps = Number(plan.fps)
  const durationFrames = Number(plan.durationFrames)
  assertDomain(
    Number.isFinite(fps) && fps > 0 && Number.isSafeInteger(durationFrames) && durationFrames > 0,
    'INVALID_ARGUMENT',
    'Source transcript replacement requires valid EditPlan timing',
  )
  const current = record(plan.retimedTranscript, 'EditPlan.retimedTranscript')
  const previousTranscriptId = identifier(current.sourceTranscriptId, 'current sourceTranscriptId')
  const replacementId = identifier(input.replacement.id, 'replacement transcript id')
  assertDomain(previousTranscriptId !== replacementId, 'INVALID_ARGUMENT', 'Replacement transcript must differ from the current transcript')
  const sourceArtifactId = identifier(input.replacement.sourceArtifactId, 'replacement source artifact id')
  const clips = records(plan.videoTracks, 'EditPlan.videoTracks').flatMap((track) =>
    records(track.clips, 'EditPlan video clips'))
  assertDomain(clips.length > 0, 'INVALID_ARGUMENT', 'Source transcript replacement requires timeline clips')
  const sourceRanges = clips.flatMap((clip, index) => {
    // Every clip of the plan is validated, not only the ones carrying the
    // replaced artifact: a plan whose timing contradicts its own rates cannot
    // be trusted to place evidence anywhere. Only the audible ranges of the
    // replaced artifact are then used for mapping.
    const rate = Number(clip.rate)
    assertDomain(
      isSupportedClipRate(rate),
      'INVALID_ARGUMENT',
      `EditPlan clip ${index} rate is outside the supported range [${MIN_CLIP_RATE}, ${MAX_CLIP_RATE}]`,
    )
    const videoSourceInFrame = Number(clip.sourceInFrame)
    const videoSourceOutFrame = Number(clip.sourceOutFrame)
    const sourceInFrame = Number(clip.audioSourceInFrame ?? clip.sourceInFrame)
    const sourceOutFrame = Number(clip.audioSourceOutFrame ?? clip.sourceOutFrame)
    const timelineInFrame = Number(clip.timelineInFrame)
    const timelineOutFrame = Number(clip.timelineOutFrame)
    assertDomain(
      [videoSourceInFrame, videoSourceOutFrame, sourceInFrame, sourceOutFrame, timelineInFrame, timelineOutFrame]
        .every(Number.isSafeInteger) &&
        videoSourceInFrame >= 0 && videoSourceOutFrame > videoSourceInFrame &&
        sourceInFrame >= 0 && sourceOutFrame > sourceInFrame &&
        timelineInFrame >= 0 && timelineOutFrame > timelineInFrame &&
        timelineOutFrame <= durationFrames &&
        sourceOutFrame - sourceInFrame === videoSourceOutFrame - videoSourceInFrame &&
        timelineOutFrame - timelineInFrame === timelineSpanForRate(videoSourceOutFrame - videoSourceInFrame, rate),
      'INVALID_ARGUMENT',
      `EditPlan clip ${index} cannot retime transcript evidence`,
    )
    const audioArtifactId = String(clip.audioSourceArtifactId ?? clip.sourceArtifactId)
    if (audioArtifactId !== sourceArtifactId) return []
    return [{ sourceInFrame, sourceOutFrame, timelineInFrame, timelineOutFrame, rate, ordinal: index }]
  }).toSorted((left, right) =>
    left.timelineInFrame - right.timelineInFrame ||
    left.timelineOutFrame - right.timelineOutFrame ||
    left.ordinal - right.ordinal)
  assertDomain(sourceRanges.length > 0, 'INVALID_ARGUMENT', 'Replacement transcript source is absent from the audio timeline')
  const sourceWords = input.replacement.transcript.words.map((word) => {
    const sourceStartFrame = Math.ceil(word.start * fps - 1e-7)
    const sourceEndFrame = Math.floor(word.end * fps + 1e-7)
    return Object.freeze({ word, sourceStartFrame, sourceEndFrame })
  })
  const words = sourceRanges.flatMap((range) => sourceWords.flatMap(({ word, sourceStartFrame, sourceEndFrame }) => {
    // A word is evidence only when it is entirely inside one audible range:
    // partially covered words are dropped rather than interpolated, so no text
    // is ever attributed to frames the timeline does not play. Iterating ranges
    // in timeline order also preserves intentional source repeats and edits
    // that reorder source chronology.
    if (
      sourceEndFrame < sourceStartFrame ||
      sourceStartFrame < range.sourceInFrame || sourceEndFrame > range.sourceOutFrame
    ) return []
    const timelineStartFrame = sourceFrameToTimelineFrame(sourceStartFrame, range)
    let timelineEndFrame = sourceFrameToTimelineFrame(sourceEndFrame, range)
    if (sourceEndFrame > sourceStartFrame && timelineEndFrame <= timelineStartFrame) {
      // Compression (rate > 1) can round a short word onto a single frame. Give
      // it the one frame that still fits inside the clip; if the clip has no
      // room left, drop the word instead of inventing timeline space.
      if (timelineStartFrame + 1 > range.timelineOutFrame) return []
      timelineEndFrame = timelineStartFrame + 1
    }
    return [Object.freeze({
      text: word.word,
      sourceStartSeconds: word.start,
      sourceEndSeconds: word.end,
      timelineStartFrame,
      timelineEndFrame,
    })]
  }))
  assertDomain(words.length > 0, 'INVALID_ARGUMENT', 'Replacement transcript has no words retained by the current timeline')
  plan.id = `edit-plan-${identifier(input.newVersionId, 'newVersionId')}`
  plan.projectVersionId = input.newVersionId
  plan.retimedTranscript = Object.freeze({
    sourceTranscriptId: replacementId,
    sourceTranscriptHash: input.replacement.transcript.transcriptHash,
    words: Object.freeze(words),
  })
  plan.sourceTranscriptReplacement = Object.freeze({
    schemaVersion: 1,
    previousTranscriptId,
    replacementTranscriptId: replacementId,
    replacementTranscriptHash: input.replacement.transcript.transcriptHash,
    requiresDirectorRun: true,
  })
  plan.createdAt = input.createdAt
  return Object.freeze(plan)
}

export function createSourceTranscriptReplacementImpact(input: {
  commandId: string
  baseVersionId: string
  resultVersionId: string
  previousTranscriptId: string
  previousTranscriptHash: string
  replacementTranscriptId: string
  replacementTranscriptHash: string
  durationFrames: number
  outputReferences: readonly Readonly<CommandImpactOutputReference>[]
}): Readonly<SourceTranscriptReplacementImpactV1> {
  assertDomain(Number.isSafeInteger(input.durationFrames) && input.durationFrames > 0, 'INVALID_ARGUMENT', 'durationFrames is invalid')
  const seenArtifactIds = new Set<string>()
  const outputReferences = input.outputReferences.map((item, index) => {
    const artifactId = identifier(item.artifactId, `outputReferences[${index}].artifactId`)
    const sourceVersionId = identifier(item.sourceVersionId, `outputReferences[${index}].sourceVersionId`)
    const variantId = identifier(item.variantId, `outputReferences[${index}].variantId`)
    assertDomain(item.kind === 'proxy' || item.kind === 'final', 'INVALID_ARGUMENT', `outputReferences[${index}].kind is invalid`)
    assertDomain(sourceVersionId === input.baseVersionId, 'INVALID_ARGUMENT', `outputReferences[${index}] belongs to another version`)
    assertDomain(!seenArtifactIds.has(artifactId), 'INVALID_ARGUMENT', `outputReferences[${index}].artifactId is duplicated`)
    seenArtifactIds.add(artifactId)
    return Object.freeze({ artifactId, sourceVersionId, variantId, kind: item.kind })
  })
  const body = {
    schemaVersion: 'source-transcript-replacement-impact/v1' as const,
    commandId: identifier(input.commandId, 'commandId'),
    commandType: 'replace-source-transcript' as const,
    baseVersionId: identifier(input.baseVersionId, 'baseVersionId'),
    resultVersionId: identifier(input.resultVersionId, 'resultVersionId'),
    previousTranscriptId: identifier(input.previousTranscriptId, 'previousTranscriptId'),
    previousTranscriptHash: sha256(input.previousTranscriptHash, 'previousTranscriptHash'),
    replacementTranscriptId: identifier(input.replacementTranscriptId, 'replacementTranscriptId'),
    replacementTranscriptHash: sha256(input.replacementTranscriptHash, 'replacementTranscriptHash'),
    changeKinds: Object.freeze(['source-transcript'] as const),
    dependencyTypes: Object.freeze(['audio', 'content', 'policy', 'timing', 'visual'] as const),
    affectedRanges: Object.freeze([Object.freeze({ startFrame: 0, endFrame: input.durationFrames })]),
    affectedVariantIds: Object.freeze([...new Set(outputReferences.map((item) => item.variantId))].sort()),
    affectedArtifacts: Object.freeze([...outputReferences]
      .sort((left, right) => `${left.kind}:${left.artifactId}`.localeCompare(`${right.kind}:${right.artifactId}`))
      .map((item) => Object.freeze({ ...item }))),
    requiredRecomputations: Object.freeze(['perception', 'treatment', 'story', 'edit-plan', 'proxy', 'final'] as const),
    renderBlockedUntilDirectorRun: true as const,
  }
  assertDomain(body.previousTranscriptId !== body.replacementTranscriptId, 'INVALID_ARGUMENT', 'Transcript replacement identity is unchanged')
  return Object.freeze({ ...body, impactHash: calculateCanonicalHash(body) })
}

export function parseSourceTranscriptReplacementImpact(
  value: unknown,
): Readonly<SourceTranscriptReplacementImpactV1> {
  const impact = record(value, 'Source transcript replacement impact') as unknown as SourceTranscriptReplacementImpactV1
  const expectedKeys = [
    'schemaVersion', 'commandId', 'commandType', 'baseVersionId', 'resultVersionId',
    'previousTranscriptId', 'previousTranscriptHash', 'replacementTranscriptId',
    'replacementTranscriptHash', 'changeKinds', 'dependencyTypes', 'affectedRanges',
    'affectedVariantIds', 'affectedArtifacts', 'requiredRecomputations',
    'renderBlockedUntilDirectorRun', 'impactHash',
  ].sort()
  assertDomain(
    Object.keys(impact).sort().every((key, index) => key === expectedKeys[index]) &&
      Object.keys(impact).length === expectedKeys.length,
    'PERSISTENCE_CONFLICT',
    'Stored source transcript impact fields are invalid',
  )
  assertDomain(
    impact.schemaVersion === 'source-transcript-replacement-impact/v1' &&
      impact.commandType === 'replace-source-transcript' &&
      impact.renderBlockedUntilDirectorRun === true &&
      JSON.stringify(impact.changeKinds) === JSON.stringify(['source-transcript']) &&
      JSON.stringify(impact.dependencyTypes) === JSON.stringify(['audio', 'content', 'policy', 'timing', 'visual']) &&
      JSON.stringify(impact.requiredRecomputations) === JSON.stringify(['perception', 'treatment', 'story', 'edit-plan', 'proxy', 'final']) &&
      Array.isArray(impact.affectedRanges) && impact.affectedRanges.length === 1 &&
      impact.affectedRanges[0]?.startFrame === 0 &&
      Number.isSafeInteger(impact.affectedRanges[0]?.endFrame) &&
      Number(impact.affectedRanges[0]?.endFrame) > 0 &&
      Array.isArray(impact.affectedVariantIds) &&
      Array.isArray(impact.affectedArtifacts) &&
      impact.affectedArtifacts.every((artifact) =>
        identifier(artifact.artifactId, 'affected artifact id') &&
        ['proxy', 'final'].includes(artifact.kind) &&
        artifact.sourceVersionId === impact.baseVersionId &&
        impact.affectedVariantIds.includes(artifact.variantId)),
    'PERSISTENCE_CONFLICT',
    'Stored source transcript impact is invalid',
  )
  identifier(impact.commandId, 'impact commandId')
  identifier(impact.baseVersionId, 'impact baseVersionId')
  identifier(impact.resultVersionId, 'impact resultVersionId')
  identifier(impact.previousTranscriptId, 'impact previousTranscriptId')
  identifier(impact.replacementTranscriptId, 'impact replacementTranscriptId')
  sha256(impact.previousTranscriptHash, 'impact previousTranscriptHash')
  sha256(impact.replacementTranscriptHash, 'impact replacementTranscriptHash')
  sha256(impact.impactHash, 'impactHash')
  const { impactHash, ...body } = impact
  assertDomain(calculateCanonicalHash(body) === impactHash, 'PERSISTENCE_CONFLICT', 'Stored source transcript impact hash is invalid')
  return Object.freeze(impact)
}

export function createSourceTranscriptArtifactInvalidations(input: {
  impact: Readonly<SourceTranscriptReplacementImpactV1>
  createdAt: string
}): readonly Readonly<CommandArtifactInvalidationV1>[] {
  const impact = parseSourceTranscriptReplacementImpact(input.impact)
  assertDomain(
    typeof input.createdAt === 'string' && !Number.isNaN(Date.parse(input.createdAt)),
    'INVALID_ARGUMENT',
    'createdAt must be an ISO timestamp',
  )
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
