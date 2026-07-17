import { DomainError } from './errors.ts'

export type ConfidenceDecisionType = 'transcription' | 'cut' | 'asset-selection' | 'narrative-reorder' | 'rights' | 'generation'
export type ConfidenceBand = 'auto-apply' | 'review' | 'block'
export interface DecisionConfidence { value: number; evidence: readonly { ref: string; weight: number }[]; reasonCodes: readonly string[]; calibrationVersion: string }
const THRESHOLDS: Record<ConfidenceDecisionType, { auto: number; review: number }> = {
  transcription: { auto: .92, review: .7 }, cut: { auto: .88, review: .65 }, 'asset-selection': { auto: .85, review: .6 },
  'narrative-reorder': { auto: .9, review: .75 }, rights: { auto: 1, review: 1 }, generation: { auto: .86, review: .62 }
}

export function classifyConfidence(type: ConfidenceDecisionType, confidence: DecisionConfidence): ConfidenceBand {
  if (confidence.value < 0 || confidence.value > 1 || !confidence.calibrationVersion || !confidence.reasonCodes.length) throw new DomainError('INVALID_ARGUMENT', 'Confidence requires value, reason codes and calibration version')
  const threshold = THRESHOLDS[type]
  return confidence.value >= threshold.auto ? 'auto-apply' : confidence.value >= threshold.review ? 'review' : 'block'
}

export function relevantUncertainty(items: readonly { id: string; label: string; type: ConfidenceDecisionType; confidence: DecisionConfidence }[]) {
  return Object.freeze(items.map((item) => ({ ...item, band: classifyConfidence(item.type, item.confidence) })).filter((item) => item.band !== 'auto-apply').toSorted((a, b) => a.confidence.value - b.confidence.value))
}

export function expectedCalibrationError(samples: readonly { predicted: number; correct: boolean }[], bins = 10): number {
  if (!samples.length) return 0
  let total = 0
  for (let index = 0; index < bins; index += 1) {
    const lower = index / bins; const upper = (index + 1) / bins
    const bucket = samples.filter((sample) => sample.predicted >= lower && (index === bins - 1 ? sample.predicted <= upper : sample.predicted < upper))
    if (!bucket.length) continue
    const confidence = bucket.reduce((sum, sample) => sum + sample.predicted, 0) / bucket.length
    const accuracy = bucket.filter((sample) => sample.correct).length / bucket.length
    total += Math.abs(confidence - accuracy) * bucket.length / samples.length
  }
  return Number(total.toFixed(6))
}
