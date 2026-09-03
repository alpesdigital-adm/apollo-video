import { assertDomain } from './errors.ts'
import {
  addRational,
  applyAffineClockMap,
  compareRational,
  createAffineClockMap,
  divideRational,
  intervalContains,
  multiplyRational,
  rational,
  rationalToPpm,
  subtractRational,
  type Rational,
  type RoundingPolicy,
  type TickInterval,
} from './session-time.ts'
import {
  createSourceToSessionMapping,
  extractDriftRate,
  sessionTicksPerFrame,
  SESSION_CLOCK_ROUNDING,
  type ClockConfidence,
  type SessionClock,
  type SourceClock,
  type SourceToSessionMapping,
} from './session-clock.ts'

/**
 * Offset and drift estimation from synchronization anchors (F4.006, spec 05
 * §10, ADR-130).
 *
 * Two clocks that were never locked together run at slightly different rates.
 * Over ten minutes a 100 ppm difference is 60 ms — two frames — so a single
 * offset measured at the top of a session is wrong by the end of it. This
 * module measures that, and the interesting decisions are all about what it
 * refuses to do:
 *
 * **It fits with every valid anchor, not with the endpoints.** The obvious
 * implementation takes the first and last anchor and draws a line. That
 * estimator has no residual — it passes exactly through the only two points it
 * used — so it reports perfect confidence in a model it never tested, and one
 * bad endpoint tilts the whole session. Least squares over all anchors makes
 * every anchor a check on every other one, and the residuals it leaves behind
 * are the evidence.
 *
 * **Arithmetic is exact.** Slope estimation subtracts nearly equal large
 * numbers, which is precisely where floating point loses the digits that carry
 * the answer. Everything here is `bigint` and `Rational`; floats appear only in
 * fields named as reports.
 *
 * **A residual it cannot explain is never averaged away.** A high residual
 * means the linear model is wrong, and the honest outcomes are a new piece, a
 * review, or an admission of insufficient evidence — never a slightly worse
 * line through the middle of a contradiction.
 *
 * **Refusing to stretch is a valid answer.** Drift below the calibrated
 * threshold is recorded and left alone, and a correction that would time-stretch
 * speech beyond the safe ratio fails closed: unknown content is treated as
 * speech, because assuming otherwise is how a lecture gets pitch-shifted.
 */

export const CLOCK_DRIFT_SCHEMA_VERSION = 'clock-drift/v1' as const

const ID = /^[A-Za-z0-9][A-Za-z0-9._:/-]{2,127}$/

/** Spec 05 §7. The cascade that produces anchors is F4.004; this module consumes them. */
export const SYNC_ANCHOR_METHODS = Object.freeze([
  'timecode',
  'apollo-marker',
  'audio',
  'visual',
  'transcript',
  'manual',
] as const)
export type SyncAnchorMethod = (typeof SYNC_ANCHOR_METHODS)[number]

export interface DriftAnchor {
  readonly id: string
  /** In source ticks, in the source's own timebase. */
  readonly sourceTick: bigint
  /** In session ticks, on the canonical session clock. */
  readonly sessionTick: bigint
  readonly method: SyncAnchorMethod
  readonly confidence: ClockConfidence
  readonly evidenceRef: string
}

export function createDriftAnchor(input: DriftAnchor): Readonly<DriftAnchor> {
  assertDomain(ID.test(input.id), 'INVALID_ARGUMENT', 'drift anchor id is not a valid identifier')
  assertDomain(
    SYNC_ANCHOR_METHODS.includes(input.method),
    'INVALID_ARGUMENT',
    `drift anchor method ${input.method} is not a recognized method`,
  )
  assertDomain(
    input.evidenceRef.trim().length > 0,
    'INVALID_ARGUMENT',
    'a drift anchor without an evidence reference cannot be audited',
  )
  return Object.freeze({ ...input, evidenceRef: input.evidenceRef.trim() })
}

/**
 * Calibration. Every number here is a policy the spec asks to be tunable, so
 * none of them is buried in a comparison somewhere below.
 */
