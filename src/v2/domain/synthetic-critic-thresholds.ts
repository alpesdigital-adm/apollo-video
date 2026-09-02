import { assertDomain } from './errors.ts'
import {
  SYNTHETIC_CRITIC_DIMENSIONS,
  SYNTHETIC_CRITIC_SEVERITIES,
  type SyntheticCriticAction,
  type SyntheticCriticDecision,
  type SyntheticCriticDimension,
  type SyntheticCriticIssue,
  type SyntheticCriticMeasurement,
  type SyntheticCriticRange,
  type SyntheticCriticSeverity,
} from './synthetic-critic-report.ts'

/**
 * Versioned decision policy for the synthetic critic.
 *
 * Two things live here and nothing else: what a capability *requires* to be
 * judged at all, and what each named cause is worth. Neither is a measurement —
 * an adapter measures, this module only says what a measurement buys. Keeping
 * them apart is why the report can state a number and a verdict separately.
 */

export const SYNTHETIC_CRITIC_THRESHOLD_FAMILY = 'synthetic-critic-thresholds' as const

/**
 * The gates that must never be crossed by an approval. They are named so a
 * report says which one fired instead of publishing a score that swallowed it.
 */
export const SYNTHETIC_CRITIC_HARD_GATES = Object.freeze([
  'identity-mismatch',
  'critical-word-omitted',
  'corrupt-blob',
  'lip-sync-below-threshold',
  'frame-or-duration-mismatch',
  'required-evidence-missing',
  'change-outside-rights',
] as const)
export type SyntheticCriticHardGate = (typeof SYNTHETIC_CRITIC_HARD_GATES)[number]

/**
 * Every reason a take can be held back, named at the point it is observed.
 *
 * The cause — not an aggregate score — decides between retry, fallback and
 * manual review, and it travels into the issue so the operator reads why.
 */
export const SYNTHETIC_CRITIC_CAUSES = Object.freeze([
  'blob-undecodable',
  'audio-track-missing',
  'audio-silent',
  'audio-silence-window',
  'video-frozen',
  'video-freeze-window',
  'duration-drift',
  'frame-rate-mismatch',
  'frame-count-mismatch',
  'sample-rate-mismatch',
  'codec-mismatch',
  'word-omitted',
  'word-added',
  'lip-sync-below-threshold',
  'identity-mismatch',
  'continuity-break',
  'change-outside-rights',
  'required-evidence-missing',
  'required-dimension-not-applicable',
] as const)
export type SyntheticCriticCause = (typeof SYNTHETIC_CRITIC_CAUSES)[number]

/**
 * What an evaluator observed, at the moment it observed it. A finding is not a
 * verdict: the threshold policy turns it into an issue with a severity and an
 * action, and the cause survives that translation intact.
 */
export interface SyntheticCriticFinding {
  cause: SyntheticCriticCause
  dimension: SyntheticCriticDimension
  detail: string
  range: Readonly<SyntheticCriticRange> | null
  observed: number | null
  limit: number | null
}

export interface SyntheticCriticCausePolicy {
  cause: SyntheticCriticCause
  severity: SyntheticCriticSeverity
  /** Derived from the cause alone — never from a combined score. */
  action: Exclude<SyntheticCriticAction, 'none'>
  hardGate: SyntheticCriticHardGate | null
}

export type SyntheticCriticDimensionRequirement = 'required' | 'optional' | 'not-applicable'

export interface SyntheticCriticDimensionPolicy {
  dimension: SyntheticCriticDimension
  /**
   * `required` is a fail-closed promise: a capability that requires a dimension
   * and receives it as `unavailable` decides `evidence-unavailable`, never
   * approval.
   */
  requirement: SyntheticCriticDimensionRequirement
  limit: number | null
  unit: string | null
  comparison: 'at-most' | 'at-least' | null
  /**
   * The cause a breach of this dimension's own number stands for. It is null
   * when the number can be broken for several different reasons — the evaluator
   * that saw which one names it, because collapsing them into a single cause
   * would be the aggregate score this design refuses.
   */
  breachCause: SyntheticCriticCause | null
}

