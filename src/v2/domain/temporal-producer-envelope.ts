import { calculateCanonicalHash, stableSerialize } from './canonical-hash.ts'
import { DomainError } from './errors.ts'
export type SourceClock = Readonly<{ num: number; den: number }>
export type TemporalRange = Readonly<{ startSourcePts: number; endSourcePts: number }>
export type TemporalGap = Readonly<TemporalRange & { reasonCode: 'UNRELIABLE_FRAME_DIFFERENCE' }>

export type VisualTemporalAnalysis = Readonly<{
  algorithmVersion: 'visual-temporal-grid/v1'
  sourceSha256: string
  sourceFps: SourceClock
  sourceTimebase: SourceClock
  sourceClock: 'constant-frame-rate'
  sourceWidth: number
  sourceHeight: number
  observedFrameCount: number
  /** Only adjacent-frame intervals [first observed PTS, last observed PTS]. */
  assessedDomain: TemporalRange
  analysisGrid: Readonly<{ width: 160; height: 90 }>
  runtime: Readonly<{ ffmpegSha256: string; ffprobeSha256: string }>
  shot: Readonly<{
    observations: readonly Readonly<TemporalRange & {
      previousFrame: number; currentFrame: number
      previousGridSha256: string; currentGridSha256: string
      changeScore: number
    }>[]
    coverage: readonly TemporalRange[]
    gaps: readonly TemporalGap[]
  }>
  motion: Readonly<{
    observations: readonly Readonly<TemporalRange & {
      previousFrame: number; currentFrame: number
      vectorPxPerSecond: Readonly<{ x: number; y: number }>
      residualMeanAbsoluteLuma: number
      ambiguity: number
    }>[]
    coverage: readonly TemporalRange[]
    gaps: readonly TemporalGap[]
  }>
}>



const ID = /^[A-Za-z0-9][A-Za-z0-9._:-]{0,127}$/
const SHA = /^[a-f0-9]{64}$/
const UNRELIABLE_CHANGE = 0.35

type TimeMapRange = Readonly<{
  clipId: string
  sourceInFrame: number; sourceOutFrame: number
  timelineInFrame: number; timelineOutFrame: number; rate: 1
}>
type TimelineRange = Readonly<{ startTimelineFrame: number; endTimelineFrame: number }>
type TimelineGap = Readonly<TimelineRange & {
  reasonCode: 'NO_ADJACENT_OBSERVED_PAIR' | 'UNRELIABLE_FRAME_DIFFERENCE'
}>
type ProjectedPair = Readonly<{
  previousFrame: number; currentFrame: number
  startSourcePts: number; endSourcePts: number
  clipId: string; startTimelineFrame: number; endTimelineFrame: number
}>

export type TemporalProducerEnvelopeInput = Readonly<{
  id: string; workspaceId: string; projectId: string; projectVersionId: string
  operationId: string; operationAttempt: number; operationFenceHash: string
  sourceArtifactId: string; sourceSha256: string
  editPlanSnapshotId: string; editPlanSnapshotHash: string
  timelineDurationFrames: number; timelineFps: Readonly<{ num: number; den: number }>
  timeMap: readonly TimeMapRange[]
  analysis: Readonly<VisualTemporalAnalysis>
  createdAt: string
}>

export type TemporalProducerEnvelope = Readonly<TemporalProducerEnvelopeInput & {
  schemaVersion: 'temporal-producer-envelope/v1'
  authority: 'server-produced'
  interpretation: 'raw-measurements-only'
  faceSafety: 'unknown'
  timeMapHash: string
  shot: Readonly<{ observations: readonly Readonly<ProjectedPair & {
    changeScore: number; previousGridSha256: string; currentGridSha256: string
  }>[]; coverage: readonly TimelineRange[]; gaps: readonly TimelineGap[] }>
  motion: Readonly<{ observations: readonly Readonly<ProjectedPair & {
    vectorPxPerSecond: Readonly<{ x: number; y: number }>
    residualMeanAbsoluteLuma: number; ambiguity: number
  }>[]; coverage: readonly TimelineRange[]; gaps: readonly TimelineGap[] }>
  envelopeHash: string
}>