export interface DriftPolicy {
  /** How much of the fit span the anchors must actually reach across. */
  readonly minimumSpanCoverage: Rational
  /** How many of the three thirds of the span must contain an anchor. */
  readonly minimumOccupiedThirds: number
  /**
   * Spec 05 §10: drift under one frame per this many seconds is left alone.
   * The threshold is derived from the session frame rate rather than fixed in
   * ppm, because "one frame" means a different rate error at 24 fps and 60 fps.
   */
  readonly toleranceWindowSeconds: bigint
  /** Spec 05 §10: residual a linear map may show and still be applied, in frames. */
  readonly residualTargetFrames: bigint
  /** Largest stretch that keeps speech transparent, in ppm. */
  readonly speechStretchLimitPpm: number
  /** Below this many anchors, holding some back would break the distribution gate. */
  readonly minimumAnchorsForHoldOut: number
}

export const DEFAULT_DRIFT_POLICY: Readonly<DriftPolicy> = Object.freeze({
  minimumSpanCoverage: rational(3n, 5n),
  minimumOccupiedThirds: 2,
  toleranceWindowSeconds: 600n,
  residualTargetFrames: 2n,
  speechStretchLimitPpm: 1_000,
  minimumAnchorsForHoldOut: 6,
})

export const DRIFT_REFUSAL_REASONS = Object.freeze([
  'too-few-anchors',
  'anchors-outside-span',
  'anchors-clustered',
  'conflicting-anchors',
  'degenerate-source-span',
  'non-positive-rate',
] as const)
export type DriftRefusalReason = (typeof DRIFT_REFUSAL_REASONS)[number]

export interface AnchorRejection {
  readonly anchorId: string
  readonly reason: 'outside-span' | 'duplicate'
}

export interface AnchorDistribution {
  readonly head: number
  readonly middle: number
  readonly tail: number
  readonly occupiedThirds: number
  /** Exact fraction of the span the anchors reach across. */
  readonly spanCoverage: Rational
  readonly anchorSpanTicks: bigint
  readonly fitSpanTicks: bigint
}

export interface ResidualBucket {
  readonly label: string
  /** Inclusive upper bound in session ticks, floored for display. `null` is the open top bucket. */
  readonly upperBoundTicks: bigint | null
  readonly count: number
}

/**
 * The whole shape of the error, not just its worst point.
 *
 * A maximum alone cannot distinguish "every anchor is off by two frames"
 * — a wrong model — from "one anchor is off by two frames and the rest are
 * exact" — one bad anchor. Those call for opposite actions, so both the
 * per-anchor residuals and their spread are reported.
 */
export interface ResidualDistribution {
  readonly count: number
  readonly minTicks: bigint
  readonly maxTicks: bigint
  readonly maxAbsTicks: bigint
  readonly meanAbsTicks: Rational
  readonly medianAbsTicks: Rational
  /** Exact mean of squared residuals. Take its square root for display only. */
  readonly meanSquareTicks: Rational
  readonly histogram: readonly Readonly<ResidualBucket>[]
}

export interface AnchorResidual {
  readonly anchorId: string
  readonly residualTicks: bigint
}

export type HoldOutValidation =
  | Readonly<{
      status: 'validated'
      trainingAnchorIds: readonly string[]
      heldOutAnchorIds: readonly string[]
      driftRate: Rational
      driftPpm: number
      offsetTicks: bigint
      residuals: readonly Readonly<AnchorResidual>[]
      residualDistribution: Readonly<ResidualDistribution>
      maxAbsTicks: bigint
    }>
  | Readonly<{ status: 'not-performed'; reason: 'too-few-anchors' | 'training-set-degenerate' }>

export interface DriftCorrectionDecision {
  readonly action: 'apply-rate' | 'none' | 'refused'
  readonly reason: 'measured-drift' | 'within-tolerance' | 'unsafe-speech-stretch' | 'unverified-residual'
  readonly carriesSpeech: boolean
  readonly speechStretchLimitPpm: number
}

