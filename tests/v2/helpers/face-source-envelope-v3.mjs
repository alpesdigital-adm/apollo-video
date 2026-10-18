import { createFaceProducerEnvelopeV3 } from '../../../src/v2/domain/face-producer-envelope-v3.ts'
import { FACE_EVIDENCE_POLICY, FACE_EVIDENCE_POLICY_SHA256 } from '../../../src/v2/domain/face-evidence-policy.ts'
import { acceptedProducer, detectorConfig, observedSample, sha, unknownSample } from './face-envelope-v2.mjs'

/**
 * W65b fixtures of the SOURCE-keyed face window envelope (`face-producer-envelope/v3`): no project, no version, no EditPlan, no
 * time map - only the source, its clock, a window in SOURCE frames and the samples. A 30 fps source sampled every 5 frames.
 */
const strip = ({ timelineFrame: _timeline, ...rest }) => rest

/** One observed sample of source frame `sourceFrame`, with the given detector rows (score, xmin, ymin, xmax, ymax). */
export function sourceSample({ sourceFrame, rows = [], width = 1280, height = 720 }) {
  return strip(observedSample({ timelineFrame: sourceFrame, sourceFrame, rows, width, height }).sample)
}
export function sourceUnknownSample({ sourceFrame, reasonCode = 'DETECTOR_OUTPUT_INVALID', width = 1280, height = 720 }) {
  return strip(unknownSample({ timelineFrame: sourceFrame, sourceFrame, reasonCode, width, height }))
}
/** The retained raw detector output of the same fixture sample. */
export function sourceSampleWithRaw({ sourceFrame, rows = [], width = 1280, height = 720 }) {
  const built = observedSample({ timelineFrame: sourceFrame, sourceFrame, rows, width, height })
  return { sample: strip(built.sample), raw: built.raw }
}

/** Sealed-envelope input for the source window [start, end), sampled every `interval` source frames. */
export function sourceWindowInput({ start = 0, end = 150, interval = 5, samples, producer = acceptedProducer(), overrides = {} } = {}) {
  const first = Math.ceil(start / interval) * interval
  const built = samples ?? Array.from({ length: Math.max(0, Math.ceil((end - first) / interval)) }, (_unused, index) =>
    sourceSample({ sourceFrame: first + index * interval }))
  const gaps = []
  let cursor = start
  for (const sample of built) {
    if (sample.sourceFrame > cursor) gaps.push({ startSourceFrame: cursor, endSourceFrame: sample.sourceFrame, reasonCode: 'NOT_SAMPLED' })
    cursor = sample.sourceFrame + 1
  }
  if (cursor < end) gaps.push({ startSourceFrame: cursor, endSourceFrame: end, reasonCode: 'NOT_SAMPLED' })
  return {
    id: 'face-source-envelope-1', workspaceId: 'workspace-1',
    operationId: 'operation-1', operationAttempt: 1, operationFenceHash: sha('a'),
    sourceArtifactId: 'source-1', sourceSha256: sha('b'),
    sourceFps: { num: 30, den: 1 }, sourceTimebase: { num: 1, den: 15360 }, sourceClock: 'constant-frame-rate', sourcePtsStart: 0,
    sourcePtsRounding: 'nearest', sourceWidth: 1280, sourceHeight: 720, sourceOrientation: 'rotation-0-exif-neutral',
    window: { startSourceFrame: start, endSourceFrame: end },
    policyId: FACE_EVIDENCE_POLICY.id, policySha256: FACE_EVIDENCE_POLICY_SHA256,
    detectorConfig: { ...detectorConfig }, producer,
    samplePolicy: { strategy: 'fixed-interval', intervalFrames: interval, maxSamples: 60 },
    samples: built, gaps, createdAt: '2026-10-18T00:00:00.000Z', ...overrides,
  }
}

/**
 * A sealed window envelope over source frames [start, end). `rowsAt(sourceFrame)` returns detector rows, or 'unknown' for a
 * failed frame; the default is an empty frame.
 */
export function sealedSourceWindow({ start = 0, end = 150, interval = 5, rowsAt = () => [], id = `face-source-envelope-${start}`,
  producer = acceptedProducer(), overrides = {} } = {}) {
  const samples = []
  for (let frame = Math.ceil(start / interval) * interval; frame < end; frame += interval) {
    const rows = rowsAt(frame)
    samples.push(rows === 'unknown' ? sourceUnknownSample({ sourceFrame: frame }) : sourceSample({ sourceFrame: frame, rows }))
  }
  return createFaceProducerEnvelopeV3({ ...sourceWindowInput({ start, end, interval, samples, producer }), id, ...overrides })
}

/** What a consumer expects of the source whose evidence it reads. */
export const sourceExpectation = (overrides = {}) => ({
  workspaceId: 'workspace-1', sourceArtifactId: 'source-1', sourceSha256: sha('b'), sourceFps: { num: 30, den: 1 },
  // an upper bound of the source frames any cue can ask about (the consumer takes it from the clips it plays)
  sourceDurationFrames: 300, ...overrides,
})
