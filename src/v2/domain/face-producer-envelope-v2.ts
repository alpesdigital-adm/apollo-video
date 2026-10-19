import { calculateCanonicalHash, stableSerialize } from './canonical-hash.ts'
import { DomainError } from './errors.ts'
import { FACE0204_OUTPUT_BYTES, FACE0204_OUTPUT_POLICY_ID, FACE0204_OUTPUT_POLICY_SHA256,
  FACE0204_OUTPUT_SLOTS, decodeFace0204Output } from './face-detector-output.ts'
import { FACE_EVIDENCE_POLICY, FACE_EVIDENCE_POLICY_SHA256, FACE_V9_OWNER_ACCEPTANCE_SHA256,
  faceWindowFrames } from './face-evidence-policy.ts'

/**
 * Sealed face evidence of one window of one source clip, produced by the owner-accepted V9 detector.
 *
 * It is evidence, not authority: coverage is sampled, `faceSafety` stays `unknown`, nothing is identified, and the
 * assessment is the owner's scoped acceptance (foreground faces and the speaker), never a qualification. Every
 * detection from the collection floor is kept; the sample also binds the SHA-256 of the raw 5600-byte detector
 * output, so any threshold can be re-derived later from the retained bytes.
 */
const ID = /^[A-Za-z0-9][A-Za-z0-9._:-]{0,127}$/
const SHA = /^[a-f0-9]{64}$/
const COMMIT = /^[a-f0-9]{40,64}$/
const REASON = /^[A-Z][A-Z0-9_]{2,63}$/
const VERSION = /^[A-Za-z0-9][A-Za-z0-9._+/-]{0,127}$/

type Rational = Readonly<{ num: number; den: number }>
export type FaceTimeMapRangeV2 = Readonly<{
  clipId: string
  sourceInFrame: number; sourceOutFrame: number
  timelineInFrame: number; timelineOutFrame: number
  rate: 1
}>
export type FaceBoxV2 = Readonly<{
  /** Visible intersection with the frame, normalized [left, top, right, bottom]. */
  boxXYXY: readonly [number, number, number, number]
  confidence: number
  clipped: boolean
  classification: 'unverified-face-candidate'
}>
export type FaceSampleV2 = Readonly<{
  sourceFrame: number; sourcePts: number; sourcePtsEvidenceHash: string
  timelineFrame: number; imageSha256: string; frameWidth: number; frameHeight: number
  status: 'observed' | 'unknown'
  boxes: readonly FaceBoxV2[]
  /** SHA-256 and size of the raw detector output; null only when the detector produced none. */
  rawOutput: Readonly<{ sha256: string; bytes: 5600 }> | null
  reasonCode: string | null
}>
export type FaceCoverageGapV2 = Readonly<{ startTimelineFrame: number; endTimelineFrame: number; reasonCode: string }>

export type FaceDetectorConfigV2 = Readonly<{
  family: 'openvino-ssd'
  model: 'face-detection-0204'
  inputWidth: 448; inputHeight: 448
  colorOrder: 'bgr'; tensorLayout: 'nchw'; tensorType: 'float32'; pixelRange: '0-255'
  resize: 'direct-bilinear'
  orientationPolicy: 'ignore-exif-after-source-validation'
  frameEncoding: 'png-lossless'
  backend: 'openvino-cpu'; precision: 'f32'
  threads: 2; streams: 1
  outputSlots: 200; outputBytes: 5600
  collectionScoreFloor: number
}>
export type FaceProducerV2 = Readonly<{
  name: 'openvino-face-detection-0204'
  model: Readonly<{
    precision: 'FP32'; xmlSha256: string; binSha256: string; xmlBytes: number; binBytes: number
    licenseSha256: string; sourceCommit: string
  }>
  outputPolicy: Readonly<{ id: typeof FACE0204_OUTPUT_POLICY_ID; sha256: string }>
  runtime: Readonly<{
    platform: 'win32' | 'linux'
    pythonVersion: string; openvinoVersion: string; openvinoPackageVersion: string
    opencvVersion: string; numpyVersion: string; runtimeManifestSha256: string
  }>
  adapterSha256: string; bridgeSha256: string; pythonExecutableSha256: string
  ffmpegSha256: string; ffprobeSha256: string
  assessment: Readonly<{
    status: 'owner-accepted-scoped'
    scope: 'foreground-faces-and-speaker'
    ownerAcceptanceSha256: string
    v9ReceiptSha256: string; v9PreregistrationSha256: string
    independentConfirmation: 'not-performed'
    /** Linux needs a passed parity receipt before the registry authenticates it; see the producer registry. */
    runtimeParity: Readonly<{ status: 'pending' | 'passed'; receiptSha256: string | null }>
  }>
}>