export interface DriftTolerance {
  /** Rate deviation that accumulates exactly one frame over the tolerance window. */
  readonly limitRate: Rational
  readonly limitPpm: number
  readonly withinTolerance: boolean
}

export interface DriftSplitProposal {
  readonly afterAnchorId: string
  readonly beforeAnchorId: string
  readonly jumpTicks: bigint
}

export type ClockDriftFit =
  | Readonly<{
      status: 'insufficient-evidence'
      schemaVersion: typeof CLOCK_DRIFT_SCHEMA_VERSION
      reason: DriftRefusalReason
      detail: string
      distribution: Readonly<AnchorDistribution> | null
      usedAnchorIds: readonly string[]
      rejected: readonly Readonly<AnchorRejection>[]
    }>
  | Readonly<{
      status: 'fitted'
      schemaVersion: typeof CLOCK_DRIFT_SCHEMA_VERSION
      /** Clock drift alone: the timebase ratio is divided out. Exact, and the authority. */
      driftRate: Rational
      /** Truncated report of `driftRate`. Never the authority. */
      driftPpm: number
      offsetTicks: bigint
      rounding: RoundingPolicy
      distribution: Readonly<AnchorDistribution>
      usedAnchorIds: readonly string[]
      rejected: readonly Readonly<AnchorRejection>[]
      residuals: readonly Readonly<AnchorResidual>[]
      residualDistribution: Readonly<ResidualDistribution>
      /** Anchors past the residual target. Flagged, never removed from the fit. */
      outlierAnchorIds: readonly string[]
      holdOut: HoldOutValidation
      tolerance: Readonly<DriftTolerance>
      correction: Readonly<DriftCorrectionDecision>
      decision: 'auto-apply' | 'review' | 'new-piece'
      splitProposal: Readonly<DriftSplitProposal> | null
      /** The bound a mapping built from this fit must carry. */
      residualBoundTicks: bigint
    }>

function absBigInt(value: bigint): bigint {
  return value < 0n ? -value : value
}

function absRational(value: Rational): Rational {
  return value.num < 0n ? rational(-value.num, value.den) : value
}

/**
 * Round an exact rational to a tick, half-to-even.
 *
 * The kernel rounds internally with the same policy but does not export the
 * rounder, and the fitted offset is a rational that must become an integer tick
 * before it can be persisted. The policy is restated here rather than assumed,
 * so that a future change to one of them is a visible disagreement.
 */
function roundRationalToTicks(value: Rational): bigint {
  const negative = value.num < 0n
  const numerator = negative ? -value.num : value.num
  const denominator = value.den
  const quotient = numerator / denominator
  const remainder = numerator % denominator
  if (remainder === 0n) return negative ? -quotient : quotient
  const twice = remainder * 2n
  let magnitude = quotient
  if (twice > denominator) magnitude = quotient + 1n
  else if (twice === denominator) magnitude = quotient % 2n === 0n ? quotient : quotient + 1n
  return negative ? -magnitude : magnitude
}

/** Canonical anchor order, so every derived list and hash is reproducible. */
function compareAnchors(left: Readonly<DriftAnchor>, right: Readonly<DriftAnchor>): number {
  if (left.sourceTick !== right.sourceTick) return left.sourceTick < right.sourceTick ? -1 : 1
  if (left.sessionTick !== right.sessionTick) return left.sessionTick < right.sessionTick ? -1 : 1
  return left.id < right.id ? -1 : left.id > right.id ? 1 : 0
}

function describeDistribution(
  anchors: readonly Readonly<DriftAnchor>[],
  span: Readonly<TickInterval>,
): Readonly<AnchorDistribution> {
  const length = span.end - span.start
  const firstBoundary = span.start + length / 3n
  const secondBoundary = span.start + (length * 2n) / 3n
  let head = 0
  let middle = 0
  let tail = 0
  for (const anchor of anchors) {
    if (anchor.sourceTick < firstBoundary) head += 1
    else if (anchor.sourceTick < secondBoundary) middle += 1
    else tail += 1
  }
  const ticks = anchors.map((anchor) => anchor.sourceTick)
  const anchorSpanTicks =
    ticks.length === 0 ? 0n : ticks.reduce((a, b) => (b > a ? b : a)) - ticks.reduce((a, b) => (b < a ? b : a))
  return Object.freeze({
    head,
    middle,
    tail,
    occupiedThirds: (head > 0 ? 1 : 0) + (middle > 0 ? 1 : 0) + (tail > 0 ? 1 : 0),
    spanCoverage: rational(anchorSpanTicks, length),
    anchorSpanTicks,
    fitSpanTicks: length,
  })
}

