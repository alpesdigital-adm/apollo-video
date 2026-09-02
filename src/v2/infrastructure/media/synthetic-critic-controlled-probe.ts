import type {
  SyntheticCriticDimensionEvaluator,
  SyntheticCriticEvaluationContext,
  SyntheticCriticEvaluationOutcome,
} from '../../application/ports/synthetic-critic-evaluator.ts'
import type {
  SyntheticCriticDimension,
  SyntheticCriticEvaluator,
  SyntheticCriticMeasurement,
} from '../../domain/synthetic-critic-report.ts'
import type { SyntheticCriticFinding } from '../../domain/synthetic-critic-thresholds.ts'

/**
 * A named, deterministic stand-in for three perceptual models this system does
 * not deploy.
 *
 * It is declared `controlled` in every report it appears in, and its scope says
 * exactly what it can and cannot answer. Read it as a set of necessary
 * conditions: it can refuse a take (the tracks drift, the adapter rendered a
 * different identity, the container changed mid-take) but it can never confirm
 * that lips match phonemes, that a face is the right face, or that wardrobe and
 * lighting held. It is not production visual validation and must never be
 * reported as such.
 */
export const SYNTHETIC_CRITIC_CONTROLLED_EVALUATOR: Readonly<SyntheticCriticEvaluator> = Object.freeze({
  id: 'controlled-deterministic-probe',
  version: '1.0.0',
  kind: 'controlled' as const,
  scope:
    'deterministic stand-in for perceptual lip-sync, identity and continuity models that are not deployed: it compares audio and video timelines, the identity reference the adapter declared against the approved presenter snapshot, and this take container geometry against the previously approved block. It can refuse a take, never confirm one, and it is not production visual validation',
})

const DIMENSIONS: readonly SyntheticCriticDimension[] = Object.freeze([
  'lip-sync',
  'identity',
  'continuity',
])

function unavailable(dimension: SyntheticCriticDimension, note: string): Readonly<SyntheticCriticMeasurement> {
  return Object.freeze({
    dimension,
    status: 'unavailable' as const,
    evaluatorId: null,
    value: null,
    unit: null,
    threshold: null,
    confidence: null,
    evidenceRefs: Object.freeze([] as readonly string[]),
    range: null,
    note,
  })
}

function measured(
  dimension: SyntheticCriticDimension,
  value: number,
  unit: string,
  evidenceRefs: readonly string[],
): Readonly<SyntheticCriticMeasurement> {
  return Object.freeze({
    dimension,
    status: 'measured' as const,
    evaluatorId: SYNTHETIC_CRITIC_CONTROLLED_EVALUATOR.id,
    value,
    unit,
    threshold: null,
    // No confidence model produced this reading, so no confidence is reported.
    // What this number is worth is stated once, in the evaluator's kind and
    // scope; a number here would be a figure nobody calculated.
    confidence: null,
    evidenceRefs: Object.freeze([...evidenceRefs]),
    range: null,
    note: null,
  })
}

export class DeterministicSyntheticCriticControlledEvaluator implements SyntheticCriticDimensionEvaluator {
  readonly dimensions = DIMENSIONS

  async evaluate(
    context: Readonly<SyntheticCriticEvaluationContext>,
  ): Promise<Readonly<SyntheticCriticEvaluationOutcome>> {
    const subject = context.subject
    const media = context.media
    const expected = subject.expected
    const measurements: Readonly<SyntheticCriticMeasurement>[] = []
    const findings: Readonly<SyntheticCriticFinding>[] = []
    const evidence = subject.video
      ? [`artifact://${subject.video.artifactId}`]
      : subject.audio
        ? [`artifact://${subject.audio.artifactId}`]
        : []

    // --- lip-sync -----------------------------------------------------------
    if (!media) {
      measurements.push(unavailable(
        'lip-sync',
        'the artifact did not decode, so the audio and video timelines could not be compared',
      ))
    } else if (media.audioDurationMs === null || !subject.video) {
      measurements.push(unavailable(
        'lip-sync',
        'the take has no separately measurable audio and video timeline to compare',
      ))
    } else {
      measurements.push(measured(
        'lip-sync',
        Math.abs(media.durationMs - media.audioDurationMs),
        'ms-av-offset',
        evidence,
      ))
    }

    // --- identity -----------------------------------------------------------
    if (expected.declaredIdentityRef === null) {
      measurements.push(unavailable(
        'identity',
        'the adapter declared no identity reference for this take, so there was nothing to compare against the approved snapshot',
      ))
    } else {
      measurements.push(measured(
        'identity',
        expected.declaredIdentityRef === expected.identityRef ? 1 : 0,
        'identity-ref-match',
        evidence,
      ))
    }
    if (!expected.rights.withinGrantedScope) {
      findings.push(Object.freeze({
        cause: 'change-outside-rights' as const,
        dimension: 'identity' as const,
        detail: expected.rights.reason
          ?? 'this generation falls outside the consent and rights envelope granted for the presenter',
        range: null,
        observed: null,
        limit: null,
      }))
    }

    // --- continuity ---------------------------------------------------------
    if (!media || !expected.previousBlock) {
      measurements.push(unavailable(
        'continuity',
        !media
          ? 'the artifact did not decode, so its parameters could not be compared to the previous block'
          : 'this is the first approved block of the take, so there is no previous block to compare against',
      ))
    } else {
      const previous = expected.previousBlock
      const mismatches = [
        ...(media.width === previous.width ? [] : [`width ${media.width} against ${previous.width}`]),
        ...(media.height === previous.height ? [] : [`height ${media.height} against ${previous.height}`]),
        ...(Math.abs(media.fps - previous.fps) <= 0.01 ? [] : [`fps ${media.fps.toFixed(3)} against ${previous.fps.toFixed(3)}`]),
        ...(media.videoCodec === previous.videoCodec ? [] : [`video codec ${media.videoCodec} against ${previous.videoCodec}`]),
        ...(media.audioCodec === previous.audioCodec ? [] : [`audio codec ${media.audioCodec ?? 'none'} against ${previous.audioCodec}`]),
        ...(media.container === previous.container ? [] : [`container ${media.container} against ${previous.container}`]),
      ]
      measurements.push(measured('continuity', mismatches.length, 'parameter-mismatches', evidence))
      if (mismatches.length > 0) {
        findings.push(Object.freeze({
          cause: 'continuity-break' as const,
          dimension: 'continuity' as const,
          detail: `this take differs from the previous approved block in ${mismatches.join(', ')}`,
          range: null,
          observed: mismatches.length,
          limit: 0,
        }))
      }
    }

    return Object.freeze({
      evaluator: SYNTHETIC_CRITIC_CONTROLLED_EVALUATOR,
      measurements: Object.freeze(measurements),
      findings: Object.freeze(findings),
    })
  }
}
