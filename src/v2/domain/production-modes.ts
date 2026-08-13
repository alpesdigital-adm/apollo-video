import { calculateCanonicalHash } from './canonical-hash.ts'
import { DomainError } from './errors.ts'

export interface TimedRange { startMs: number; endMs: number }
export type TalkingHeadCut = Readonly<TimedRange & { kind: 'silence' | 'retake'; evidenceId: string; handleMs: 120 }>
export type ProductionBeat = Readonly<TimedRange & { id: string; role: 'hook' | 'development' | 'proof' | 'cta' }>
export interface ProductionEditPlan {
  schemaVersion: 'production-edit-plan/v2'
  mode: 'talking-head' | 'visual-montage'
  sourceDurationMs: number
  durationMs: number
  sourceAudioId: string
  sourceVideoId?: string
  cuts: readonly Readonly<TimedRange>[]
  beats: readonly ProductionBeat[]
  visuals: readonly Readonly<TimedRange & { kind: 'speaker' | 'b-roll' | 'image' | 'card'; assetBriefId?: string; beatId: string }>[]
  subtitles: readonly Readonly<TimedRange & { beatId: string }>[]
  reframe: boolean
  cameraMotions: readonly Readonly<TimedRange & { beatId: string; kind: 'hold' | 'face-safe-reframe' }>[]
  patternBreaks: readonly number[]
  render: Readonly<{ proxy: Readonly<{ audioTimelineHash: string }>; final: Readonly<{ audioTimelineHash: string }>; synchronized: true }>
  planHash: string
}

export const TALKING_HEAD_POLICY = Object.freeze({
  schemaVersion: 'talking-head-policy/v1' as const,
  minimumSilenceMs: 500,
  handleMs: 120 as const,
  canonicalBeatMs: 6_000,
  protectedOpeningMs: 4_000,
  maximumPatternBreaksPer30s: 2,
})

const ID = /^[A-Za-z0-9][A-Za-z0-9._:-]{2,127}$/
function identifier(value: string, field: string): string {
  const normalized = value.trim()
  if (!ID.test(normalized)) throw new DomainError('INVALID_ARGUMENT', `${field} is invalid`)
  return normalized
}
function duration(value: number, field: string): number {
  if (!Number.isSafeInteger(value) || value < 1) throw new DomainError('INVALID_ARGUMENT', `${field} is invalid`)
  return value
}
function range(value: TimedRange, sourceDurationMs: number, field: string): Readonly<TimedRange> {
  if (!Number.isSafeInteger(value.startMs) || !Number.isSafeInteger(value.endMs) || value.startMs < 0 || value.endMs <= value.startMs || value.endMs > sourceDurationMs) throw new DomainError('INVALID_ARGUMENT', `${field} is invalid`)
  return Object.freeze({ startMs: value.startMs, endMs: value.endMs })
}

function assertDisjoint(ranges: readonly Readonly<TimedRange>[], field: string): void {
  for (let index = 1; index < ranges.length; index += 1) if (ranges[index]!.startMs < ranges[index - 1]!.endMs) throw new DomainError('INVALID_ARGUMENT', `${field} overlap`)
}