interface OrdinaryLeastSquares {
  readonly rate: Rational
  readonly offset: Rational
}

/**
 * Ordinary least squares in exact rational arithmetic.
 *
 * `rate = (n·Σxy − Σx·Σy) / (n·Σxx − Σx²)`, `offset = (Σy·Σxx − Σx·Σxy) / D`.
 * The intermediate products reach the square of a tick count — far past 64 bits
 * — which is exactly why they are `bigint` and never `number`.
 */
function fitOrdinaryLeastSquares(
  points: readonly Readonly<{ x: bigint; y: bigint }>[],
): OrdinaryLeastSquares | null {
  const n = BigInt(points.length)
  let sumX = 0n
  let sumY = 0n
  let sumXX = 0n
  let sumXY = 0n
  for (const point of points) {
    sumX += point.x
    sumY += point.y
    sumXX += point.x * point.x
    sumXY += point.x * point.y
  }
  const denominator = n * sumXX - sumX * sumX
  if (denominator === 0n) return null
  return {
    rate: rational(n * sumXY - sumX * sumY, denominator),
    offset: rational(sumY * sumXX - sumX * sumXY, denominator),
  }
}

function summarizeResiduals(
  residuals: readonly Readonly<AnchorResidual>[],
  ticksPerFrame: Rational,
): Readonly<ResidualDistribution> {
  const values = residuals.map((entry) => entry.residualTicks)
  const absolute = [...values].map(absBigInt).sort((a, b) => (a < b ? -1 : a > b ? 1 : 0))
  const count = values.length
  const total = absolute.reduce((sum, value) => sum + value, 0n)
  const squares = absolute.reduce((sum, value) => sum + value * value, 0n)
  const middle = absolute.length >>> 1
  const median =
    absolute.length % 2 === 1
      ? rational(absolute[middle]!)
      : rational(absolute[middle - 1]! + absolute[middle]!, 2n)

  // Buckets are fractions of a session frame, compared exactly. Only the
  // displayed bound is floored, and it is labelled as such.
  const fractions: readonly Readonly<{ label: string; multiple: Rational | null }>[] = Object.freeze([
    { label: 'exact', multiple: rational(0n) },
    { label: 'within-quarter-frame', multiple: rational(1n, 4n) },
    { label: 'within-half-frame', multiple: rational(1n, 2n) },
    { label: 'within-one-frame', multiple: rational(1n) },
    { label: 'within-two-frames', multiple: rational(2n) },
    { label: 'beyond-two-frames', multiple: null },
  ])
  const histogram = fractions.map((bucket, index) => {
    const upper = bucket.multiple === null ? null : multiplyRational(ticksPerFrame, bucket.multiple)
    const lower = index === 0 ? null : multiplyRational(ticksPerFrame, fractions[index - 1]!.multiple!)
    const inBucket = absolute.filter((value) => {
      const asRational = rational(value)
      const aboveLower = lower === null ? true : compareRational(asRational, lower) > 0
      const belowUpper = upper === null ? true : compareRational(asRational, upper) <= 0
      return aboveLower && belowUpper
    })
    return Object.freeze({
      label: bucket.label,
      upperBoundTicks: upper === null ? null : upper.num / upper.den,
      count: inBucket.length,
    })
  })

  return Object.freeze({
    count,
    minTicks: values.reduce((a, b) => (b < a ? b : a), values[0] ?? 0n),
    maxTicks: values.reduce((a, b) => (b > a ? b : a), values[0] ?? 0n),
    maxAbsTicks: absolute[absolute.length - 1] ?? 0n,
    meanAbsTicks: count === 0 ? rational(0n) : rational(total, BigInt(count)),
    medianAbsTicks: count === 0 ? rational(0n) : median,
    meanSquareTicks: count === 0 ? rational(0n) : rational(squares, BigInt(count)),
    histogram: Object.freeze(histogram),
  })
}

