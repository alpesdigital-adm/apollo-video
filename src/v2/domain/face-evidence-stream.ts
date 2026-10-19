import { calculateCanonicalHash } from './canonical-hash.ts'
import { createFaceProducerEnvelopeV2, type FaceBoxV2, type FaceProducerEnvelopeV2 } from './face-producer-envelope-v2.ts'
import { authenticateFaceEnvelope } from './face-producer-registry.ts'
import { FACE_EVIDENCE_POLICY_SHA256 } from './face-evidence-policy.ts'

/**
 * The trusted, merged face evidence of one source clip on its timeline: the samples of every window envelope that
 * is sealed, authenticated, bound to the expected source/version/time map and not contradicted by another window.
 *
 * Evidence that fails any of those tests is not dropped silently and not used: it is listed as `untrusted` with
 * its reasons and its frame range, so a consumer treats that range as unknown instead of as empty.
 */
export type FaceEvidenceExpectation = Readonly<{
  workspaceId: string; projectId: string; projectVersionId: string
  sourceArtifactId: string; sourceSha256: string
  timeMapHash: string
  timelineDurationFrames: number
  timelineFps: Readonly<{ num: number; den: number }>
}>
export type FaceEvidenceSample = Readonly<{
  timelineFrame: number
  status: 'observed' | 'unknown'
  detections: readonly FaceBoxV2[]
  frameWidth: number; frameHeight: number
  /** Content address of the window envelope this sample came from. */
  envelopeHash: string
  imageSha256: string; rawOutputSha256: string | null
}>
export type UntrustedFaceEvidence = Readonly<{ envelopeHash: string; startFrame: number; endFrame: number; reasons: readonly string[] }>
export type FaceEvidenceStream = Readonly<{
  schemaVersion: 'face-evidence-stream/v1'
  policySha256: string
  timelineDurationFrames: number
  timelineFps: Readonly<{ num: number; den: number }>
  samples: readonly FaceEvidenceSample[]
  trustedWindows: readonly Readonly<{ envelopeHash: string; startFrame: number; endFrame: number }>[]
  untrusted: readonly UntrustedFaceEvidence[]
  streamHash: string
}>

function sealIntact(envelope: FaceProducerEnvelopeV2): boolean {
  try {
    const { schemaVersion, authority, coverage, faceSafety, identity, timeMapHash, detectorConfigHash, envelopeHash, ...input } = envelope
    void schemaVersion; void authority; void coverage; void faceSafety; void identity; void timeMapHash; void detectorConfigHash
    return createFaceProducerEnvelopeV2(input as never).envelopeHash === envelopeHash
  } catch { return false }
}

function expectationReasons(envelope: FaceProducerEnvelopeV2, expected: FaceEvidenceExpectation): string[] {
  const reasons: string[] = []
  if (envelope.workspaceId !== expected.workspaceId || envelope.projectId !== expected.projectId ||
      envelope.projectVersionId !== expected.projectVersionId) reasons.push('SCOPE_MISMATCH')
  if (envelope.sourceArtifactId !== expected.sourceArtifactId || envelope.sourceSha256 !== expected.sourceSha256) reasons.push('SOURCE_MISMATCH')
  if (envelope.timeMapHash !== expected.timeMapHash || envelope.timelineDurationFrames !== expected.timelineDurationFrames ||
      envelope.timelineFps.num * expected.timelineFps.den !== expected.timelineFps.num * envelope.timelineFps.den) reasons.push('TIMELINE_MISMATCH')
  if (envelope.policySha256 !== FACE_EVIDENCE_POLICY_SHA256) reasons.push('POLICY_MISMATCH')
  return reasons
}

const sampleKey = (sample: FaceEvidenceSample) => calculateCanonicalHash({
  status: sample.status, detections: sample.detections, imageSha256: sample.imageSha256, rawOutputSha256: sample.rawOutputSha256,
})

export function collectFaceEvidenceStream(envelopes: readonly FaceProducerEnvelopeV2[], expected: FaceEvidenceExpectation): FaceEvidenceStream {
  const ordered = [...envelopes].sort((left, right) => left.window.startTimelineFrame - right.window.startTimelineFrame ||
    left.envelopeHash.localeCompare(right.envelopeHash))
  const reasonsByEnvelope = new Map<string, string[]>()
  for (const envelope of ordered) {
    const reasons = reasonsByEnvelope.get(envelope.envelopeHash) ?? []
    reasonsByEnvelope.set(envelope.envelopeHash, reasons)
    if (envelope.schemaVersion !== 'face-producer-envelope/v2' || !sealIntact(envelope)) reasons.push('ENVELOPE_SEAL_INVALID')
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
      const candidate: FaceEvidenceSample = Object.freeze({ timelineFrame: sample.timelineFrame, status: sample.status,
        detections: sample.boxes, frameWidth: sample.frameWidth, frameHeight: sample.frameHeight,
        envelopeHash: envelope.envelopeHash, imageSha256: sample.imageSha256, rawOutputSha256: sample.rawOutput?.sha256 ?? null })
      const previous = seen.get(sample.timelineFrame)
      if (previous && previous.key !== sampleKey(candidate)) {
        for (const hash of [previous.envelopeHash, envelope.envelopeHash]) {
          const reasons = reasonsByEnvelope.get(hash)!
          if (!reasons.includes('EVIDENCE_CONFLICT')) reasons.push('EVIDENCE_CONFLICT')
        }
      }
      if (!previous) seen.set(sample.timelineFrame, { key: sampleKey(candidate), envelopeHash: envelope.envelopeHash })
    }
  }
  const samples = new Map<number, FaceEvidenceSample>()
  const trustedWindows: Array<{ envelopeHash: string; startFrame: number; endFrame: number }> = []
  const untrusted: UntrustedFaceEvidence[] = []
  const unique = new Set<string>()
  for (const envelope of ordered) {
    if (unique.has(envelope.envelopeHash)) continue
    unique.add(envelope.envelopeHash)
    const reasons = reasonsByEnvelope.get(envelope.envelopeHash)!
    const window = envelope.window
    if (reasons.length > 0) {
      untrusted.push(Object.freeze({ envelopeHash: envelope.envelopeHash, startFrame: window.startTimelineFrame,
        endFrame: window.endTimelineFrame, reasons: Object.freeze([...new Set(reasons)].sort()) }))
      continue
    }
    trustedWindows.push({ envelopeHash: envelope.envelopeHash, startFrame: window.startTimelineFrame, endFrame: window.endTimelineFrame })
    for (const sample of envelope.samples) {
      if (!samples.has(sample.timelineFrame)) samples.set(sample.timelineFrame, Object.freeze({
        timelineFrame: sample.timelineFrame, status: sample.status, detections: sample.boxes,
        frameWidth: sample.frameWidth, frameHeight: sample.frameHeight, envelopeHash: envelope.envelopeHash,
        imageSha256: sample.imageSha256, rawOutputSha256: sample.rawOutput?.sha256 ?? null }))
    }
  }
  const body = {
    schemaVersion: 'face-evidence-stream/v1' as const,
    policySha256: FACE_EVIDENCE_POLICY_SHA256,
    timelineDurationFrames: expected.timelineDurationFrames,
    timelineFps: Object.freeze({ ...expected.timelineFps }),
    samples: Object.freeze([...samples.values()].sort((a, b) => a.timelineFrame - b.timelineFrame)),
    trustedWindows: Object.freeze(trustedWindows.map((window) => Object.freeze(window))),
    untrusted: Object.freeze(untrusted),
  }
  return Object.freeze({ ...body, streamHash: calculateCanonicalHash(body) })
}
