// W66r fixtures: sealed face evidence streams built from GROUND-TRUTH boxes, the clips they are projected through, and the records the
// product builds from them. Under tsx a static named import of a TypeScript module is not visible to Node, so these are dynamic.
const { buildVariantReframePlanRecord } = await import('../../../src/v2/domain/variant-reframe-plan.ts')
const { FACE_EVIDENCE_POLICY_SHA256 } = await import('../../../src/v2/domain/face-evidence-policy.ts')

export const sha = (digit) => digit.repeat(64)
export const SAFE_AREA = Object.freeze({ top: 0.08, right: 0.06, bottom: 0.06, left: 0.06 })
export const SOURCE = Object.freeze({ artifactId: 'source-1', manifestId: 'manifest-1', sha256: sha('b'), width: 1280, height: 720 })
/** The size of a 9:16 crop of a 16:9 source, in normalized source units. */
export const VERTICAL_CROP = Object.freeze({ width: (9 / 16) / (16 / 9), height: 1 })

/** One observed sample: `boxes` are [x1, y1, x2, y2] normalized rows, optionally with a confidence as a fifth value. */
export function observedSample(sourceFrame, boxes = [], { envelope = sha('e'), confidence = 0.95 } = {}) {
  return {
    sourceFrame, status: 'observed',
    detections: boxes.map(([x1, y1, x2, y2, score]) => ({ boxXYXY: [x1, y1, x2, y2], confidence: score ?? confidence, clipped: false, classification: 'unverified-face-candidate' })),
    frameWidth: SOURCE.width, frameHeight: SOURCE.height, envelopeHash: envelope, imageSha256: sha('1'), rawOutputSha256: sha('2'),
  }
}
export function unknownSample(sourceFrame, envelope = sha('e')) {
  return { sourceFrame, status: 'unknown', detections: [], frameWidth: SOURCE.width, frameHeight: SOURCE.height, envelopeHash: envelope, imageSha256: sha('1'), rawOutputSha256: null }
}

/**
 * The evidence stream `collectFaceSourceEvidenceStream` would answer for these samples. `windows` are the trusted envelope windows
 * (default: one over the whole duration), `untrusted` the windows whose seal was refused.
 */
export function faceStream(samples, { duration = 300, windows, untrusted = [], streamHash = sha('9') } = {}) {
  return {
    schemaVersion: 'face-source-evidence-stream/v1', policySha256: FACE_EVIDENCE_POLICY_SHA256, sourceArtifactId: SOURCE.artifactId, sourceSha256: SOURCE.sha256,
    sourceFps: { num: 30, den: 1 }, sourceDurationFrames: duration, samples,
    trustedWindows: windows ?? [{ envelopeHash: sha('e'), startSourceFrame: 0, endSourceFrame: duration }], untrusted, streamHash,
  }
}

/** Samples every `stride` source frames in [from, to) whose boxes come from `boxesAt(sourceFrame)` (or 'unknown'). */
export function sampledStream(boxesAt, { from = 0, to = 150, stride = 5, duration = Math.max(to, 150), ...rest } = {}) {
  const samples = []
  for (let frame = from; frame < to; frame += stride) {
    const boxes = boxesAt(frame)
    samples.push(boxes === 'unknown' ? unknownSample(frame) : observedSample(frame, boxes))
  }
  return faceStream(samples, { duration, ...rest })
}

/** A face-sized box whose left edge is `x` (normalized). */
export const faceAt = (x, y = 0.2, width = 0.1, height = 0.3) => [x, y, x + width, y + height]

export const clipFacts = (overrides = {}) => ({
  clipId: 'clip-1', sourceArtifactId: SOURCE.artifactId, sourceSha256: SOURCE.sha256, sourceWidth: SOURCE.width, sourceHeight: SOURCE.height,
  sourceInFrame: 0, sourceOutFrame: 150, timelineInFrame: 0, timelineOutFrame: 150, rate: 1, fps: 30, hasStaticCrop: false, ...overrides,
})

export const SPECS = Object.freeze({
  vertical: Object.freeze({ variantId: 'variant-vertical-1', outputSpecRevisionId: 'revision-vertical-1', specHash: sha('c'), aspectRatio: '9:16', safeArea: SAFE_AREA, width: 1080, height: 1920, fps: 30 }),
  wide: Object.freeze({ variantId: 'variant-wide-1', outputSpecRevisionId: 'revision-wide-1', specHash: sha('d'), aspectRatio: '16:9', safeArea: SAFE_AREA, width: 1920, height: 1080, fps: 30 }),
})

/** The record the product builds for one variant over `clips` and `stream`. */
export function buildRecord({ spec = SPECS.vertical, stream, clips = [clipFacts()], durationFrames = Math.max(...clips.map((clip) => clip.timelineOutFrame)),
  overrideHeads = [], observationSetId = `observations-${spec.variantId}` } = {}) {
  return buildVariantReframePlanRecord({
    workspaceId: 'workspace-1', projectId: 'project-1', variantId: spec.variantId,
    spec: { outputSpecRevisionId: spec.outputSpecRevisionId, specHash: spec.specHash, aspectRatio: spec.aspectRatio, safeArea: spec.safeArea, width: spec.width, height: spec.height, fps: spec.fps },
    timeline: { fps: 30, durationFrames }, source: SOURCE, clips, stream, overrideHeads, observationSetId,
  })
}

/** Normalized crop of `keyframes` at `frame`, with the same arithmetic as the renderer's expression (linear between keyframes, held after the last). */
export function cropAt(range, frame) {
  let previous = range.keyframes[0]
  let next
  for (const keyframe of range.keyframes) {
    if (keyframe.frame <= frame) previous = keyframe
    else { next = keyframe; break }
  }
  if (!next) return { ...previous.crop }
  const ratio = (frame - previous.frame) / (next.frame - previous.frame)
  return { x: previous.crop.x + (next.crop.x - previous.crop.x) * ratio, y: previous.crop.y + (next.crop.y - previous.crop.y) * ratio, width: previous.crop.width, height: previous.crop.height }
}

/** Independent check: the crop shows [box +/- margin] entirely. */
export const cropShows = (crop, box, margin) =>
  box[0] - margin >= crop.x - 1e-9 && box[1] - margin >= crop.y - 1e-9 &&
  box[2] + margin <= crop.x + crop.width + 1e-9 && box[3] + margin <= crop.y + crop.height + 1e-9
