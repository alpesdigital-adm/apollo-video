import { calculateCanonicalHash } from './canonical-hash.ts'
import { FACE_EVIDENCE_POLICY_SHA256 } from './face-evidence-policy.ts'
import type { FaceEvidenceSample, FaceEvidenceStream } from './face-evidence-stream.ts'
import { faceSourceEnvelopeSealIntact, type FaceProducerEnvelopeV3 } from './face-producer-envelope-v3.ts'
import type { FaceBoxV2 } from './face-producer-envelope-v2.ts'
import { authenticateFaceEnvelope } from './face-producer-registry.ts'

/**
 * The trusted, merged face evidence of one SOURCE, in SOURCE frames (W65b): the samples of every window envelope that is
 * sealed, authenticated, about exactly these bytes and this clock, and not contradicted by another window.
 *
 * It knows nothing about an edit. A consumer projects a cue through its own clips into a range of source frames and asks the
 * same clearance question there (`sourceStreamForClearance` renames the frame fields and nothing else).
 *
 * Evidence that fails any test is not dropped silently and not used: it is listed as `untrusted` with its reasons and its
 * source-frame range, so a consumer treats that range as unknown instead of as empty.
 */
export type FaceSourceEvidenceExpectation = Readonly<{
  workspaceId: string
  sourceArtifactId: string
  sourceSha256: string
  sourceFps: Readonly<{ num: number; den: number }>
  /** Upper bound of the source frames a consumer can ask about (the clips it plays); a cue never reaches past it. */
  sourceDurationFrames: number
}>
export type FaceSourceEvidenceSample = Readonly<{
  sourceFrame: number
  status: 'observed' | 'unknown'
  detections: readonly FaceBoxV2[]
  frameWidth: number; frameHeight: number
  /** Content address of the window envelope this sample came from. */
  envelopeHash: string
  imageSha256: string; rawOutputSha256: string | null
}>
export type UntrustedFaceSourceEvidence = Readonly<{ envelopeHash: string; startSourceFrame: number; endSourceFrame: number; reasons: readonly string[] }>
export type FaceSourceEvidenceStream = Readonly<{
  schemaVersion: 'face-source-evidence-stream/v1'
  policySha256: string
  sourceArtifactId: string
  sourceSha256: string
  sourceFps: Readonly<{ num: number; den: number }>
  sourceDurationFrames: number
  samples: readonly FaceSourceEvidenceSample[]
  trustedWindows: readonly Readonly<{ envelopeHash: string; startSourceFrame: number; endSourceFrame: number }>[]
  untrusted: readonly UntrustedFaceSourceEvidence[]
  streamHash: string
}>

function expectationReasons(envelope: FaceProducerEnvelopeV3, expected: FaceSourceEvidenceExpectation): string[] {
  const reasons: string[] = []
  if (envelope.workspaceId !== expected.workspaceId) reasons.push('SCOPE_MISMATCH')
  if (envelope.sourceArtifactId !== expected.sourceArtifactId || envelope.sourceSha256 !== expected.sourceSha256) reasons.push('SOURCE_MISMATCH')
  if (envelope.sourceFps.num * expected.sourceFps.den !== expected.sourceFps.num * envelope.sourceFps.den) reasons.push('CLOCK_MISMATCH')
  if (envelope.policySha256 !== FACE_EVIDENCE_POLICY_SHA256) reasons.push('POLICY_MISMATCH')
  return reasons
}

const sampleKey = (sample: FaceSourceEvidenceSample) => calculateCanonicalHash({
  status: sample.status, detections: sample.detections, imageSha256: sample.imageSha256, rawOutputSha256: sample.rawOutputSha256,
})

