import { calculateCanonicalHash, stableSerialize } from './canonical-hash.ts'
import { FACE0204_OUTPUT_BYTES, FACE0204_OUTPUT_SLOTS } from './face-detector-output.ts'
import {
  FACE_EVIDENCE_POLICY, FACE_EVIDENCE_POLICY_SHA256, faceSampleIntervalFrames, faceWindowFrames,
} from './face-evidence-policy.ts'
import {
  freeze, frame, invalid, keys, sha, validateDetectorConfig, validateProducer,
  type FaceBoxV2, type FaceDetectorConfigV2, type FaceProducerV2,
} from './face-producer-envelope-v2.ts'

/**
 * Sealed face evidence of one window of the SOURCE artifact's own timeline (W65b), produced by the owner-accepted V9 detector.
 *
 * The v2 envelope (W62) was bound to one EditPlan: project, version, snapshot, time map, and a timeline that had to be exactly one
 * real-time clip of the source. This one is bound to the only thing the evidence is actually a function of - the bytes of the
 * source (`sourceArtifactId` + `sourceSha256`), the clock the analyzer measured on them, the window of SOURCE frames observed,
 * the pinned policy, the detector configuration and the producer. An edit later projects it through its own clips.
 *
 * It is evidence, not authority: coverage is sampled, `faceSafety` stays `unknown`, nothing is identified, and the assessment is
 * the owner's scoped acceptance (foreground faces and the speaker), never a qualification.
 */
const ID = /^[A-Za-z0-9][A-Za-z0-9._:-]{0,127}$/
const REASON = /^[A-Z][A-Z0-9_]{2,63}$/

type Rational = Readonly<{ num: number; den: number }>
export type FaceSampleV3 = Readonly<{
  sourceFrame: number; sourcePts: number; sourcePtsEvidenceHash: string
  imageSha256: string; frameWidth: number; frameHeight: number
  status: 'observed' | 'unknown'
  boxes: readonly FaceBoxV2[]
  /** SHA-256 and size of the raw detector output; null only when the detector produced none. */
  rawOutput: Readonly<{ sha256: string; bytes: 5600 }> | null
  reasonCode: string | null
}>
export type FaceSourceGapV3 = Readonly<{ startSourceFrame: number; endSourceFrame: number; reasonCode: string }>

export type FaceProducerEnvelopeV3Input = Readonly<{
  id: string; workspaceId: string
  /** Publication provenance (the fenced operation that sealed this window); not part of what the evidence is about. */
  operationId: string; operationAttempt: number; operationFenceHash: string
  sourceArtifactId: string; sourceSha256: string
  sourceFps: Rational; sourceTimebase: Rational
  sourceClock: 'constant-frame-rate'; sourcePtsStart: number; sourcePtsRounding: 'nearest'
  sourceWidth: number; sourceHeight: number; sourceOrientation: 'rotation-0-exif-neutral'
  /** Half-open interval of SOURCE frames. */
  window: Readonly<{ startSourceFrame: number; endSourceFrame: number }>
  policyId: string; policySha256: string
  detectorConfig: FaceDetectorConfigV2
  producer: FaceProducerV2
  samplePolicy: Readonly<{ strategy: 'fixed-interval'; intervalFrames: number; maxSamples: 60 }>
  samples: readonly FaceSampleV3[]
  gaps: readonly FaceSourceGapV3[]
  createdAt: string
}>
export type FaceProducerEnvelopeV3 = Readonly<FaceProducerEnvelopeV3Input & {
  schemaVersion: 'face-producer-envelope/v3'
  authority: 'server-produced'
  coverage: 'sampled-only'
  faceSafety: 'unknown'
  identity: 'not-performed'
  detectorConfigHash: string
  envelopeHash: string
}>

export const FACE_SOURCE_ENVELOPE_MAX_SOURCE_FRAMES = 100_000_000
export const FACE_SOURCE_ENVELOPE_MAX_WINDOW_FRAMES = FACE_EVIDENCE_POLICY.sampling.maxWindowFrames
export const FACE_SOURCE_ENVELOPE_MAX_SAMPLES = FACE_EVIDENCE_POLICY.sampling.maxSamplesPerWindow