function canonicalCuts(input: {
  sourceDurationMs: number
  silences: readonly Readonly<(TimedRange & { evidenceId?: string })>[]
  retakes: readonly Readonly<{ id?: string; ranges: readonly TimedRange[]; selectedIndex: number }>[]
}): readonly TalkingHeadCut[] {
  const silences = input.silences.map((item, index) => ({ ...range(item, input.sourceDurationMs, `silences[${index}]`), evidenceId: identifier(item.evidenceId ?? `silence-${index + 1}`, `silences[${index}].evidenceId`) })).toSorted((left, right) => left.startMs - right.startMs)
  assertDisjoint(silences, 'Silence ranges')
  const candidates: TalkingHeadCut[] = silences.flatMap((item) => item.endMs - item.startMs >= TALKING_HEAD_POLICY.minimumSilenceMs
    ? [Object.freeze({ startMs: item.startMs + TALKING_HEAD_POLICY.handleMs, endMs: item.endMs - TALKING_HEAD_POLICY.handleMs, kind: 'silence' as const, evidenceId: item.evidenceId, handleMs: TALKING_HEAD_POLICY.handleMs })]
    : [])
  const retakeRanges: Readonly<TimedRange>[] = []
  input.retakes.forEach((group, groupIndex) => {
    const groupId = identifier(group.id ?? `retake-${groupIndex + 1}`, `retakes[${groupIndex}].id`)
    if (!Number.isSafeInteger(group.selectedIndex) || group.selectedIndex < 0 || group.selectedIndex >= group.ranges.length || group.ranges.length < 2) throw new DomainError('INVALID_ARGUMENT', `retakes[${groupIndex}] selection is invalid`)
    const ranges = group.ranges.map((item, index) => range(item, input.sourceDurationMs, `retakes[${groupIndex}].ranges[${index}]`))
    assertDisjoint(ranges, `Retake group ${groupId}`)
    retakeRanges.push(...ranges)
    ranges.forEach((item, index) => {
      if (index === group.selectedIndex) return
      const startMs = item.startMs + TALKING_HEAD_POLICY.handleMs
      const endMs = item.endMs - TALKING_HEAD_POLICY.handleMs
      if (endMs > startMs) candidates.push(Object.freeze({ startMs, endMs, kind: 'retake', evidenceId: `${groupId}:take-${index + 1}`, handleMs: TALKING_HEAD_POLICY.handleMs }))
    })
  })
  assertDisjoint(retakeRanges.toSorted((left, right) => left.startMs - right.startMs), 'Retake ranges')
  const ordered = candidates.toSorted((left, right) => left.startMs - right.startMs || left.endMs - right.endMs)
  assertDisjoint(ordered, 'Talking-head removals')
  if (ordered.reduce((total, item) => total + item.endMs - item.startMs, 0) >= input.sourceDurationMs) throw new DomainError('INVALID_ARGUMENT', 'Talking-head removals cannot consume the whole source')
  return Object.freeze(ordered)
}

function beats(durationMs: number): readonly ProductionBeat[] {
  const count = Math.ceil(durationMs / TALKING_HEAD_POLICY.canonicalBeatMs)
  return Object.freeze(Array.from({ length: count }, (_, index) => {
    const startMs = index * TALKING_HEAD_POLICY.canonicalBeatMs
    const endMs = Math.min(durationMs, (index + 1) * TALKING_HEAD_POLICY.canonicalBeatMs)
    const role = index === 0 ? 'hook' : index === count - 1 ? 'cta' : index % 3 === 0 ? 'proof' : 'development'
    return Object.freeze({ id: `beat-${index + 1}`, startMs, endMs, role })
  }))
}

function finalize(core: Omit<ProductionEditPlan, 'schemaVersion' | 'planHash'>): Readonly<ProductionEditPlan> {
  const body = Object.freeze({ schemaVersion: 'production-edit-plan/v2' as const, ...core })
  return Object.freeze({ ...body, planHash: calculateCanonicalHash(body) })
}

export function planTalkingHead(input: {
  durationMs: number
  sourceVideoId: string
  sourceAudioId: string
  silences: readonly Readonly<(TimedRange & { evidenceId?: string })>[]
  retakes: readonly Readonly<{ id?: string; ranges: readonly TimedRange[]; selectedIndex: number }>[]
}): Readonly<ProductionEditPlan> {
  const sourceDurationMs = duration(input.durationMs, 'durationMs')
  const sourceVideoId = identifier(input.sourceVideoId, 'sourceVideoId')
  const sourceAudioId = identifier(input.sourceAudioId, 'sourceAudioId')
  const cuts = canonicalCuts({ sourceDurationMs, silences: input.silences, retakes: input.retakes })
  const outputDurationMs = sourceDurationMs - cuts.reduce((total, item) => total + item.endMs - item.startMs, 0)
  const canonicalBeats = beats(outputDurationMs)
  const audioBody = { schemaVersion: 'talking-head-audio-timeline/v1' as const, sourceAudioId, sourceDurationMs, outputDurationMs, cuts: cuts.map(({ startMs, endMs, kind, evidenceId }) => ({ startMs, endMs, kind, evidenceId })) }
  const audioTimelineHash = calculateCanonicalHash(audioBody)
  const bRollBeats = new Set(canonicalBeats.filter((beat, index) => index > 0 && index % 3 === 1).map((beat) => beat.id))
  const visuals = canonicalBeats.map((beat) => Object.freeze({ startMs: beat.startMs, endMs: beat.endMs, beatId: beat.id, kind: bRollBeats.has(beat.id) ? 'b-roll' as const : 'speaker' as const, ...(bRollBeats.has(beat.id) ? { assetBriefId: `asset-brief-${beat.id}` } : {}) }))
  const cameraMotions = canonicalBeats.map((beat) => Object.freeze({ startMs: beat.startMs, endMs: beat.endMs, beatId: beat.id, kind: beat.startMs < TALKING_HEAD_POLICY.protectedOpeningMs ? 'hold' as const : 'face-safe-reframe' as const }))
  const patternBreaks = canonicalBeats.filter((beat) => bRollBeats.has(beat.id)).map((beat) => beat.startMs)
  return finalize({
    mode: 'talking-head', sourceDurationMs, durationMs: outputDurationMs, sourceAudioId, sourceVideoId,
    cuts, beats: canonicalBeats, visuals: Object.freeze(visuals),
    subtitles: Object.freeze(canonicalBeats.map((beat) => Object.freeze({ startMs: beat.startMs, endMs: beat.endMs, beatId: beat.id }))),
    reframe: true, cameraMotions: Object.freeze(cameraMotions), patternBreaks: Object.freeze(patternBreaks),
    render: Object.freeze({ proxy: Object.freeze({ audioTimelineHash }), final: Object.freeze({ audioTimelineHash }), synchronized: true as const }),
  })
}