export function collectFaceSourceEvidenceStream(envelopes: readonly FaceProducerEnvelopeV3[], expected: FaceSourceEvidenceExpectation): FaceSourceEvidenceStream {
  const ordered = [...envelopes].sort((left, right) => left.window.startSourceFrame - right.window.startSourceFrame ||
    left.envelopeHash.localeCompare(right.envelopeHash))
  const reasonsByEnvelope = new Map<string, string[]>()
  for (const envelope of ordered) {
    const reasons = reasonsByEnvelope.get(envelope.envelopeHash) ?? []
    reasonsByEnvelope.set(envelope.envelopeHash, reasons)
    if (envelope.schemaVersion !== 'face-producer-envelope/v3' || !faceSourceEnvelopeSealIntact(envelope)) reasons.push('ENVELOPE_SEAL_INVALID')
    else {
      reasons.push(...expectationReasons(envelope, expected))
      const authentication = authenticateFaceEnvelope(envelope)
      if (!authentication.authenticated) reasons.push(...authentication.reasons.map((reason) => `PRODUCER_${reason}`))
    }
  }
  // Windows may overlap; a frame seen twice must be seen identically or both windows are contradicted.
  const seen = new Map<number, { key: string; envelopeHash: string }>()
  for (const envelope of ordered) {
    if (reasonsByEnvelope.get(envelope.envelopeHash)!.length > 0) continue
    for (const sample of envelope.samples) {
      const candidate: FaceSourceEvidenceSample = Object.freeze({ sourceFrame: sample.sourceFrame, status: sample.status,
        detections: sample.boxes, frameWidth: sample.frameWidth, frameHeight: sample.frameHeight,
        envelopeHash: envelope.envelopeHash, imageSha256: sample.imageSha256, rawOutputSha256: sample.rawOutput?.sha256 ?? null })
      const previous = seen.get(sample.sourceFrame)
      if (previous && previous.key !== sampleKey(candidate)) {
        for (const hash of [previous.envelopeHash, envelope.envelopeHash]) {
          const reasons = reasonsByEnvelope.get(hash)!
          if (!reasons.includes('EVIDENCE_CONFLICT')) reasons.push('EVIDENCE_CONFLICT')
        }
      }
      if (!previous) seen.set(sample.sourceFrame, { key: sampleKey(candidate), envelopeHash: envelope.envelopeHash })
    }
  }
  const samples = new Map<number, FaceSourceEvidenceSample>()
  const trustedWindows: Array<{ envelopeHash: string; startSourceFrame: number; endSourceFrame: number }> = []
  const untrusted: UntrustedFaceSourceEvidence[] = []
  const unique = new Set<string>()
  for (const envelope of ordered) {
    if (unique.has(envelope.envelopeHash)) continue
    unique.add(envelope.envelopeHash)
    const reasons = reasonsByEnvelope.get(envelope.envelopeHash)!
    const window = envelope.window
    if (reasons.length > 0) {
      untrusted.push(Object.freeze({ envelopeHash: envelope.envelopeHash, startSourceFrame: window.startSourceFrame,
        endSourceFrame: window.endSourceFrame, reasons: Object.freeze([...new Set(reasons)].sort()) }))
      continue
    }
    trustedWindows.push({ envelopeHash: envelope.envelopeHash, startSourceFrame: window.startSourceFrame, endSourceFrame: window.endSourceFrame })
    for (const sample of envelope.samples) {
      if (!samples.has(sample.sourceFrame)) samples.set(sample.sourceFrame, Object.freeze({
        sourceFrame: sample.sourceFrame, status: sample.status, detections: sample.boxes,
        frameWidth: sample.frameWidth, frameHeight: sample.frameHeight, envelopeHash: envelope.envelopeHash,
        imageSha256: sample.imageSha256, rawOutputSha256: sample.rawOutput?.sha256 ?? null }))
    }
  }
  const body = {
    schemaVersion: 'face-source-evidence-stream/v1' as const,
    policySha256: FACE_EVIDENCE_POLICY_SHA256,
    sourceArtifactId: expected.sourceArtifactId,
    sourceSha256: expected.sourceSha256,
    sourceFps: Object.freeze({ ...expected.sourceFps }),
    sourceDurationFrames: expected.sourceDurationFrames,
    samples: Object.freeze([...samples.values()].sort((a, b) => a.sourceFrame - b.sourceFrame)),
    trustedWindows: Object.freeze(trustedWindows.map((window) => Object.freeze(window))),
    untrusted: Object.freeze(untrusted),
  }
  return Object.freeze({ ...body, streamHash: calculateCanonicalHash(body) })
}

/**
 * The same evidence in the shape `evaluateFaceCaptionClearance` reads. Its "timeline" IS the source timeline: frame fields are
 * renamed and nothing else changes, so the W62 coverage, gap, dilation and precedence rules apply to the source unmodified.
 */
export function sourceStreamForClearance(stream: FaceSourceEvidenceStream): FaceEvidenceStream {
  return Object.freeze({
    schemaVersion: 'face-evidence-stream/v1' as const,
    policySha256: stream.policySha256,
    timelineDurationFrames: stream.sourceDurationFrames,
    timelineFps: stream.sourceFps,
    samples: Object.freeze(stream.samples.map((sample): FaceEvidenceSample => Object.freeze({
      timelineFrame: sample.sourceFrame, status: sample.status, detections: sample.detections,
      frameWidth: sample.frameWidth, frameHeight: sample.frameHeight, envelopeHash: sample.envelopeHash,
      imageSha256: sample.imageSha256, rawOutputSha256: sample.rawOutputSha256,
    }))),
    trustedWindows: Object.freeze(stream.trustedWindows.map((window) => Object.freeze({
      envelopeHash: window.envelopeHash, startFrame: window.startSourceFrame, endFrame: window.endSourceFrame }))),
    untrusted: Object.freeze(stream.untrusted.map((entry) => Object.freeze({
      envelopeHash: entry.envelopeHash, startFrame: entry.startSourceFrame, endFrame: entry.endSourceFrame, reasons: entry.reasons }))),
    streamHash: stream.streamHash,
  })
}