export type FaceProducerEnvelopeV2Input = Readonly<{
  id: string; workspaceId: string; projectId: string; projectVersionId: string
  operationId: string; operationAttempt: number; operationFenceHash: string
  sourceArtifactId: string; sourceSha256: string
  editPlanSnapshotId: string; editPlanSnapshotHash: string
  timelineDurationFrames: number; timelineFps: Rational
  sourceFps: Rational; sourceTimebase: Rational
  sourceClock: 'constant-frame-rate'; sourcePtsStart: number; sourcePtsRounding: 'nearest'
  sourceWidth: number; sourceHeight: number; sourceOrientation: 'rotation-0-exif-neutral'
  timeMap: readonly FaceTimeMapRangeV2[]
  window: Readonly<{ startTimelineFrame: number; endTimelineFrame: number }>
  policyId: string; policySha256: string
  detectorConfig: FaceDetectorConfigV2
  producer: FaceProducerV2
  samplePolicy: Readonly<{ strategy: 'fixed-interval'; intervalFrames: number; maxSamples: 60 }>
  samples: readonly FaceSampleV2[]
  gaps: readonly FaceCoverageGapV2[]
  createdAt: string
}>
export type FaceProducerEnvelopeV2 = Readonly<FaceProducerEnvelopeV2Input & {
  schemaVersion: 'face-producer-envelope/v2'
  authority: 'server-produced'
  coverage: 'sampled-only'
  faceSafety: 'unknown'
  identity: 'not-performed'
  timeMapHash: string
  detectorConfigHash: string
  envelopeHash: string
}>

export const FACE_ENVELOPE_V2_MAX_TIMELINE_FRAMES = 10_000_000
export const FACE_ENVELOPE_V2_MAX_WINDOW_FRAMES = FACE_EVIDENCE_POLICY.sampling.maxWindowFrames
export const FACE_ENVELOPE_V2_MAX_SAMPLES = FACE_EVIDENCE_POLICY.sampling.maxSamplesPerWindow

export function invalid(message: string): never { throw new DomainError('INVALID_ARGUMENT', message) }
export function frame(value: unknown): value is number { return typeof value === 'number' && Number.isSafeInteger(value) && value >= 0 }
export function keys(value: object, expected: readonly string[], label: string) {
  if (!value || typeof value !== 'object' || Array.isArray(value) ||
      Object.keys(value).sort().join('|') !== [...expected].sort().join('|')) {
    invalid(`${label} has unsupported or missing fields`)
  }
}
export function freeze<T>(value: T): T {
  if (value && typeof value === 'object') {
    for (const child of Object.values(value)) freeze(child)
    Object.freeze(value)
  }
  return value
}
export const sha = (value: unknown) => typeof value === 'string' && SHA.test(value)

/** Shared with `face-producer-envelope-v3`: the detector and the producer pins are the same whatever keys the evidence. */
export function validateDetectorConfig(d: FaceDetectorConfigV2) {
  keys(d, ['family', 'model', 'inputWidth', 'inputHeight', 'colorOrder', 'tensorLayout', 'tensorType', 'pixelRange',
    'resize', 'orientationPolicy', 'frameEncoding', 'backend', 'precision', 'threads', 'streams', 'outputSlots',
    'outputBytes', 'collectionScoreFloor'], 'Face detector config')
  if (d.family !== 'openvino-ssd' || d.model !== 'face-detection-0204' || d.inputWidth !== 448 || d.inputHeight !== 448 ||
      d.colorOrder !== 'bgr' || d.tensorLayout !== 'nchw' || d.tensorType !== 'float32' || d.pixelRange !== '0-255' ||
      d.resize !== 'direct-bilinear' || d.orientationPolicy !== 'ignore-exif-after-source-validation' ||
      d.frameEncoding !== 'png-lossless' || d.backend !== 'openvino-cpu' || d.precision !== 'f32' ||
      d.threads !== 2 || d.streams !== 1 || d.outputSlots !== FACE0204_OUTPUT_SLOTS ||
      d.outputBytes !== FACE0204_OUTPUT_BYTES ||
      d.collectionScoreFloor !== FACE_EVIDENCE_POLICY.detection.collectionScoreFloor) {
    invalid('Face detector config is invalid')
  }
}