export function createEditorialAudioTimelineHash(input: { fps: number; clips: readonly Readonly<{ sourceArtifactId: string; audioSourceArtifactId?: string; audioSourceInFrame?: number; audioSourceOutFrame?: number; sourceInFrame: number; sourceOutFrame: number; timelineInFrame: number; timelineOutFrame: number; rate: number }>[] }): string {
  if (!Number.isFinite(input.fps) || input.fps <= 0 || input.clips.length < 1) throw new DomainError('INVALID_RENDER_INPUT', 'Audio timeline metadata is invalid')
  let cursor = 0
  const segments = input.clips.map((clip, index) => {
    const audioSourceInFrame = clip.audioSourceInFrame ?? clip.sourceInFrame
    const audioSourceOutFrame = clip.audioSourceOutFrame ?? clip.sourceOutFrame
    if (![audioSourceInFrame, audioSourceOutFrame, clip.timelineInFrame, clip.timelineOutFrame].every(Number.isSafeInteger) || clip.timelineInFrame !== cursor || clip.timelineOutFrame <= clip.timelineInFrame || audioSourceOutFrame <= audioSourceInFrame || !Number.isFinite(clip.rate) || clip.rate <= 0) throw new DomainError('INVALID_RENDER_INPUT', `Audio timeline segment ${index} is invalid`)
    cursor = clip.timelineOutFrame
    return Object.freeze({ artifactId: identifier(clip.audioSourceArtifactId ?? clip.sourceArtifactId, `clips[${index}].audioArtifactId`), audioSourceInFrame, audioSourceOutFrame, timelineInFrame: clip.timelineInFrame, timelineOutFrame: clip.timelineOutFrame, rate: clip.rate })
  })
  return calculateCanonicalHash({ schemaVersion: 'editorial-audio-timeline/v1', fps: Number(input.fps.toFixed(6)), segments })
}

export function validateProductionCoverage(plan: ProductionEditPlan) {
  const empty = plan.visuals.some((visual) => visual.endMs <= visual.startMs) || plan.visuals[0]?.startMs !== 0 || plan.visuals.at(-1)?.endMs !== plan.durationMs || plan.visuals.some((visual, index) => index > 0 && visual.startMs !== plan.visuals[index - 1]!.endMs)
  const repeated = plan.visuals.some((visual, index) => index >= 2 && visual.assetBriefId && visual.assetBriefId === plan.visuals[index - 1]!.assetBriefId)
  const illegible = plan.subtitles.some((subtitle) => subtitle.endMs - subtitle.startMs < 400)
  const hashValid = plan.planHash === calculateCanonicalHash(Object.fromEntries(Object.entries(plan).filter(([key]) => key !== 'planHash')))
  return Object.freeze({ valid: !empty && !repeated && !illegible && hashValid, coverage: empty ? 0 : 1, repeated, rhythmValid: plan.beats.every((beat) => beat.endMs - beat.startMs >= 500), legible: !illegible })
}

export const TALKING_HEAD_TIMING_GOLDENS = Object.freeze([30_000, 60_000, 120_000].map((durationMs) => planTalkingHead({ durationMs: durationMs + 560, sourceVideoId: `video-${durationMs}`, sourceAudioId: `audio-${durationMs}`, silences: [{ startMs: 4_000, endMs: 4_800, evidenceId: `silence-${durationMs}` }], retakes: [] })))
