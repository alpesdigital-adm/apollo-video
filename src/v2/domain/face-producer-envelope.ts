import { calculateCanonicalHash, stableSerialize } from './canonical-hash.ts'
import { DomainError } from './errors.ts'

const ID = /^[A-Za-z0-9][A-Za-z0-9._:-]{0,127}$/
const SHA = /^[a-f0-9]{64}$/
const COMMIT = /^[a-f0-9]{40,64}$/
const REASON = /^[A-Z][A-Z0-9_]{2,63}$/

type Rational = Readonly<{ num: number; den: number }>
type TimeMapRange = Readonly<{
  clipId: string
  sourceInFrame: number; sourceOutFrame: number
  timelineInFrame: number; timelineOutFrame: number
  rate: 1
}>
type FaceBox = Readonly<{
  /** Normalized [left, top, right, bottom], never XYWH. */
  boxXYXY: readonly [number, number, number, number]
  confidence: number
  clipped: boolean
  classification: 'unverified-face-candidate'
}>
type FaceSample = Readonly<{
  sourceFrame: number; sourcePts: number; sourcePtsEvidenceHash: string
  timelineFrame: number; imageSha256: string; frameWidth: number; frameHeight: number
  status: 'observed' | 'unknown'
  boxes: readonly FaceBox[]
  reasonCode: string | null
}>
type CoverageGap = Readonly<{
  startTimelineFrame: number; endTimelineFrame: number; reasonCode: string
}>

export type FaceProducerEnvelopeInput = Readonly<{
  id: string; workspaceId: string; projectId: string; projectVersionId: string
  operationId: string; operationAttempt: number; operationFenceHash: string
  sourceArtifactId: string; sourceSha256: string
  editPlanSnapshotId: string; editPlanSnapshotHash: string
  timelineDurationFrames: number; timelineFps: Rational
  sourceFps: Rational; sourceTimebase: Rational
  sourceClock: 'constant-frame-rate'; sourcePtsStart: number
  sourcePtsRounding: 'nearest'
  sourceWidth: number; sourceHeight: number; sourceOrientation: 'rotation-0-exif-neutral'
  timeMap: readonly TimeMapRange[]
  detectorConfig: Readonly<{
    inputWidth: number; inputHeight: number; longestSide: number; upscale: boolean
    orientationPolicy: 'ignore-exif-after-source-validation'
    resizeInterpolation: 'area'; canvasPlacement: 'top-left-zero-pad'
    scoreThreshold: number; nmsThreshold: number; topK: number
    backend: 'opencv-dnn-cpu'; threads: number
  }>
  producer: Readonly<{
    name: string; modelSha256: string; modelLicenseSha256: string
    modelSourceCommit: string; adapterSha256: string; bridgeSha256: string
    executableSha256: string; opencvBinarySha256: string
    opencvVersion: string; opencvPackageVersion: string
    ffmpegSha256: string; ffprobeSha256: string
    assessment: Readonly<{
      status: 'candidate-unreviewed' | 'failed-gate'; preregistrationSha256: string
      developmentReportSha256: string | null; calibrationReportSha256: string | null
    }>
  }>
  samplePolicy: Readonly<{ strategy: 'fixed-interval'; intervalFrames: number; maxSamples: number }>
  samples: readonly FaceSample[]
  gaps: readonly CoverageGap[]
  createdAt: string
}>

export type FaceProducerEnvelope = Readonly<FaceProducerEnvelopeInput & {
  schemaVersion: 'face-producer-envelope/v1'
  authority: 'server-produced'
  coverage: 'sampled-only'
  faceSafety: 'unknown'
  identity: 'not-performed'
  timeMapHash: string
  detectorConfigHash: string
  envelopeHash: string
}>

function invalid(message: string): never { throw new DomainError('INVALID_ARGUMENT', message) }
function frame(value: number) { return Number.isSafeInteger(value) && value >= 0 }
function keys(value: object, expected: readonly string[], label: string) {
  if (!value || typeof value !== 'object' || Array.isArray(value) ||
      Object.keys(value).sort().join('|') !== [...expected].sort().join('|')) {
    invalid(`${label} has unsupported or missing fields`)
  }
}
function freeze<T>(value: T): T {
  if (value && typeof value === 'object') {
    for (const child of Object.values(value)) freeze(child)
    Object.freeze(value)
  }
  return value
}
function shaOrNull(value: string | null) { return value === null || SHA.test(value) }