function residualsAgainst(
  anchors: readonly Readonly<DriftAnchor>[],
  rate: Rational,
  offsetTicks: bigint,
  rounding: RoundingPolicy,
): readonly Readonly<AnchorResidual>[] {
  const map = createAffineClockMap({ rate, offsetTicks, rounding })
  // Residuals are measured against the map that will actually be applied,
  // rounding included. Measuring against the unrounded ideal would understate
  // the error by exactly the amount the integer representation introduces.
  return Object.freeze(
    anchors.map((anchor) =>
      Object.freeze({
        anchorId: anchor.id,
        residualTicks: anchor.sessionTick - applyAffineClockMap(map, anchor.sourceTick),
      }),
    ),
  )
}

function proposeSplit(
  anchors: readonly Readonly<DriftAnchor>[],
  residuals: readonly Readonly<AnchorResidual>[],
  targetTicks: Rational,
): Readonly<DriftSplitProposal> | null {
  if (residuals.length < 4) return null
  const values = residuals.map((entry) => entry.residualTicks)
  let bestIndex = -1
  let bestJump = 0n
  for (let index = 0; index + 1 < values.length; index += 1) {
    const jump = absBigInt(values[index + 1]! - values[index]!)
    if (jump > bestJump) {
      bestJump = jump
      bestIndex = index
    }
  }
  if (bestIndex < 0) return null
  const spread = values.reduce((a, b) => (b > a ? b : a)) - values.reduce((a, b) => (b < a ? b : a))
  // A boundary is only proposed when one step dominates the whole spread. A
  // residual that grows smoothly is a wrong rate, not a discontinuity, and
  // splitting it would hide a fit problem behind an invented recorder event.
  if (compareRational(rational(bestJump), targetTicks) <= 0) return null
  if (bestJump * 2n < spread) return null
  return Object.freeze({
    afterAnchorId: anchors[bestIndex]!.id,
    beforeAnchorId: anchors[bestIndex + 1]!.id,
    jumpTicks: bestJump,
  })
}

export function driftToleranceRate(clock: Readonly<SessionClock>, windowSeconds: bigint): Rational {
  assertDomain(windowSeconds > 0n, 'INVALID_ARGUMENT', 'the drift tolerance window must be positive')
  // One frame accumulated over the window: 1 / (framesPerSecond × seconds).
  return divideRational(rational(1n), multiplyRational(clock.frameRate, rational(windowSeconds)))
}