export function validateProducer(p: FaceProducerV2) {
  keys(p, ['name', 'model', 'outputPolicy', 'runtime', 'adapterSha256', 'bridgeSha256', 'pythonExecutableSha256',
    'ffmpegSha256', 'ffprobeSha256', 'assessment'], 'Face producer')
  keys(p.model, ['precision', 'xmlSha256', 'binSha256', 'xmlBytes', 'binBytes', 'licenseSha256', 'sourceCommit'], 'Face model')
  keys(p.outputPolicy, ['id', 'sha256'], 'Face output policy')
  keys(p.runtime, ['platform', 'pythonVersion', 'openvinoVersion', 'openvinoPackageVersion', 'opencvVersion',
    'numpyVersion', 'runtimeManifestSha256'], 'Face runtime')
  keys(p.assessment, ['status', 'scope', 'ownerAcceptanceSha256', 'v9ReceiptSha256', 'v9PreregistrationSha256',
    'independentConfirmation', 'runtimeParity'], 'Face assessment')
  keys(p.assessment.runtimeParity, ['status', 'receiptSha256'], 'Face runtime parity')
  if (p.name !== 'openvino-face-detection-0204' || p.model.precision !== 'FP32' ||
      !sha(p.model.xmlSha256) || !sha(p.model.binSha256) || !sha(p.model.licenseSha256) ||
      !frame(p.model.xmlBytes) || p.model.xmlBytes === 0 || !frame(p.model.binBytes) || p.model.binBytes === 0 ||
      !COMMIT.test(p.model.sourceCommit) ||
      p.outputPolicy.id !== FACE0204_OUTPUT_POLICY_ID || p.outputPolicy.sha256 !== FACE0204_OUTPUT_POLICY_SHA256 ||
      (p.runtime.platform !== 'win32' && p.runtime.platform !== 'linux') ||
      ![p.runtime.pythonVersion, p.runtime.openvinoVersion, p.runtime.openvinoPackageVersion, p.runtime.opencvVersion,
        p.runtime.numpyVersion].every((value) => typeof value === 'string' && VERSION.test(value)) ||
      !sha(p.runtime.runtimeManifestSha256) ||
      ![p.adapterSha256, p.bridgeSha256, p.pythonExecutableSha256, p.ffmpegSha256, p.ffprobeSha256].every(sha)) {
    invalid('Face producer provenance is incomplete')
  }
  const a = p.assessment
  const parity = a.runtimeParity
  if (a.status !== 'owner-accepted-scoped' || a.scope !== 'foreground-faces-and-speaker' ||
      a.ownerAcceptanceSha256 !== FACE_V9_OWNER_ACCEPTANCE_SHA256 ||
      !sha(a.v9ReceiptSha256) || !sha(a.v9PreregistrationSha256) ||
      a.independentConfirmation !== 'not-performed' ||
      (parity.status !== 'pending' && parity.status !== 'passed') ||
      (parity.status === 'passed' ? !sha(parity.receiptSha256) : parity.receiptSha256 !== null)) {
    invalid('Face assessment cannot grant approval beyond the owner-accepted scope')
  }
}