/** Seals sampled candidate boxes only. Neither detection nor a successful operation grants face safety. */
export function createFaceProducerEnvelope(input: FaceProducerEnvelopeInput): FaceProducerEnvelope {
  keys(input, ['id', 'workspaceId', 'projectId', 'projectVersionId', 'operationId',
    'operationAttempt', 'operationFenceHash', 'sourceArtifactId', 'sourceSha256',
    'editPlanSnapshotId', 'editPlanSnapshotHash', 'timelineDurationFrames', 'timelineFps',
    'sourceFps', 'sourceTimebase', 'sourceClock', 'sourcePtsStart', 'sourcePtsRounding',
    'sourceWidth', 'sourceHeight', 'sourceOrientation', 'timeMap', 'detectorConfig', 'producer',
    'samplePolicy', 'samples', 'gaps', 'createdAt'], 'Face envelope')
  for (const [name, value] of Object.entries({ id: input.id, workspaceId: input.workspaceId,
    projectId: input.projectId, projectVersionId: input.projectVersionId,
    operationId: input.operationId, sourceArtifactId: input.sourceArtifactId,
    editPlanSnapshotId: input.editPlanSnapshotId })) {
    if (!ID.test(value)) invalid(`${name} is invalid`)
  }
  for (const [name, value] of Object.entries({ operationFenceHash: input.operationFenceHash,
    sourceSha256: input.sourceSha256, editPlanSnapshotHash: input.editPlanSnapshotHash })) {
    if (!SHA.test(value)) invalid(`${name} must be SHA-256`)
  }
  keys(input.sourceFps, ['num', 'den'], 'Source fps')
  keys(input.timelineFps, ['num', 'den'], 'Timeline fps')
  keys(input.sourceTimebase, ['num', 'den'], 'Source timebase')
  for (const clock of [input.sourceFps, input.timelineFps, input.sourceTimebase]) {
    if (!frame(clock.num) || clock.num === 0 || !frame(clock.den) || clock.den === 0) {
      invalid('Source or timeline clock is invalid')
    }
  }
  if (!frame(input.timelineDurationFrames) || input.timelineDurationFrames === 0 ||
      !frame(input.sourcePtsStart) || !frame(input.operationAttempt) ||
      input.operationAttempt === 0 || input.sourceClock !== 'constant-frame-rate' ||
      input.sourcePtsRounding !== 'nearest' ||
      !frame(input.sourceWidth) || !frame(input.sourceHeight) ||
      input.sourceWidth === 0 || input.sourceHeight === 0 ||
      input.sourceWidth > 8192 || input.sourceHeight > 8192 ||
      input.sourceWidth * input.sourceHeight > 16_000_000 ||
      input.sourceOrientation !== 'rotation-0-exif-neutral' ||
      !Number.isFinite(Date.parse(input.createdAt))) invalid('Face producer context is invalid')
  if (input.sourceFps.num * input.timelineFps.den !== input.timelineFps.num * input.sourceFps.den ||
      !Number.isSafeInteger(input.sourceFps.num * input.timelineFps.den) ||
      !Number.isSafeInteger(input.timelineFps.num * input.sourceFps.den)) {
    invalid('Only equal-fps CFR source and timeline are supported')
  }
  const ticksNumerator = input.sourceFps.den * input.sourceTimebase.den
  const ticksDenominator = input.sourceFps.num * input.sourceTimebase.num
  const ticksPerFrame = ticksNumerator / ticksDenominator
  if (!Number.isSafeInteger(ticksNumerator) || !Number.isSafeInteger(ticksDenominator) ||
      !Number.isFinite(ticksPerFrame) || ticksPerFrame < 1) {
    invalid('Source PTS cannot resolve individual frames')
  }
  const d = input.detectorConfig
  keys(d, ['inputWidth', 'inputHeight', 'longestSide', 'upscale', 'orientationPolicy',
    'resizeInterpolation', 'canvasPlacement', 'scoreThreshold', 'nmsThreshold',
    'topK', 'backend', 'threads'], 'Face detector config')
  if (!frame(d.inputWidth) || !frame(d.inputHeight) ||
      d.inputWidth < 160 || d.inputWidth > 2048 || d.inputHeight !== d.inputWidth ||
      d.longestSide !== d.inputWidth || typeof d.upscale !== 'boolean' ||
      d.orientationPolicy !== 'ignore-exif-after-source-validation' ||
      d.resizeInterpolation !== 'area' || d.canvasPlacement !== 'top-left-zero-pad' ||
      !Number.isFinite(d.scoreThreshold) || d.scoreThreshold < 0 || d.scoreThreshold > 1 ||
      !Number.isFinite(d.nmsThreshold) || d.nmsThreshold <= 0 || d.nmsThreshold >= 1 ||
      !frame(d.topK) || d.topK < 1 || d.topK > 5000 ||
      d.backend !== 'opencv-dnn-cpu' || !frame(d.threads) || d.threads < 1 || d.threads > 4) {
    invalid('Face detector config is invalid')
  }
  const p = input.producer
  keys(p, ['name', 'modelSha256', 'modelLicenseSha256', 'modelSourceCommit',
    'adapterSha256', 'bridgeSha256', 'executableSha256', 'opencvBinarySha256',
    'opencvVersion', 'opencvPackageVersion', 'ffmpegSha256', 'ffprobeSha256',
    'assessment'], 'Face producer')
  if (!ID.test(p.name) || !COMMIT.test(p.modelSourceCommit) ||
      !ID.test(p.opencvVersion) || !ID.test(p.opencvPackageVersion) ||
      [p.modelSha256, p.modelLicenseSha256, p.adapterSha256, p.bridgeSha256,
        p.executableSha256, p.opencvBinarySha256,
        p.ffmpegSha256, p.ffprobeSha256].some((value) => !SHA.test(value))) {
    invalid('Face producer provenance is incomplete')
  }
  keys(p.assessment, ['status', 'preregistrationSha256', 'developmentReportSha256',
    'calibrationReportSha256'], 'Face assessment')
  if ((p.assessment.status !== 'candidate-unreviewed' &&
       p.assessment.status !== 'failed-gate') ||
      !SHA.test(p.assessment.preregistrationSha256) ||
      !shaOrNull(p.assessment.developmentReportSha256) ||
      !shaOrNull(p.assessment.calibrationReportSha256) ||
      (p.assessment.status === 'failed-gate' &&
        (!p.assessment.developmentReportSha256 || !p.assessment.calibrationReportSha256)) ||
      (p.assessment.status === 'candidate-unreviewed' &&
        (p.assessment.developmentReportSha256 || p.assessment.calibrationReportSha256))) {
    invalid('Face assessment cannot grant approval')
  }
  keys(input.samplePolicy, ['strategy', 'intervalFrames', 'maxSamples'], 'Face sample policy')
  if (input.samplePolicy.strategy !== 'fixed-interval' ||
      !frame(input.samplePolicy.intervalFrames) || input.samplePolicy.intervalFrames === 0 ||
      !frame(input.samplePolicy.maxSamples) || input.samplePolicy.maxSamples === 0 ||
      input.samplePolicy.maxSamples > 10_000 || input.samples.length > input.samplePolicy.maxSamples) {
    invalid('Face sample policy is invalid')
  }
  if (input.timeMap.length === 0 || input.timeMap.length > 10_000) invalid('Face time map is invalid')
  let cursor = 0
  for (const range of input.timeMap) {
    keys(range, ['clipId', 'sourceInFrame', 'sourceOutFrame', 'timelineInFrame',
      'timelineOutFrame', 'rate'], 'Face time-map range')
    if (!ID.test(range.clipId) || !frame(range.sourceInFrame) ||
        !frame(range.sourceOutFrame) || !frame(range.timelineInFrame) ||
        !frame(range.timelineOutFrame) || range.rate !== 1 ||
        range.sourceOutFrame - range.sourceInFrame !==
          range.timelineOutFrame - range.timelineInFrame ||
        range.timelineInFrame !== cursor || range.sourceOutFrame <= range.sourceInFrame) {
      invalid('Face time map must be contiguous, unit-rate and frame exact')
    }
    cursor = range.timelineOutFrame
  }
  if (cursor !== input.timelineDurationFrames) invalid('Face time map must cover the complete timeline')
  let previousTimelineFrame = -1
  for (const sample of input.samples) {
    keys(sample, ['sourceFrame', 'sourcePts', 'sourcePtsEvidenceHash', 'timelineFrame',
      'imageSha256', 'frameWidth', 'frameHeight', 'status', 'boxes', 'reasonCode'], 'Face sample')
    const scaledTicks = sample.sourceFrame * ticksNumerator
    const expectedPts = Math.round(input.sourcePtsStart + scaledTicks / ticksDenominator)
    if (!frame(sample.sourceFrame) || !frame(sample.sourcePts) ||
        !frame(sample.timelineFrame) || sample.timelineFrame <= previousTimelineFrame ||
        sample.timelineFrame >= input.timelineDurationFrames ||
        sample.sourceFrame % input.samplePolicy.intervalFrames !== 0 ||
        !SHA.test(sample.sourcePtsEvidenceHash) || !SHA.test(sample.imageSha256) ||
        sample.frameWidth !== input.sourceWidth || sample.frameHeight !== input.sourceHeight ||
        !Number.isSafeInteger(scaledTicks) ||
        !Number.isSafeInteger(expectedPts) || Math.abs(sample.sourcePts - expectedPts) > 1 ||
        !input.timeMap.some((range) => sample.sourceFrame >= range.sourceInFrame &&
          sample.sourceFrame < range.sourceOutFrame &&
          sample.timelineFrame === range.timelineInFrame + sample.sourceFrame - range.sourceInFrame) ||
        (sample.status !== 'observed' && sample.status !== 'unknown') ||
        sample.boxes.length > 128) invalid('Face sample or source mapping is invalid')
    previousTimelineFrame = sample.timelineFrame
    if (sample.status === 'unknown') {
      if (!sample.reasonCode || !REASON.test(sample.reasonCode) || sample.boxes.length !== 0) {
        invalid('Unknown face sample cannot contain boxes')
      }
    } else if (sample.reasonCode !== null) invalid('Observed face sample cannot carry an error')
    for (const box of sample.boxes) {
      keys(box, ['boxXYXY', 'confidence', 'clipped', 'classification'], 'Face box')
      const coords = box.boxXYXY
      if (!Array.isArray(coords) || coords.length !== 4 ||
          coords.some((value) => !Number.isFinite(value) || value < 0 || value > 1) ||
          coords[0] >= coords[2] || coords[1] >= coords[3] ||
          !Number.isFinite(box.confidence) || box.confidence < 0 ||
          box.confidence > 1 || typeof box.clipped !== 'boolean' ||
          box.classification !== 'unverified-face-candidate') {
        invalid('Face box is invalid')
      }
    }
  }
  if (input.gaps.length > input.samples.length + 1) invalid('Face gap count is invalid')
  const coverage: Array<readonly [number, number]> = input.samples.map((sample) =>
    [sample.timelineFrame, sample.timelineFrame + 1] as const)
  for (const gap of input.gaps) {
    keys(gap, ['startTimelineFrame', 'endTimelineFrame', 'reasonCode'], 'Face gap')
    if (!frame(gap.startTimelineFrame) || !frame(gap.endTimelineFrame) ||
        gap.startTimelineFrame >= gap.endTimelineFrame ||
        gap.endTimelineFrame > input.timelineDurationFrames || !REASON.test(gap.reasonCode)) {
      invalid('Face gap is invalid')
    }
    coverage.push([gap.startTimelineFrame, gap.endTimelineFrame])
  }
  coverage.sort((a, b) => a[0] - b[0])
  if (coverage[0]?.[0] !== 0 || coverage.at(-1)?.[1] !== input.timelineDurationFrames ||
      coverage.some((range, index) => index > 0 && range[0] !== coverage[index - 1]![1])) {
    invalid('Face gaps must complement all unsampled timeline frames')
  }
  const content = freeze({
    ...JSON.parse(stableSerialize(input)) as FaceProducerEnvelopeInput,
    schemaVersion: 'face-producer-envelope/v1' as const,
    authority: 'server-produced' as const,
    coverage: 'sampled-only' as const,
    faceSafety: 'unknown' as const,
    identity: 'not-performed' as const,
    timeMapHash: calculateCanonicalHash(input.timeMap),
    detectorConfigHash: calculateCanonicalHash(input.detectorConfig),
  })
  return freeze({ ...content, envelopeHash: calculateCanonicalHash(content) })
}