export interface SyntheticCriticThresholds {
  version: string
  capability: string
  /** Narrower scopes win: adapter and model overrides sit on top of the capability. */
  adapterId: string | null
  modelRef: string | null
  dimensions: readonly Readonly<SyntheticCriticDimensionPolicy>[]
  causes: readonly Readonly<SyntheticCriticCausePolicy>[]
}

const SEVERITY_RANK: Readonly<Record<SyntheticCriticSeverity, number>> = Object.freeze({
  blocking: 3,
  major: 2,
  minor: 1,
})

/**
 * One frame at 30fps. The synthetic master already treats this as the maximum
 * honest disagreement between an audio timeline and the video cut from it, so
 * the critic refuses to be stricter than the format allows.
 */
export const SYNTHETIC_CRITIC_FRAME_TOLERANCE_MS = 34

const SHARED_CAUSES: readonly Readonly<SyntheticCriticCausePolicy>[] = Object.freeze([
  // The bytes themselves are unusable. Retrying the same request is the cheap
  // move: a truncated download or a half-written upload usually succeeds twice.
  { cause: 'blob-undecodable', severity: 'blocking', action: 'retry', hardGate: 'corrupt-blob' },
  { cause: 'audio-track-missing', severity: 'blocking', action: 'retry', hardGate: null },
  { cause: 'audio-silent', severity: 'blocking', action: 'retry', hardGate: null },
  // A pause inside a sentence is normal speech; it is reported, not gated.
  { cause: 'audio-silence-window', severity: 'minor', action: 'manual-review', hardGate: null },
  // A take frozen end to end is a dead render; a still window is a judgement call.
  { cause: 'video-frozen', severity: 'blocking', action: 'fallback', hardGate: null },
  { cause: 'video-freeze-window', severity: 'minor', action: 'manual-review', hardGate: null },
  { cause: 'duration-drift', severity: 'blocking', action: 'retry', hardGate: 'frame-or-duration-mismatch' },
  { cause: 'frame-rate-mismatch', severity: 'blocking', action: 'retry', hardGate: 'frame-or-duration-mismatch' },
  { cause: 'frame-count-mismatch', severity: 'blocking', action: 'retry', hardGate: 'frame-or-duration-mismatch' },
  { cause: 'sample-rate-mismatch', severity: 'major', action: 'retry', hardGate: null },
  // A different codec is a configuration the adapter will repeat on retry.
  { cause: 'codec-mismatch', severity: 'major', action: 'fallback', hardGate: null },
  // The bytes do not say what was approved. That is the whole point of the gate.
  { cause: 'word-omitted', severity: 'blocking', action: 'retry', hardGate: 'critical-word-omitted' },
  { cause: 'word-added', severity: 'major', action: 'manual-review', hardGate: null },
  { cause: 'lip-sync-below-threshold', severity: 'blocking', action: 'fallback', hardGate: 'lip-sync-below-threshold' },
  { cause: 'identity-mismatch', severity: 'blocking', action: 'fallback', hardGate: 'identity-mismatch' },
  { cause: 'continuity-break', severity: 'major', action: 'manual-review', hardGate: null },
  // Rights are never a retry: a person decides, or nothing ships.
  { cause: 'change-outside-rights', severity: 'blocking', action: 'manual-review', hardGate: 'change-outside-rights' },
  {
    cause: 'required-evidence-missing',
    severity: 'blocking',
    action: 'manual-review',
    hardGate: 'required-evidence-missing',
  },
  {
    cause: 'required-dimension-not-applicable',
    severity: 'blocking',
    action: 'manual-review',
    hardGate: 'required-evidence-missing',
  },
].map((policy) => Object.freeze(policy as SyntheticCriticCausePolicy)))

function dimensionPolicy(
  dimension: SyntheticCriticDimension,
  requirement: SyntheticCriticDimensionRequirement,
  limit: number | null = null,
  unit: string | null = null,
  comparison: 'at-most' | 'at-least' | null = null,
  breachCause: SyntheticCriticCause | null = null,
): Readonly<SyntheticCriticDimensionPolicy> {
  return Object.freeze({ dimension, requirement, limit, unit, comparison, breachCause })
}