/** Seals one window of sampled V9 detections over source frames. Detection, or a successful operation, grants no face safety. */
export function createFaceProducerEnvelopeV3(input: FaceProducerEnvelopeV3Input): FaceProducerEnvelopeV3 {
  keys(input, ['id', 'workspaceId', 'operationId', 'operationAttempt', 'operationFenceHash', 'sourceArtifactId', 'sourceSha256',
    'sourceFps', 'sourceTimebase', 'sourceClock', 'sourcePtsStart', 'sourcePtsRounding', 'sourceWidth', 'sourceHeight',
    'sourceOrientation', 'window', 'policyId', 'policySha256', 'detectorConfig', 'producer', 'samplePolicy', 'samples', 'gaps',
    'createdAt'], 'Face envelope')
  for (const [name, value] of Object.entries({ id: input.id, workspaceId: input.workspaceId, operationId: input.operationId,
    sourceArtifactId: input.sourceArtifactId })) {
    if (typeof value !== 'string' || !ID.test(value)) invalid(`${name} is invalid`)
  }
  for (const [name, value] of Object.entries({ operationFenceHash: input.operationFenceHash, sourceSha256: input.sourceSha256 })) {
    if (!sha(value)) invalid(`${name} must be SHA-256`)
  }
  if (input.policyId !== FACE_EVIDENCE_POLICY.id || input.policySha256 !== FACE_EVIDENCE_POLICY_SHA256) {
    invalid('Face envelope is not sealed under the pinned face evidence policy')
  }
  for (const [label, clock] of [['Source fps', input.sourceFps], ['Source timebase', input.sourceTimebase]] as const) {
    keys(clock, ['num', 'den'], label)
    if (!frame(clock.num) || clock.num === 0 || !frame(clock.den) || clock.den === 0) invalid('Source clock is invalid')
  }
  // Source frames are mapped onto an edit by an integer frame offset; that is only provable for an integer frame rate.
  if (input.sourceFps.den !== 1) invalid('Source clock is invalid: only an integer frame rate has a provable frame mapping')
  if (!frame(input.sourcePtsStart) || !frame(input.operationAttempt) || input.operationAttempt === 0 ||
      input.sourceClock !== 'constant-frame-rate' || input.sourcePtsRounding !== 'nearest' ||
      !frame(input.sourceWidth) || !frame(input.sourceHeight) || input.sourceWidth === 0 || input.sourceHeight === 0 ||
      input.sourceWidth > 8192 || input.sourceHeight > 8192 || input.sourceWidth * input.sourceHeight > 16_000_000 ||
      input.sourceOrientation !== 'rotation-0-exif-neutral' || typeof input.createdAt !== 'string' ||
      !Number.isFinite(Date.parse(input.createdAt))) invalid('Face producer context is invalid')
  const ticksNumerator = input.sourceFps.den * input.sourceTimebase.den
  const ticksDenominator = input.sourceFps.num * input.sourceTimebase.num
  const ticksPerFrame = ticksNumerator / ticksDenominator
  if (!Number.isSafeInteger(ticksNumerator) || !Number.isSafeInteger(ticksDenominator) ||
      !Number.isFinite(ticksPerFrame) || ticksPerFrame < 1) invalid('Source PTS cannot resolve individual frames')
  validateDetectorConfig(input.detectorConfig)
  validateProducer(input.producer)
  keys(input.samplePolicy, ['strategy', 'intervalFrames', 'maxSamples'], 'Face sample policy')
  const interval = input.samplePolicy.intervalFrames
  // The cadence is the pinned policy's cadence of THIS source's frame rate; it is never a free choice of the requester.
  if (input.samplePolicy.strategy !== 'fixed-interval' || !frame(interval) || interval === 0 ||
      interval !== faceSampleIntervalFrames(input.sourceFps) ||
      input.samplePolicy.maxSamples !== FACE_SOURCE_ENVELOPE_MAX_SAMPLES ||
      input.samples.length > FACE_SOURCE_ENVELOPE_MAX_SAMPLES) invalid('Face sample policy is invalid')

  keys(input.window, ['startSourceFrame', 'endSourceFrame'], 'Face window')
  const { startSourceFrame: start, endSourceFrame: end } = input.window
  if (!frame(start) || !frame(end) || end <= start || end > FACE_SOURCE_ENVELOPE_MAX_SOURCE_FRAMES ||
      end - start > faceWindowFrames(interval)) invalid('Face window is invalid')

  let previousSourceFrame = -1
  for (const sample of input.samples) {
    keys(sample, ['sourceFrame', 'sourcePts', 'sourcePtsEvidenceHash', 'imageSha256', 'frameWidth', 'frameHeight', 'status',
      'boxes', 'rawOutput', 'reasonCode'], 'Face sample')
    const scaledTicks = sample.sourceFrame * ticksNumerator
    const expectedPts = Math.round(input.sourcePtsStart + scaledTicks / ticksDenominator)
    if (!frame(sample.sourceFrame) || !frame(sample.sourcePts) ||
        sample.sourceFrame <= previousSourceFrame || sample.sourceFrame < start || sample.sourceFrame >= end ||
        sample.sourceFrame % interval !== 0 || !sha(sample.sourcePtsEvidenceHash) || !sha(sample.imageSha256) ||
        sample.frameWidth !== input.sourceWidth || sample.frameHeight !== input.sourceHeight ||
        !Number.isSafeInteger(scaledTicks) || !Number.isSafeInteger(expectedPts) ||
        Math.abs(sample.sourcePts - expectedPts) > 1 ||
        (sample.status !== 'observed' && sample.status !== 'unknown') ||
        sample.boxes.length > FACE0204_OUTPUT_SLOTS) invalid('Face sample or source mapping is invalid')
    previousSourceFrame = sample.sourceFrame
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
    [sample.sourceFrame, sample.sourceFrame + 1] as const)
  for (const gap of input.gaps) {
    keys(gap, ['startSourceFrame', 'endSourceFrame', 'reasonCode'], 'Face gap')
    if (!frame(gap.startSourceFrame) || !frame(gap.endSourceFrame) || gap.startSourceFrame >= gap.endSourceFrame ||
        gap.startSourceFrame < start || gap.endSourceFrame > end ||
        typeof gap.reasonCode !== 'string' || !REASON.test(gap.reasonCode)) invalid('Face gap is invalid')
    coverage.push([gap.startSourceFrame, gap.endSourceFrame])
  }
  coverage.sort((a, b) => a[0] - b[0])
  if (coverage[0]?.[0] !== start || coverage.at(-1)?.[1] !== end ||
      coverage.some((rangeItem, index) => index > 0 && rangeItem[0] !== coverage[index - 1]![1])) {
    invalid('Face samples and gaps must exactly cover the window')
  }
  const content = freeze({
    ...JSON.parse(stableSerialize(input)) as FaceProducerEnvelopeV3Input,
    schemaVersion: 'face-producer-envelope/v3' as const,
    authority: 'server-produced' as const,
    coverage: 'sampled-only' as const,
    faceSafety: 'unknown' as const,
    identity: 'not-performed' as const,
    detectorConfigHash: calculateCanonicalHash(input.detectorConfig),
  })
  return freeze({ ...content, envelopeHash: calculateCanonicalHash(content) })
}

/** True when the envelope's seal is intact: rebuilding it from its own content gives back the same hash. */
export function faceSourceEnvelopeSealIntact(envelope: FaceProducerEnvelopeV3): boolean {
  try {
    const { schemaVersion, authority, coverage, faceSafety, identity, detectorConfigHash, envelopeHash, ...input } = envelope
    void schemaVersion; void authority; void coverage; void faceSafety; void identity; void detectorConfigHash
    return createFaceProducerEnvelopeV3(input as FaceProducerEnvelopeV3Input).envelopeHash === envelopeHash
  } catch { return false }
}