/** Seals one window of sampled V9 detections. Detection, or a successful operation, grants no face safety. */
export function createFaceProducerEnvelopeV2(input: FaceProducerEnvelopeV2Input): FaceProducerEnvelopeV2 {
  keys(input, ['id', 'workspaceId', 'projectId', 'projectVersionId', 'operationId', 'operationAttempt',
    'operationFenceHash', 'sourceArtifactId', 'sourceSha256', 'editPlanSnapshotId', 'editPlanSnapshotHash',
    'timelineDurationFrames', 'timelineFps', 'sourceFps', 'sourceTimebase', 'sourceClock', 'sourcePtsStart',
    'sourcePtsRounding', 'sourceWidth', 'sourceHeight', 'sourceOrientation', 'timeMap', 'window', 'policyId',
    'policySha256', 'detectorConfig', 'producer', 'samplePolicy', 'samples', 'gaps', 'createdAt'], 'Face envelope')
  for (const [name, value] of Object.entries({ id: input.id, workspaceId: input.workspaceId,
    projectId: input.projectId, projectVersionId: input.projectVersionId, operationId: input.operationId,
    sourceArtifactId: input.sourceArtifactId, editPlanSnapshotId: input.editPlanSnapshotId })) {
    if (typeof value !== 'string' || !ID.test(value)) invalid(`${name} is invalid`)
  }
  for (const [name, value] of Object.entries({ operationFenceHash: input.operationFenceHash,
    sourceSha256: input.sourceSha256, editPlanSnapshotHash: input.editPlanSnapshotHash })) {
    if (!sha(value)) invalid(`${name} must be SHA-256`)
  }
  if (input.policyId !== FACE_EVIDENCE_POLICY.id || input.policySha256 !== FACE_EVIDENCE_POLICY_SHA256) {
    invalid('Face envelope is not sealed under the pinned face evidence policy')
  }
  for (const [label, clock] of [['Source fps', input.sourceFps], ['Timeline fps', input.timelineFps],
    ['Source timebase', input.sourceTimebase]] as const) {
    keys(clock, ['num', 'den'], label)
    if (!frame(clock.num) || clock.num === 0 || !frame(clock.den) || clock.den === 0) invalid('Source or timeline clock is invalid')
  }
  if (!frame(input.timelineDurationFrames) || input.timelineDurationFrames === 0 ||
      input.timelineDurationFrames > FACE_ENVELOPE_V2_MAX_TIMELINE_FRAMES ||
      !frame(input.sourcePtsStart) || !frame(input.operationAttempt) || input.operationAttempt === 0 ||
      input.sourceClock !== 'constant-frame-rate' || input.sourcePtsRounding !== 'nearest' ||
      !frame(input.sourceWidth) || !frame(input.sourceHeight) || input.sourceWidth === 0 || input.sourceHeight === 0 ||
      input.sourceWidth > 8192 || input.sourceHeight > 8192 || input.sourceWidth * input.sourceHeight > 16_000_000 ||
      input.sourceOrientation !== 'rotation-0-exif-neutral' || typeof input.createdAt !== 'string' ||
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
      !Number.isFinite(ticksPerFrame) || ticksPerFrame < 1) invalid('Source PTS cannot resolve individual frames')
  validateDetectorConfig(input.detectorConfig)
  validateProducer(input.producer)
  keys(input.samplePolicy, ['strategy', 'intervalFrames', 'maxSamples'], 'Face sample policy')
  const interval = input.samplePolicy.intervalFrames
  if (input.samplePolicy.strategy !== 'fixed-interval' || !frame(interval) || interval === 0 ||
      input.samplePolicy.maxSamples !== FACE_ENVELOPE_V2_MAX_SAMPLES ||
      input.samples.length > FACE_ENVELOPE_V2_MAX_SAMPLES) invalid('Face sample policy is invalid')

  // A single unit-rate clip covers the whole timeline; the window is the part of it this envelope observes.
  if (input.timeMap.length !== 1) invalid('Face time map must be exactly one unit-rate clip')
  const range = input.timeMap[0]!
  keys(range, ['clipId', 'sourceInFrame', 'sourceOutFrame', 'timelineInFrame', 'timelineOutFrame', 'rate'], 'Face time-map range')
  if (typeof range.clipId !== 'string' || !ID.test(range.clipId) || !frame(range.sourceInFrame) ||
      !frame(range.sourceOutFrame) || range.rate !== 1 || range.timelineInFrame !== 0 ||
      range.timelineOutFrame !== input.timelineDurationFrames || range.sourceOutFrame <= range.sourceInFrame ||
      range.sourceOutFrame - range.sourceInFrame !== range.timelineOutFrame - range.timelineInFrame) {
    invalid('Face time map must be one contiguous, unit-rate, frame-exact clip covering the timeline')
  }
  keys(input.window, ['startTimelineFrame', 'endTimelineFrame'], 'Face window')
  const { startTimelineFrame: start, endTimelineFrame: end } = input.window
  if (!frame(start) || !frame(end) || end <= start || end > input.timelineDurationFrames ||
      end - start > faceWindowFrames(interval)) invalid('Face window is invalid')

  let previousTimelineFrame = -1
  for (const sample of input.samples) {
    keys(sample, ['sourceFrame', 'sourcePts', 'sourcePtsEvidenceHash', 'timelineFrame', 'imageSha256', 'frameWidth',
      'frameHeight', 'status', 'boxes', 'rawOutput', 'reasonCode'], 'Face sample')
    const scaledTicks = sample.sourceFrame * ticksNumerator
    const expectedPts = Math.round(input.sourcePtsStart + scaledTicks / ticksDenominator)
    if (!frame(sample.sourceFrame) || !frame(sample.sourcePts) || !frame(sample.timelineFrame) ||
        sample.timelineFrame <= previousTimelineFrame || sample.timelineFrame < start || sample.timelineFrame >= end ||
        sample.sourceFrame % interval !== 0 || !sha(sample.sourcePtsEvidenceHash) || !sha(sample.imageSha256) ||
        sample.frameWidth !== input.sourceWidth || sample.frameHeight !== input.sourceHeight ||
        !Number.isSafeInteger(scaledTicks) || !Number.isSafeInteger(expectedPts) ||
        Math.abs(sample.sourcePts - expectedPts) > 1 ||
        sample.sourceFrame < range.sourceInFrame || sample.sourceFrame >= range.sourceOutFrame ||
        sample.timelineFrame !== range.timelineInFrame + sample.sourceFrame - range.sourceInFrame ||
        (sample.status !== 'observed' && sample.status !== 'unknown') ||
        sample.boxes.length > FACE0204_OUTPUT_SLOTS) invalid('Face sample or source mapping is invalid')
    previousTimelineFrame = sample.timelineFrame
    if (sample.rawOutput !== null) {
      keys(sample.rawOutput, ['sha256', 'bytes'], 'Face raw output')
      if (!sha(sample.rawOutput.sha256) || sample.rawOutput.bytes !== FACE0204_OUTPUT_BYTES) invalid('Face raw output reference is invalid')
    }
    if (sample.status === 'unknown') {
      if (typeof sample.reasonCode !== 'string' || !REASON.test(sample.reasonCode) || sample.boxes.length !== 0) {
        invalid('Unknown face sample cannot contain boxes')
      }
    } else {
      if (sample.reasonCode !== null) invalid('Observed face sample cannot carry an error')
      if (sample.rawOutput === null) invalid('Observed face sample must bind its raw detector output')
    }
    for (const box of sample.boxes) {
      keys(box, ['boxXYXY', 'confidence', 'clipped', 'classification'], 'Face box')
      const coords = box.boxXYXY
      if (!Array.isArray(coords) || coords.length !== 4 ||
          coords.some((value) => typeof value !== 'number' || !Number.isFinite(value) || value < 0 || value > 1) ||
          coords[0] >= coords[2] || coords[1] >= coords[3] ||
          typeof box.confidence !== 'number' || !Number.isFinite(box.confidence) ||
          box.confidence < FACE_EVIDENCE_POLICY.detection.collectionScoreFloor || box.confidence > 1 ||
          typeof box.clipped !== 'boolean' || box.classification !== 'unverified-face-candidate') {
        invalid('Face box is invalid')
      }
    }
  }
  if (input.gaps.length > input.samples.length + 1) invalid('Face gap count is invalid')
  const coverage: Array<readonly [number, number]> = input.samples.map((sample) =>
    [sample.timelineFrame, sample.timelineFrame + 1] as const)
  for (const gap of input.gaps) {
    keys(gap, ['startTimelineFrame', 'endTimelineFrame', 'reasonCode'], 'Face gap')
    if (!frame(gap.startTimelineFrame) || !frame(gap.endTimelineFrame) || gap.startTimelineFrame >= gap.endTimelineFrame ||
        gap.startTimelineFrame < start || gap.endTimelineFrame > end ||
        typeof gap.reasonCode !== 'string' || !REASON.test(gap.reasonCode)) invalid('Face gap is invalid')
    coverage.push([gap.startTimelineFrame, gap.endTimelineFrame])
  }
  coverage.sort((a, b) => a[0] - b[0])
  if (coverage[0]?.[0] !== start || coverage.at(-1)?.[1] !== end ||
      coverage.some((rangeItem, index) => index > 0 && rangeItem[0] !== coverage[index - 1]![1])) {
    invalid('Face samples and gaps must exactly cover the window')
  }
  const content = freeze({
    ...JSON.parse(stableSerialize(input)) as FaceProducerEnvelopeV2Input,
    schemaVersion: 'face-producer-envelope/v2' as const,
    authority: 'server-produced' as const,
    coverage: 'sampled-only' as const,
    faceSafety: 'unknown' as const,
    identity: 'not-performed' as const,
    timeMapHash: calculateCanonicalHash(input.timeMap),
    detectorConfigHash: calculateCanonicalHash(input.detectorConfig),
  })
  return freeze({ ...content, envelopeHash: calculateCanonicalHash(content) })
}

/** Re-derives a sample's boxes from its retained raw detector output; false means the evidence was not produced from it. */
export function faceSampleMatchesRawOutput(sample: Pick<FaceSampleV2, 'status' | 'boxes' | 'rawOutput'>, raw: Uint8Array): boolean {
  if (sample.rawOutput === null || raw.byteLength !== FACE0204_OUTPUT_BYTES) return false
  const decoded = decodeFace0204Output(raw, FACE_EVIDENCE_POLICY.detection.collectionScoreFloor)
  if (sample.status === 'unknown') return decoded.status === 'failed'
  if (decoded.status !== 'decoded' || decoded.detections.length !== sample.boxes.length) return false
  return decoded.detections.every((detection, index) => {
    const box = sample.boxes[index]!
    return detection.confidence === box.confidence && detection.clipped === box.clipped &&
      detection.boxXYXY.every((value, edge) => value === box.boxXYXY[edge])
  })
}