export function fitClockDrift(input: {
  clock: Readonly<SessionClock>
  source: Readonly<SourceClock>
  anchors: readonly Readonly<DriftAnchor>[]
  /** The source range the model has to hold over, half-open. */
  span: Readonly<TickInterval>
  /**
   * Whether the corrected media carries speech. Omitted means yes: assuming a
   * track is instrument-only or silent, and stretching it, is the failure this
   * defaults against.
   */
  carriesSpeech?: boolean
  policy?: Readonly<DriftPolicy>
  rounding?: RoundingPolicy
}): ClockDriftFit {
  const policy = input.policy ?? DEFAULT_DRIFT_POLICY
  const rounding = input.rounding ?? SESSION_CLOCK_ROUNDING
  const carriesSpeech = input.carriesSpeech ?? true

  const rejected: AnchorRejection[] = []
  const inSpan = [...input.anchors]
    .sort(compareAnchors)
    .filter((anchor) => {
      if (intervalContains(input.span, anchor.sourceTick)) return true
      rejected.push(Object.freeze({ anchorId: anchor.id, reason: 'outside-span' as const }))
      return false
    })

  // A contradiction is not noise. One source instant cannot be two session
  // instants, and the mean of the two is a number that describes neither.
  const bySourceTick = new Map<string, Readonly<DriftAnchor>[]>()
  for (const anchor of inSpan) {
    const key = anchor.sourceTick.toString()
    const bucket = bySourceTick.get(key)
    if (bucket) bucket.push(anchor)
    else bySourceTick.set(key, [anchor])
  }
  const usable: Readonly<DriftAnchor>[] = []
  for (const bucket of bySourceTick.values()) {
    const distinct = new Set(bucket.map((anchor) => anchor.sessionTick.toString()))
    if (distinct.size > 1) {
      return Object.freeze({
        status: 'insufficient-evidence',
        schemaVersion: CLOCK_DRIFT_SCHEMA_VERSION,
        reason: 'conflicting-anchors',
        detail: `anchors ${bucket.map((anchor) => anchor.id).join(', ')} place source tick ${bucket[0]!.sourceTick} at ${distinct.size} different session instants`,
        distribution: null,
        usedAnchorIds: Object.freeze([]),
        rejected: Object.freeze([...rejected]),
      } as const)
    }
    usable.push(bucket[0]!)
    // Identical repeats carry no new information about the line but would
    // weight it, so they are collapsed and named rather than silently kept.
    for (const duplicate of bucket.slice(1)) {
      rejected.push(Object.freeze({ anchorId: duplicate.id, reason: 'duplicate' as const }))
    }
  }
  usable.sort(compareAnchors)

  if (usable.length === 0 && rejected.some((entry) => entry.reason === 'outside-span')) {
    return Object.freeze({
      status: 'insufficient-evidence',
      schemaVersion: CLOCK_DRIFT_SCHEMA_VERSION,
      reason: 'anchors-outside-span',
      detail: 'every anchor falls outside the span the model must cover',
      distribution: null,
      usedAnchorIds: Object.freeze([]),
      rejected: Object.freeze([...rejected]),
    } as const)
  }
  if (usable.length < 2) {
    return Object.freeze({
      status: 'insufficient-evidence',
      schemaVersion: CLOCK_DRIFT_SCHEMA_VERSION,
      reason: 'too-few-anchors',
      detail: `a rate needs at least two distinct anchors; ${usable.length} usable`,
      distribution: usable.length === 0 ? null : describeDistribution(usable, input.span),
      usedAnchorIds: Object.freeze(usable.map((anchor) => anchor.id)),
      rejected: Object.freeze([...rejected]),
    } as const)
  }

  const distribution = describeDistribution(usable, input.span)
  // Anchors bunched at one end measure an offset, not a rate. Extrapolating a
  // slope from them across the rest of the session is the failure this gate
  // exists to make impossible.
  if (
    distribution.occupiedThirds < policy.minimumOccupiedThirds ||
    compareRational(distribution.spanCoverage, policy.minimumSpanCoverage) < 0
  ) {
    return Object.freeze({
      status: 'insufficient-evidence',
      schemaVersion: CLOCK_DRIFT_SCHEMA_VERSION,
      reason: 'anchors-clustered',
      detail: `anchors occupy ${distribution.occupiedThirds} of 3 thirds and reach across ${distribution.spanCoverage.num}/${distribution.spanCoverage.den} of the span`,
      distribution,
      usedAnchorIds: Object.freeze(usable.map((anchor) => anchor.id)),
      rejected: Object.freeze([...rejected]),
    } as const)
  }

  const points = usable.map((anchor) => ({ x: anchor.sourceTick, y: anchor.sessionTick }))
  const solution = fitOrdinaryLeastSquares(points)
  if (solution === null) {
    return Object.freeze({
      status: 'insufficient-evidence',
      schemaVersion: CLOCK_DRIFT_SCHEMA_VERSION,
      reason: 'degenerate-source-span',
      detail: 'every anchor sits at the same source tick, so no rate is determined',
      distribution,
      usedAnchorIds: Object.freeze(usable.map((anchor) => anchor.id)),
      rejected: Object.freeze([...rejected]),
    } as const)
  }
  if (solution.rate.num <= 0n) {
    return Object.freeze({
      status: 'insufficient-evidence',
      schemaVersion: CLOCK_DRIFT_SCHEMA_VERSION,
      reason: 'non-positive-rate',
      detail: `the anchors imply a rate of ${solution.rate.num}/${solution.rate.den}; session time cannot stand still or run backwards`,
      distribution,
      usedAnchorIds: Object.freeze(usable.map((anchor) => anchor.id)),
      rejected: Object.freeze([...rejected]),
    } as const)
  }

  const offsetTicks = roundRationalToTicks(solution.offset)
  const residuals = residualsAgainst(usable, solution.rate, offsetTicks, rounding)
  const ticksPerFrame = sessionTicksPerFrame(input.clock)
  const residualDistribution = summarizeResiduals(residuals, ticksPerFrame)
  const targetTicks = multiplyRational(ticksPerFrame, rational(policy.residualTargetFrames))

  // Hold-out validation. The published model above uses every valid anchor;
  // this second fit exists only so the residual can be measured on anchors the
  // model never saw. A model checked against its own training points reports
  // how well it memorized, not how well it predicts.
  const holdOut = validateOnHeldOutAnchors(usable, ticksPerFrame, rounding, policy)

  const holdOutMax = holdOut.status === 'validated' ? holdOut.maxAbsTicks : 0n
  const effectiveMaxResidual =
    residualDistribution.maxAbsTicks > holdOutMax ? residualDistribution.maxAbsTicks : holdOutMax
  const withinTarget = compareRational(rational(effectiveMaxResidual), targetTicks) <= 0
  const splitProposal = proposeSplit(usable, residuals, targetTicks)
  const decision: 'auto-apply' | 'review' | 'new-piece' = withinTarget
    ? 'auto-apply'
    : splitProposal !== null
      ? 'new-piece'
      : 'review'

  const driftRate = extractDriftRate({
    rate: solution.rate,
    source: input.source.timebase,
    session: input.clock.timebase,
  })
  const limitRate = driftToleranceRate(input.clock, policy.toleranceWindowSeconds)
  const deviation = absRational(subtractRational(driftRate, rational(1n)))
  const withinTolerance = compareRational(deviation, limitRate) <= 0
  const speechLimitRate = rational(BigInt(policy.speechStretchLimitPpm), 1_000_000n)

  const correction: Readonly<DriftCorrectionDecision> = Object.freeze(
    withinTolerance
      ? {
          action: 'none' as const,
          reason: 'within-tolerance' as const,
          carriesSpeech,
          speechStretchLimitPpm: policy.speechStretchLimitPpm,
        }
      : carriesSpeech && compareRational(deviation, speechLimitRate) > 0
        ? {
            action: 'refused' as const,
            reason: 'unsafe-speech-stretch' as const,
            carriesSpeech,
            speechStretchLimitPpm: policy.speechStretchLimitPpm,
          }
        : !withinTarget
          ? {
              action: 'refused' as const,
              reason: 'unverified-residual' as const,
              carriesSpeech,
              speechStretchLimitPpm: policy.speechStretchLimitPpm,
            }
          : {
              action: 'apply-rate' as const,
              reason: 'measured-drift' as const,
              carriesSpeech,
              speechStretchLimitPpm: policy.speechStretchLimitPpm,
            },
  )

  return Object.freeze({
    status: 'fitted',
    schemaVersion: CLOCK_DRIFT_SCHEMA_VERSION,
    driftRate,
    driftPpm: rationalToPpm(driftRate),
    offsetTicks,
    rounding,
    distribution,
    usedAnchorIds: Object.freeze(usable.map((anchor) => anchor.id)),
    rejected: Object.freeze([...rejected]),
    residuals,
    residualDistribution,
    outlierAnchorIds: Object.freeze(
      residuals
        .filter((entry) => compareRational(rational(absBigInt(entry.residualTicks)), targetTicks) > 0)
        .map((entry) => entry.anchorId),
    ),
    holdOut,
    tolerance: Object.freeze({
      limitRate,
      limitPpm: rationalToPpm(addRational(rational(1n), limitRate)),
      withinTolerance,
    }),
    correction,
    decision,
    splitProposal,
    residualBoundTicks: effectiveMaxResidual,
  } as const)
}

