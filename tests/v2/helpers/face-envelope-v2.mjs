import { createHash } from 'node:crypto'

import { decodeFace0204Output, FACE0204_OUTPUT_POLICY_ID, FACE0204_OUTPUT_POLICY_SHA256 } from '../../../src/v2/domain/face-detector-output.ts'
import { FACE_EVIDENCE_POLICY, FACE_EVIDENCE_POLICY_SHA256, FACE_V9_OWNER_ACCEPTANCE_SHA256 } from '../../../src/v2/domain/face-evidence-policy.ts'
import { ACCEPTED_FACE_PRODUCERS } from '../../../src/v2/domain/face-producer-registry.ts'

export const sha = (digit) => digit.repeat(64)
const hash = (value) => createHash('sha256').update(value).digest('hex')

/** A 5600-byte detector output with the given rows [score, xmin, ymin, xmax, ymax]; unused slots are padding. */
export function tensor(rows) {
  const bytes = new Uint8Array(5600)
  const view = new DataView(bytes.buffer)
  for (let slot = 0; slot < 200; slot += 1) {
    const row = rows[slot]
    const values = row ? [0, 0, ...row] : [-1, 0, 0, 0, 0, 0, 0]
    values.forEach((value, index) => view.setFloat32((slot * 7 + index) * 4, value, true))
  }
  return bytes
}

/** One observed sample whose boxes are exactly what the V9 decoder derives from its raw output. */
export function observedSample({ timelineFrame, sourceFrame = timelineFrame, rows = [], width = 1280, height = 720, pts }) {
  const raw = tensor(rows)
  const decoded = decodeFace0204Output(raw, FACE_EVIDENCE_POLICY.detection.collectionScoreFloor)
  if (decoded.status !== 'decoded') throw new Error('fixture tensor is invalid')
  return {
    sample: {
      sourceFrame, sourcePts: pts ?? sourceFrame * 512, sourcePtsEvidenceHash: sha('8'), timelineFrame,
      imageSha256: hash(`image-${sourceFrame}`), frameWidth: width, frameHeight: height, status: 'observed',
      boxes: decoded.detections.map((d) => ({ boxXYXY: [...d.boxXYXY], confidence: d.confidence, clipped: d.clipped,
        classification: 'unverified-face-candidate' })),
      rawOutput: { sha256: hash(raw), bytes: 5600 }, reasonCode: null,
    },
    raw,
  }
}

export function unknownSample({ timelineFrame, sourceFrame = timelineFrame, reasonCode = 'DETECTOR_OUTPUT_INVALID', width = 1280, height = 720 }) {
  return { sourceFrame, sourcePts: sourceFrame * 512, sourcePtsEvidenceHash: sha('8'), timelineFrame,
    imageSha256: hash(`image-${sourceFrame}`), frameWidth: width, frameHeight: height, status: 'unknown', boxes: [],
    rawOutput: null, reasonCode }
}

export function acceptedProducer(platform = 'win32') {
  const accepted = ACCEPTED_FACE_PRODUCERS[0]
  const entry = accepted.platforms.find((candidate) => candidate.platform === platform) ?? accepted.platforms[0]
  return {
    name: accepted.name,
    model: { precision: 'FP32', ...accepted.model },
    outputPolicy: { id: FACE0204_OUTPUT_POLICY_ID, sha256: FACE0204_OUTPUT_POLICY_SHA256 },
    runtime: { platform, pythonVersion: entry.pythonVersion, openvinoVersion: entry.openvinoVersion,
      openvinoPackageVersion: entry.openvinoPackageVersion, opencvVersion: entry.opencvVersion,
      numpyVersion: entry.numpyVersion, runtimeManifestSha256: sha('5') },
    adapterSha256: sha('1'), bridgeSha256: sha('2'), pythonExecutableSha256: sha('3'),
    ffmpegSha256: sha('4'), ffprobeSha256: sha('6'),
    assessment: { status: 'owner-accepted-scoped', scope: 'foreground-faces-and-speaker',
      ownerAcceptanceSha256: FACE_V9_OWNER_ACCEPTANCE_SHA256,
      v9ReceiptSha256: accepted.v9ReceiptSha256, v9PreregistrationSha256: accepted.v9PreregistrationSha256,
      independentConfirmation: 'not-performed',
      runtimeParity: { status: 'passed', receiptSha256: entry.parityReceiptSha256 } },
  }
}

export const detectorConfig = Object.freeze({
  family: 'openvino-ssd', model: 'face-detection-0204', inputWidth: 448, inputHeight: 448, colorOrder: 'bgr',
  tensorLayout: 'nchw', tensorType: 'float32', pixelRange: '0-255', resize: 'direct-bilinear',
  orientationPolicy: 'ignore-exif-after-source-validation', frameEncoding: 'png-lossless', backend: 'openvino-cpu',
  precision: 'f32', threads: 2, streams: 1, outputSlots: 200, outputBytes: 5600, collectionScoreFloor: 0.2,
})

/** Builds a sealed-envelope input for [start, end) of a 30 fps timeline sampled every 5 frames (6 Hz). */
export function envelopeInput({ start = 0, end = 150, samples, timelineDurationFrames = 300, interval = 5, producer = acceptedProducer(),
  overrides = {} } = {}) {
  const built = samples ?? Array.from({ length: Math.ceil((end - start) / interval) }, (_unused, index) =>
    observedSample({ timelineFrame: start + index * interval }).sample)
  const gaps = []
  let cursor = start
  for (const sample of built) {
    if (sample.timelineFrame > cursor) gaps.push({ startTimelineFrame: cursor, endTimelineFrame: sample.timelineFrame, reasonCode: 'NOT_SAMPLED' })
    cursor = sample.timelineFrame + 1
  }
  if (cursor < end) gaps.push({ startTimelineFrame: cursor, endTimelineFrame: end, reasonCode: 'NOT_SAMPLED' })
  return {
    id: 'face-envelope-v2-1', workspaceId: 'workspace-1', projectId: 'project-1', projectVersionId: 'version-1',
    operationId: 'operation-1', operationAttempt: 1, operationFenceHash: sha('a'), sourceArtifactId: 'source-1',
    sourceSha256: sha('b'), editPlanSnapshotId: 'edit-plan-1', editPlanSnapshotHash: sha('c'),
    timelineDurationFrames, timelineFps: { num: 30, den: 1 }, sourceFps: { num: 30, den: 1 },
    sourceTimebase: { num: 1, den: 15360 }, sourceClock: 'constant-frame-rate', sourcePtsStart: 0,
    sourcePtsRounding: 'nearest', sourceWidth: 1280, sourceHeight: 720, sourceOrientation: 'rotation-0-exif-neutral',
    timeMap: [{ clipId: 'clip-1', sourceInFrame: 0, sourceOutFrame: timelineDurationFrames, timelineInFrame: 0,
      timelineOutFrame: timelineDurationFrames, rate: 1 }],
    window: { startTimelineFrame: start, endTimelineFrame: end },
    policyId: FACE_EVIDENCE_POLICY.id, policySha256: FACE_EVIDENCE_POLICY_SHA256,
    detectorConfig: { ...detectorConfig }, producer,
    samplePolicy: { strategy: 'fixed-interval', intervalFrames: interval, maxSamples: 60 },
    samples: built, gaps, createdAt: '2026-10-18T00:00:00.000Z', ...overrides,
  }
}