/**
 * Dimensions no deployed model can answer today. They are declared optional so
 * a missing perceptual model never blocks a take it never looked at — and they
 * are never silently treated as passing, because the report still carries them
 * as `unavailable` with the reason.
 */
const UNDEPLOYED_VISUAL_DIMENSIONS: readonly SyntheticCriticDimension[] = Object.freeze([
  'visual-artifacts',
  'framing',
  'eyes',
  'teeth',
  'hands',
])

const AUDIO_AVATAR_V1: Readonly<SyntheticCriticThresholds> = Object.freeze({
  version: `${SYNTHETIC_CRITIC_THRESHOLD_FAMILY}/audio-avatar/v1`,
  capability: 'audio-avatar',
  adapterId: null,
  modelRef: null,
  dimensions: Object.freeze([
    dimensionPolicy(
      'temporal-integrity', 'required', SYNTHETIC_CRITIC_FRAME_TOLERANCE_MS, 'ms-drift', 'at-most', 'duration-drift',
    ),
    // A dead take can be dead in several ways; the probe names which.
    dimensionPolicy('audiovisual-integrity', 'required', 1, 'live-signal', 'at-least'),
    // Omitted and added words are not the same failure, so neither is the cause.
    dimensionPolicy('pronunciation', 'required', 0, 'word-deviations', 'at-most'),
    dimensionPolicy(
      'lip-sync', 'required', SYNTHETIC_CRITIC_FRAME_TOLERANCE_MS, 'ms-av-offset', 'at-most',
      'lip-sync-below-threshold',
    ),
    dimensionPolicy('identity', 'required', 1, 'identity-ref-match', 'at-least', 'identity-mismatch'),
    // The controlled probe already names which parameter moved, so the policy
    // does not restate the breach and double-count it.
    dimensionPolicy('continuity', 'optional', 0, 'parameter-mismatches', 'at-most'),
    ...UNDEPLOYED_VISUAL_DIMENSIONS.map((dimension) => dimensionPolicy(dimension, 'optional')),
  ]),
  causes: SHARED_CAUSES,
})

/**
 * The same policy with the offset budget of a provider that cuts video on a
 * 25fps grid: one frame there is 40ms, and pretending otherwise would reject
 * takes for being exactly as accurate as the format permits.
 */
const AUDIO_AVATAR_HEYGEN_V3_V1: Readonly<SyntheticCriticThresholds> = Object.freeze({
  ...AUDIO_AVATAR_V1,
  version: `${SYNTHETIC_CRITIC_THRESHOLD_FAMILY}/audio-avatar/heygen-v3/v1`,
  adapterId: 'heygen-v3',
  dimensions: Object.freeze(AUDIO_AVATAR_V1.dimensions.map((policy) =>
    policy.dimension === 'lip-sync' || policy.dimension === 'temporal-integrity'
      ? Object.freeze({ ...policy, limit: 40 })
      : policy)),
})

const TTS_V1: Readonly<SyntheticCriticThresholds> = Object.freeze({
  version: `${SYNTHETIC_CRITIC_THRESHOLD_FAMILY}/tts/v1`,
  capability: 'tts',
  adapterId: null,
  modelRef: null,
  dimensions: Object.freeze([
    dimensionPolicy(
      'temporal-integrity', 'required', SYNTHETIC_CRITIC_FRAME_TOLERANCE_MS, 'ms-drift', 'at-most', 'duration-drift',
    ),
    dimensionPolicy('audiovisual-integrity', 'required', 1, 'live-signal', 'at-least'),
    dimensionPolicy('pronunciation', 'required', 0, 'word-deviations', 'at-most'),
    // Speech has no picture. These are not unknown, they do not exist here.
    dimensionPolicy('lip-sync', 'not-applicable'),
    dimensionPolicy('identity', 'not-applicable'),
    dimensionPolicy('continuity', 'not-applicable'),
    ...UNDEPLOYED_VISUAL_DIMENSIONS.map((dimension) => dimensionPolicy(dimension, 'not-applicable')),
  ]),
  causes: SHARED_CAUSES,
})

