import type { PerceptionProducerEnvelope } from './perception-producer-envelope.ts'
import { createPerceptionTimeline, PERCEPTION_KINDS } from './perception-timeline.ts'

/** Projects only observed OCR samples; unsampled frames remain gaps, never proof of absence. */
export function expectedOcrTimeline(envelope: Readonly<PerceptionProducerEnvelope>,
  fps: number, durationFrames: number) {
  const durationMs = Math.max(1, Math.ceil(durationFrames / fps * 1000))
  const sampleRanges = envelope.samples.map((sample) => {
    const startMs = Math.min(durationMs - 1, Math.round(sample.timelineFrame / fps * 1000))
    const endMs = Math.min(durationMs, Math.max(startMs + 1,
      Math.round((sample.timelineFrame + 1) / fps * 1000)))
    return [startMs, endMs] as const
  })
  const observations = envelope.samples.flatMap((sample, sampleIndex) => {
    const [startMs, endMs] = sampleRanges[sampleIndex]!
    return sample.ocr.map((region, index) => ({
      id: `ocr-${sample.timelineFrame}-${index}-${envelope.envelopeHash.slice(0, 12)}`,
      kind: 'ocr' as const, startMs, endMs,
      value: { text: region.text, language: region.language, box: region.box,
        confidence: region.confidence, sourceFrame: sample.sourceFrame,
        sourcePts: sample.sourcePts, timelineFrame: sample.timelineFrame,
        sampleImageSha256: sample.imageSha256 },
      provenance: { source: envelope.id, model: 'tesseract',
        version: envelope.envelopeHash, confidence: region.confidence },
    }))
  })
  return createPerceptionTimeline({ durationMs, observations,
    coverage: PERCEPTION_KINDS.map((kind) => ({ kind,
      ranges: kind === 'ocr' ? sampleRanges : [] })) })
}