function invalid(message: string): never { throw new DomainError('INVALID_ARGUMENT', message) }
function validFrame(value: number) { return Number.isSafeInteger(value) && value >= 0 }
function exactKeys(value: object, keys: readonly string[], label: string) {
  if (Object.keys(value).sort().join('|') !== [...keys].sort().join('|')) {
    invalid(`${label} has unsupported or missing fields`)
  }
}
function deepFreeze<T>(value: T): T {
  if (value && typeof value === 'object') {
    for (const child of Object.values(value)) deepFreeze(child)
    Object.freeze(value)
  }
  return value
}
function sameRational(left: Readonly<{ num: number; den: number }>,
  right: Readonly<{ num: number; den: number }>) {
  return left.num * right.den === right.num * left.den
}
function merged(ranges: readonly TimelineRange[]): readonly TimelineRange[] {
  const result: Array<{ startTimelineFrame: number; endTimelineFrame: number }> = []
  for (const item of [...ranges].sort((a, b) =>
    a.startTimelineFrame - b.startTimelineFrame || a.endTimelineFrame - b.endTimelineFrame)) {
    const last = result.at(-1)
    if (last && item.startTimelineFrame <= last.endTimelineFrame) {
      last.endTimelineFrame = Math.max(last.endTimelineFrame, item.endTimelineFrame)
    } else result.push({ startTimelineFrame: item.startTimelineFrame,
      endTimelineFrame: item.endTimelineFrame })
  }
  return result
}
function mergedSource(ranges: readonly Readonly<{ startSourcePts: number; endSourcePts: number }>[]) {
  const result: Array<{ startSourcePts: number; endSourcePts: number }> = []
  for (const item of ranges) {
    const last = result.at(-1)
    if (last?.endSourcePts === item.startSourcePts) last.endSourcePts = item.endSourcePts
    else result.push({ startSourcePts: item.startSourcePts, endSourcePts: item.endSourcePts })
  }
  return result
}
function gapComplement(coverage: readonly TimelineRange[], duration: number,
  unreliable: readonly TimelineRange[]): readonly TimelineGap[] {
  const gaps: TimelineGap[] = []
  const mark = (start: number, end: number, reasonCode: TimelineGap['reasonCode']) => {
    if (start < end) gaps.push({ startTimelineFrame: start, endTimelineFrame: end, reasonCode })
  }
  let cursor = 0
  const covered = merged(coverage)
  const unsafe = merged(unreliable)
  for (const range of covered) {
    if (cursor < range.startTimelineFrame) {
      let gapCursor = cursor
      for (const marked of unsafe) {
        if (marked.endTimelineFrame <= gapCursor || marked.startTimelineFrame >= range.startTimelineFrame) continue
        mark(gapCursor, Math.min(marked.startTimelineFrame, range.startTimelineFrame),
          'NO_ADJACENT_OBSERVED_PAIR')
        const start = Math.max(gapCursor, marked.startTimelineFrame)
        const end = Math.min(range.startTimelineFrame, marked.endTimelineFrame)
        mark(start, end, 'UNRELIABLE_FRAME_DIFFERENCE')
        gapCursor = end
      }
      mark(gapCursor, range.startTimelineFrame, 'NO_ADJACENT_OBSERVED_PAIR')
    }
    cursor = range.endTimelineFrame
  }
  mark(cursor, duration, 'NO_ADJACENT_OBSERVED_PAIR')
  return gaps
}