const REGISTRY: readonly Readonly<SyntheticCriticThresholds>[] = Object.freeze([
  AUDIO_AVATAR_HEYGEN_V3_V1,
  AUDIO_AVATAR_V1,
  TTS_V1,
])

export const SYNTHETIC_CRITIC_THRESHOLD_VERSIONS = Object.freeze(REGISTRY.map((entry) => entry.version))

/**
 * Picks the narrowest published policy for a capability. A capability with no
 * published policy is not judged by an improvised default: it fails closed,
 * because approving against thresholds nobody wrote is approving against
 * nothing.
 */
export function resolveSyntheticCriticThresholds(input: {
  capability: string
  adapterId?: string | null
  modelRef?: string | null
}): Readonly<SyntheticCriticThresholds> {
  const candidates = REGISTRY.filter((entry) =>
    entry.capability === input.capability &&
    (entry.adapterId === null || entry.adapterId === input.adapterId) &&
    (entry.modelRef === null || entry.modelRef === input.modelRef))
  assertDomain(
    candidates.length > 0,
    'INVALID_CAPABILITY_POLICY',
    `no synthetic critic thresholds are published for capability ${input.capability}`,
  )
  const specificity = (entry: Readonly<SyntheticCriticThresholds>) =>
    (entry.adapterId === null ? 0 : 1) + (entry.modelRef === null ? 0 : 2)
  return candidates.reduce((best, entry) => (specificity(entry) > specificity(best) ? entry : best))
}

export function syntheticCriticDimensionPolicy(
  thresholds: Readonly<SyntheticCriticThresholds>,
  dimension: SyntheticCriticDimension,
): Readonly<SyntheticCriticDimensionPolicy> {
  const policy = thresholds.dimensions.find((entry) => entry.dimension === dimension)
  assertDomain(
    Boolean(policy),
    'INVALID_CAPABILITY_POLICY',
    `thresholds ${thresholds.version} are silent about ${dimension}`,
  )
  return policy!
}

function causePolicy(
  thresholds: Readonly<SyntheticCriticThresholds>,
  cause: SyntheticCriticCause,
): Readonly<SyntheticCriticCausePolicy> {
  const policy = thresholds.causes.find((entry) => entry.cause === cause)
  assertDomain(
    Boolean(policy),
    'INVALID_CAPABILITY_POLICY',
    `thresholds ${thresholds.version} do not price the cause ${cause}`,
  )
  return policy!
}

export interface SyntheticCriticVerdict {
  issues: readonly Readonly<SyntheticCriticIssue>[]
  decision: SyntheticCriticDecision
  recommendedAction: SyntheticCriticAction
  hardGates: readonly SyntheticCriticHardGate[]
}

/**
 * Turns measurements and findings into a verdict.
 *
 * The order of the decision is deliberate. Knowing the bytes are broken beats
 * not knowing anything about them: a substantive hard gate rejects even when
 * required evidence is also missing, because the missing evidence is usually a
 * consequence of the same broken artifact. Only when nothing substantive fired
 * does an absent required dimension become `evidence-unavailable` — and that is
 * never an approval.
 */
