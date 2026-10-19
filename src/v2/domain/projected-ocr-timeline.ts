import type { PerceptionProducerEnvelope } from './perception-producer-envelope.ts'
import { frameRangesToCoverageMs, perceptionDurationMs } from './perception-frame-time.ts'
import {
  coverageState, coveredMs, createPerceptionTimeline, PERCEPTION_KINDS,
  type PerceptionObservation, type PerceptionRange,
} from './perception-timeline.ts'

/**
 * The OCR observations and coverage one sealed envelope projects on a timeline (W63a: the single projection both the Director's
 * snapshot and the server perception snapshot use, so they cannot disagree). Only observed OCR samples are projected;
 * unsampled frames remain gaps, never proof of absence.
 */
export function projectOcrEnvelope(envelope: Readonly<PerceptionProducerEnvelope>, fps: number, durationFrames: number) {
  const durationMs = perceptionDurationMs(durationFrames, fps)
  const observations: PerceptionObservation[] = envelope.samples.flatMap((sample) => {
    const startMs = Math.min(durationMs - 1, Math.round(sample.timelineFrame / fps * 1000))
    const endMs = Math.min(durationMs, Math.max(startMs + 1, Math.round((sample.timelineFrame + 1) / fps * 1000)))
    return sample.ocr.map((region, index) => ({
      id: `ocr-${sample.timelineFrame}-${index}-${envelope.envelopeHash.slice(0, 12)}`,
      kind: 'ocr' as const, startMs, endMs,
      value: { text: region.text, language: region.language, box: region.box,
        confidence: region.confidence, sourceFrame: sample.sourceFrame,
        sourcePts: sample.sourcePts, timelineFrame: sample.timelineFrame,
        sampleImageSha256: sample.imageSha256 },
      provenance: { source: envelope.id, model: 'tesseract',
        version: envelope.envelopeHash, confidence: region.confidence,
        origin: 'server' as const, producer: 'tesseract', envelopeId: envelope.id,
        envelopeHash: envelope.envelopeHash, confidenceBasis: 'producer-reported' as const },
    }))
  })
  const ranges: readonly PerceptionRange[] = frameRangesToCoverageMs(
    envelope.samples.map((sample) => ({ startFrame: sample.timelineFrame, endFrame: sample.timelineFrame + 1 })),
    fps, durationFrames, durationMs)
  const state = coverageState(coveredMs(ranges), durationMs)
  return Object.freeze({
    durationMs, observations, ranges,
    reasonCode: state === 'absent' ? 'NO_SAMPLES_OBSERVED' : state === 'partial' ? 'SAMPLED_FRAMES_ONLY' : undefined,
  })
}

/** What the Director expects its OCR kind to be for one sealed envelope; the other kinds stay empty. */
export function expectedOcrTimeline(envelope: Readonly<PerceptionProducerEnvelope>,
  fps: number, durationFrames: number) {
  const projection = projectOcrEnvelope(envelope, fps, durationFrames)
  return createPerceptionTimeline({ durationMs: projection.durationMs, observations: projection.observations,
    origin: 'server',
    coverage: PERCEPTION_KINDS.map((kind) => kind === 'ocr'
      ? { kind, ranges: projection.ranges,
          ...(projection.reasonCode ? { reasonCode: projection.reasonCode } : {}) }
      : { kind, ranges: [] }) })
}