function validateOnHeldOutAnchors(
  usable: readonly Readonly<DriftAnchor>[],
  ticksPerFrame: Rational,
  rounding: RoundingPolicy,
  policy: Readonly<DriftPolicy>,
): HoldOutValidation {
  if (usable.length < policy.minimumAnchorsForHoldOut) {
    return Object.freeze({ status: 'not-performed', reason: 'too-few-anchors' } as const)
  }
  // Every third anchor, never the first or the last: the held-out set is spread
  // across the whole span and the training set keeps its full baseline, so the
  // check is independent without being a different experiment.
  const heldOut: Readonly<DriftAnchor>[] = []
  const training: Readonly<DriftAnchor>[] = []
  usable.forEach((anchor, index) => {
    if (index % 3 === 1 && index > 0 && index < usable.length - 1) heldOut.push(anchor)
    else training.push(anchor)
  })
  if (heldOut.length < 2 || training.length < 2) {
    return Object.freeze({ status: 'not-performed', reason: 'too-few-anchors' } as const)
  }
  const solution = fitOrdinaryLeastSquares(training.map((anchor) => ({ x: anchor.sourceTick, y: anchor.sessionTick })))
  if (solution === null || solution.rate.num <= 0n) {
    return Object.freeze({ status: 'not-performed', reason: 'training-set-degenerate' } as const)
  }
  const offsetTicks = roundRationalToTicks(solution.offset)
  const residuals = residualsAgainst(heldOut, solution.rate, offsetTicks, rounding)
  const residualDistribution = summarizeResiduals(residuals, ticksPerFrame)
  return Object.freeze({
    status: 'validated',
    trainingAnchorIds: Object.freeze(training.map((anchor) => anchor.id)),
    heldOutAnchorIds: Object.freeze(heldOut.map((anchor) => anchor.id)),
    // Reported as a full rate here on purpose: the validation fit is a
    // diagnostic of the same quantity the published model estimates, and
    // converting it needs the same timebases the caller already has.
    driftRate: solution.rate,
    driftPpm: rationalToPpm(solution.rate),
    offsetTicks,
    residuals,
    residualDistribution,
    maxAbsTicks: residualDistribution.maxAbsTicks,
  } as const)
}