export function evaluateSyntheticCriticThresholds(input: {
  thresholds: Readonly<SyntheticCriticThresholds>
  blockId: string
  measurements: readonly Readonly<SyntheticCriticMeasurement>[]
  findings: readonly Readonly<SyntheticCriticFinding>[]
}): Readonly<SyntheticCriticVerdict> {
  const byDimension = new Map(input.measurements.map((entry) => [entry.dimension, entry]))
  const findings: Readonly<SyntheticCriticFinding>[] = [...input.findings]

  for (const dimension of SYNTHETIC_CRITIC_DIMENSIONS) {
    const policy = syntheticCriticDimensionPolicy(input.thresholds, dimension)
    const measurement = byDimension.get(dimension)
    if (policy.requirement === 'required') {
      assertDomain(
        Boolean(measurement),
        'INVALID_ARGUMENT',
        `critic verdict is missing the ${dimension} measurement it requires`,
      )
      if (measurement!.status !== 'measured') {
        findings.push(Object.freeze({
          cause: measurement!.status === 'unavailable'
            ? ('required-evidence-missing' as const)
            : ('required-dimension-not-applicable' as const),
          dimension,
          detail: measurement!.note ?? `${dimension} was not measured`,
          range: null,
          observed: null,
          limit: policy.limit,
        }))
        continue
      }
    }
    // A measured dimension is compared against its own published limit here, so
    // the comparison lives with the policy instead of being copied into every
    // adapter. Dimensions whose number can break for several reasons declare no
    // breach cause: the evaluator that saw the reason already named it.
    if (
      !measurement ||
      measurement.status !== 'measured' ||
      policy.breachCause === null ||
      policy.limit === null ||
      policy.comparison === null ||
      typeof measurement.value !== 'number'
    ) continue
    const breached = policy.comparison === 'at-most'
      ? measurement.value > policy.limit
      : measurement.value < policy.limit
    if (!breached) continue
    findings.push(Object.freeze({
      cause: policy.breachCause,
      dimension,
      detail: `measured ${measurement.value}${policy.unit ? ` ${policy.unit}` : ''} against a limit of ${policy.comparison} ${policy.limit}`,
      range: measurement.range,
      observed: measurement.value,
      limit: policy.limit,
    }))
  }

  const priced = findings.map((finding) => {
    const policy = causePolicy(input.thresholds, finding.cause)
    return Object.freeze({
      finding,
      policy,
      issue: Object.freeze({
        blockId: input.blockId,
        dimension: finding.dimension,
        severity: policy.severity,
        range: finding.range,
        // The cause is the first thing an operator reads, so it is the first
        // thing the evidence says.
        evidence: `${finding.cause}: ${finding.detail}`,
        action: policy.action,
      } as SyntheticCriticIssue),
    })
  })

  const hardGates = Object.freeze([...new Set(
    priced.flatMap((entry) => (entry.policy.hardGate ? [entry.policy.hardGate] : [])),
  )])
  const substantive = priced.filter((entry) =>
    entry.policy.severity === 'blocking' &&
    entry.policy.hardGate !== 'required-evidence-missing' &&
    entry.finding.cause !== 'required-evidence-missing' &&
    entry.finding.cause !== 'required-dimension-not-applicable')
  const missingEvidence = priced.filter((entry) => entry.finding.cause === 'required-evidence-missing')
  const blocking = priced.filter((entry) => entry.policy.severity === 'blocking')

  const decision: SyntheticCriticDecision = substantive.length > 0
    ? 'rejected'
    : missingEvidence.length > 0
      ? 'evidence-unavailable'
      : blocking.length > 0
        ? 'rejected'
        : priced.length > 0
          ? 'needs-review'
          : 'approved'

  // The recommended action is the action of the single worst cause, not a
  // function of how many issues there are: two minor issues never add up to a
  // fallback.
  const worst = priced.reduce<typeof priced[number] | null>((best, entry) => {
    if (!best) return entry
    const rank = SEVERITY_RANK[entry.policy.severity]
    const bestRank = SEVERITY_RANK[best.policy.severity]
    if (rank !== bestRank) return rank > bestRank ? entry : best
    const order = SYNTHETIC_CRITIC_CAUSES.indexOf(entry.finding.cause)
    const bestOrder = SYNTHETIC_CRITIC_CAUSES.indexOf(best.finding.cause)
    return order < bestOrder ? entry : best
  }, null)

  return Object.freeze({
    issues: Object.freeze(priced.map((entry) => entry.issue)),
    decision,
    recommendedAction: decision === 'approved' ? 'none' : worst!.policy.action,
    hardGates,
  })
}

export function syntheticCriticSeverityRank(severity: SyntheticCriticSeverity): number {
  assertDomain(
    SYNTHETIC_CRITIC_SEVERITIES.includes(severity),
    'INVALID_ARGUMENT',
    'unknown critic severity',
  )
  return SEVERITY_RANK[severity]
}