/** A bounded CFR source slice. Scores and global vectors do not assert semantic shot or camera labels. */
export function createTemporalProducerEnvelope(input: TemporalProducerEnvelopeInput): TemporalProducerEnvelope {
  exactKeys(input, ['id', 'workspaceId', 'projectId', 'projectVersionId', 'operationId',
    'operationAttempt', 'operationFenceHash', 'sourceArtifactId', 'sourceSha256',
    'editPlanSnapshotId', 'editPlanSnapshotHash', 'timelineDurationFrames',
    'timelineFps', 'timeMap', 'analysis', 'createdAt'], 'Temporal envelope')
  for (const value of [input.id, input.workspaceId, input.projectId, input.projectVersionId,
    input.operationId, input.sourceArtifactId, input.editPlanSnapshotId]) {
    if (!ID.test(value)) invalid('Temporal envelope identity is invalid')
  }
  for (const value of [input.operationFenceHash, input.sourceSha256, input.editPlanSnapshotHash]) {
    if (!SHA.test(value)) invalid('Temporal envelope hash is invalid')
  }
  if (!Number.isSafeInteger(input.operationAttempt) || input.operationAttempt < 1 ||
      !validFrame(input.timelineDurationFrames) || input.timelineDurationFrames < 2 ||
      input.timelineDurationFrames > 300 ||
      !Number.isFinite(Date.parse(input.createdAt))) invalid('Temporal envelope bounds are invalid')
  exactKeys(input.timelineFps, ['num', 'den'], 'Timeline fps')
  const a = input.analysis
  exactKeys(a, ['algorithmVersion', 'sourceSha256', 'sourceFps', 'sourceTimebase', 'sourceClock',
    'sourceWidth', 'sourceHeight', 'observedFrameCount', 'assessedDomain', 'analysisGrid',
    'runtime', 'shot', 'motion'], 'Temporal analysis')
  exactKeys(a.analysisGrid, ['width', 'height'], 'Temporal grid')
  exactKeys(a.runtime, ['ffmpegSha256', 'ffprobeSha256'], 'Temporal runtime')
  exactKeys(a.assessedDomain, ['startSourcePts', 'endSourcePts'], 'Assessed source domain')
  if (a.algorithmVersion !== 'visual-temporal-grid/v1' || a.sourceClock !== 'constant-frame-rate' ||
      a.sourceSha256 !== input.sourceSha256 || a.analysisGrid.width !== 160 ||
      a.analysisGrid.height !== 90 || !SHA.test(a.runtime.ffmpegSha256) ||
      !SHA.test(a.runtime.ffprobeSha256) || !validFrame(a.observedFrameCount) ||
      a.observedFrameCount < 2 || a.observedFrameCount > 300 ||
      !validFrame(a.sourceWidth) || !validFrame(a.sourceHeight) ||
      a.sourceWidth < 1 || a.sourceWidth > 1920 || a.sourceHeight < 1 || a.sourceHeight > 1080) {
    invalid('Temporal analysis provenance or dimensions are invalid')
  }
  for (const clock of [a.sourceFps, a.sourceTimebase, input.timelineFps]) {
    exactKeys(clock, ['num', 'den'], 'Temporal clock')
    if (!Number.isSafeInteger(clock.num) || !Number.isSafeInteger(clock.den) ||
        clock.num < 1 || clock.den < 1) invalid('Temporal clock is invalid')
  }
  if (!sameRational(a.sourceFps, input.timelineFps) ||
      a.observedFrameCount * a.sourceFps.den / a.sourceFps.num > 10 ||
      !validFrame(a.assessedDomain.startSourcePts) ||
      !validFrame(a.assessedDomain.endSourcePts) ||
      a.assessedDomain.endSourcePts <= a.assessedDomain.startSourcePts) {
    invalid('Temporal source and timeline clocks are unsupported')
  }
  const ticksPerFrame = a.sourceFps.den * a.sourceTimebase.den /
    (a.sourceFps.num * a.sourceTimebase.num)
  if (!Number.isFinite(ticksPerFrame) || ticksPerFrame < 1) invalid('Temporal PTS resolution is unsupported')
  if (input.timeMap.length < 1 || input.timeMap.length > 300) invalid('Temporal map is empty or oversized')
  let cursor = 0
  for (const range of input.timeMap) {
    exactKeys(range, ['clipId', 'sourceInFrame', 'sourceOutFrame',
      'timelineInFrame', 'timelineOutFrame', 'rate'], 'Temporal map range')
    if (!ID.test(range.clipId) || range.rate !== 1 ||
        !validFrame(range.sourceInFrame) || !validFrame(range.sourceOutFrame) ||
        !validFrame(range.timelineInFrame) || !validFrame(range.timelineOutFrame) ||
        range.sourceOutFrame > a.observedFrameCount ||
        range.sourceOutFrame <= range.sourceInFrame ||
        range.timelineInFrame !== cursor ||
        range.timelineOutFrame - range.timelineInFrame !== range.sourceOutFrame - range.sourceInFrame) {
      invalid('Temporal source-to-timeline map must be contiguous, unit-rate and fully observed')
    }
    cursor = range.timelineOutFrame
  }
  if (cursor !== input.timelineDurationFrames) invalid('Temporal map does not cover the timeline')
  exactKeys(a.shot, ['observations', 'coverage', 'gaps'], 'Shot measurements')
  exactKeys(a.motion, ['observations', 'coverage', 'gaps'], 'Motion measurements')
  if (a.shot.observations.length !== a.observedFrameCount - 1 || a.shot.gaps.length !== 0 ||
      a.motion.observations.length + a.motion.gaps.length !== a.shot.observations.length) {
    invalid('Temporal adjacent-frame coverage is incomplete')
  }
  const shotPairs: TemporalProducerEnvelope['shot']['observations'][number][] = []
  const motionPairs: TemporalProducerEnvelope['motion']['observations'][number][] = []
  const unreliable: TimelineRange[] = []
  for (const [index, pair] of a.shot.observations.entries()) {
    exactKeys(pair, ['startSourcePts', 'endSourcePts', 'previousFrame', 'currentFrame',
      'previousGridSha256', 'currentGridSha256', 'changeScore'], 'Shot pair')
    if (pair.previousFrame !== index || pair.currentFrame !== index + 1 ||
        !validFrame(pair.startSourcePts) || !validFrame(pair.endSourcePts) ||
        pair.endSourcePts <= pair.startSourcePts ||
        (index === 0 && pair.startSourcePts !== a.assessedDomain.startSourcePts) ||
        (index > 0 && pair.startSourcePts !== a.shot.observations[index - 1]!.endSourcePts) ||
        (index === a.shot.observations.length - 1 && pair.endSourcePts !== a.assessedDomain.endSourcePts) ||
        Math.abs(pair.startSourcePts -
          (a.assessedDomain.startSourcePts + index * ticksPerFrame)) > 1 ||
        Math.abs(pair.endSourcePts -
          (a.assessedDomain.startSourcePts + (index + 1) * ticksPerFrame)) > 1 ||
        Math.abs(pair.endSourcePts - pair.startSourcePts - ticksPerFrame) > 1 ||
        !SHA.test(pair.previousGridSha256) || !SHA.test(pair.currentGridSha256) ||
        !Number.isFinite(pair.changeScore) || pair.changeScore < 0 || pair.changeScore > 1) {
      invalid('Shot pair has invalid frame, PTS or score')
    }
    for (const range of input.timeMap) {
      if (pair.previousFrame < range.sourceInFrame || pair.currentFrame >= range.sourceOutFrame) continue
      const startTimelineFrame = range.timelineInFrame + pair.previousFrame - range.sourceInFrame
      shotPairs.push({ ...pair, clipId: range.clipId,
        startTimelineFrame, endTimelineFrame: startTimelineFrame + 1 })
    }
  }
  const motionByPair = new Map<number, VisualTemporalAnalysis['motion']['observations'][number]>()
  const gapByPair = new Map<number, VisualTemporalAnalysis['motion']['gaps'][number]>()
  for (const [index, motion] of a.motion.observations.entries()) {
    exactKeys(motion, ['startSourcePts', 'endSourcePts', 'previousFrame', 'currentFrame',
      'vectorPxPerSecond', 'residualMeanAbsoluteLuma', 'ambiguity'], 'Motion pair')
    exactKeys(motion.vectorPxPerSecond, ['x', 'y'], 'Motion vector')
    if (!Number.isFinite(motion.vectorPxPerSecond.x) ||
        !Number.isFinite(motion.vectorPxPerSecond.y) ||
        Math.abs(motion.vectorPxPerSecond.x) > 1_000_000 ||
        Math.abs(motion.vectorPxPerSecond.y) > 1_000_000 ||
        !Number.isFinite(motion.residualMeanAbsoluteLuma) ||
        motion.residualMeanAbsoluteLuma < 0 || motion.residualMeanAbsoluteLuma > 1 ||
        !Number.isFinite(motion.ambiguity) || motion.ambiguity < 0 || motion.ambiguity > 1 ||
        motionByPair.has(motion.previousFrame) ||
        (index > 0 && motion.previousFrame <= a.motion.observations[index - 1]!.previousFrame)) {
      invalid('Motion pair is invalid')
    }
    motionByPair.set(motion.previousFrame, motion)
  }
  for (const gap of a.motion.gaps) {
    exactKeys(gap, ['startSourcePts', 'endSourcePts', 'reasonCode'], 'Motion source gap')
    if (gap.reasonCode !== 'UNRELIABLE_FRAME_DIFFERENCE') invalid('Motion gap reason is invalid')
    const index = a.shot.observations.findIndex((pair) =>
      pair.startSourcePts === gap.startSourcePts && pair.endSourcePts === gap.endSourcePts)
    if (index < 0 || gapByPair.has(index)) invalid('Motion gap does not match an observed pair')
    gapByPair.set(index, gap)
  }
  for (const pair of a.shot.observations) {
    const motion = motionByPair.get(pair.previousFrame)
    const gap = gapByPair.get(pair.previousFrame)
    if (Boolean(motion) === Boolean(gap) ||
        Boolean(gap) !== (pair.changeScore > UNRELIABLE_CHANGE) ||
        (motion && (motion.currentFrame !== pair.currentFrame ||
          motion.startSourcePts !== pair.startSourcePts || motion.endSourcePts !== pair.endSourcePts))) {
      invalid('Motion observation or gap is missing or misaligned')
    }
    for (const range of input.timeMap) {
      if (pair.previousFrame < range.sourceInFrame || pair.currentFrame >= range.sourceOutFrame) continue
      const startTimelineFrame = range.timelineInFrame + pair.previousFrame - range.sourceInFrame
      if (motion) motionPairs.push({ ...motion, clipId: range.clipId,
        startTimelineFrame, endTimelineFrame: startTimelineFrame + 1 })
      else unreliable.push({ startTimelineFrame, endTimelineFrame: startTimelineFrame + 1 })
    }
  }
  if (a.shot.coverage.length !== 1 ||
      a.shot.coverage[0]!.startSourcePts !== a.assessedDomain.startSourcePts ||
      a.shot.coverage[0]!.endSourcePts !== a.assessedDomain.endSourcePts ||
      stableSerialize(a.motion.coverage) !== stableSerialize(mergedSource(a.motion.observations))) {
    invalid('Temporal source coverage is inconsistent')
  }
  const shotCoverage = merged(shotPairs)
  const motionCoverage = merged(motionPairs)
  const content = deepFreeze({
    ...JSON.parse(stableSerialize(input)) as TemporalProducerEnvelopeInput,
    schemaVersion: 'temporal-producer-envelope/v1' as const,
    authority: 'server-produced' as const,
    interpretation: 'raw-measurements-only' as const,
    faceSafety: 'unknown' as const,
    timeMapHash: calculateCanonicalHash(input.timeMap),
    shot: { observations: shotPairs, coverage: shotCoverage,
      gaps: gapComplement(shotCoverage, input.timelineDurationFrames, []) },
    motion: { observations: motionPairs, coverage: motionCoverage,
      gaps: gapComplement(motionCoverage, input.timelineDurationFrames, unreliable) },
  })
  return deepFreeze({ ...content, envelopeHash: calculateCanonicalHash(content) })
}