/** Spec 05 §18.1, mapped onto the confidence a mapping may carry. */
export function confidenceFromDriftFit(decision: 'auto-apply' | 'review' | 'new-piece'): ClockConfidence {
  return decision === 'auto-apply' ? 'high' : decision === 'review' ? 'medium' : 'low'
}

/**
 * Turn a successful fit into the mapping the session clock will actually serve.
 *
 * The mapping constructor re-checks the confidence against the precision bound,
 * so a fit that called itself `auto-apply` on a residual it cannot support is
 * rejected here rather than published.
 */
export function createMappingFromDriftFit(input: {
  clock: Readonly<SessionClock>
  source: Readonly<SourceClock>
  fit: Extract<ClockDriftFit, { status: 'fitted' }>
  sourceCoverage: Readonly<TickInterval>
  confidence?: ClockConfidence
  evidenceRefs: readonly string[]
}): Readonly<SourceToSessionMapping> {
  return createSourceToSessionMapping({
    clock: input.clock,
    source: input.source,
    sourceCoverage: input.sourceCoverage,
    // A refused or withheld correction still yields a mapping — it simply
    // carries no rate correction, because the offset is evidence too.
    driftRate: input.fit.correction.action === 'apply-rate' ? input.fit.driftRate : rational(1n),
    offsetTicks: input.fit.offsetTicks,
    residualBoundTicks: input.fit.residualBoundTicks,
    confidence: input.confidence ?? confidenceFromDriftFit(input.fit.decision),
    anchorIds: input.fit.usedAnchorIds,
    evidenceRefs: input.evidenceRefs,
    rounding: input.fit.rounding,
  })
}
