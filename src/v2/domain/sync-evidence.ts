import { assertDomain } from './errors.ts'
import {
  applyAffineClockMap,
  canonicalizeIntervals,
  compareIntervals,
  compareRational,
  convertTick,
  createAffineClockMap,
  createTickInterval,
  divideRational,
  intervalDuration,
  intervalIntersection,
  multiplyRational,
  rational,
  rationalToPpm,
  serializeRational,
  serializeTickInterval,
  type AffineClockMap,
  type Rational,
  type TickInterval,
  type Timebase,
} from './session-time.ts'

/**
 * F4.004 — the synchronization evidence cascade (FR-142, ADR-130, spec 05 §8).
 *
 * This module answers one question and refuses to answer it badly: *given
 * everything we observed about two tracks, which alignment may we trust, how
 * much, and what do we owe the operator when we cannot tell?*
 *
 * ## Why this is not "take the highest score"
 *
 * The obvious implementation ranks signals by a confidence number and takes the
 * winner. It is wrong for a structural reason, not an aesthetic one: the score
 * is produced *by the method being scored*. A cross-correlator that found a
 * strong but wrong peak reports 0.95 with complete sincerity; a shared timecode
 * reports 0.80 because its own metadata was only sampled twice. Ranking by
 * score lets the confident guess outrank the boring fact, and the failure is
 * silent — a wrong offset looks exactly like a right one downstream.
 *
 * Precedence is therefore **lexicographic and not tradeable**. A method's tier
 * encodes how the evidence was produced: a shared clock is a measurement of the
 * same instant by construction, a correlation peak is an inference from
 * similarity. No amount of self-reported confidence converts the second into
 * the first. Score only ever orders signals *inside* one tier.
 *
 * ## The cascade, in precedence order
 *
 * 1. shared timecode / trustworthy metadata — one clock, no inference;
 * 2. an Apollo Marker already detected — a deliberately emitted, sequence
 *    numbered, dual-modality event (detection itself is F4.010, out of scope
 *    here: the marker arrives as given evidence);
 * 3. shared audio / fingerprint — a common acoustic event, inferred;
 * 4. visual event — a common visible event, inferred, coarser;
 * 5. transcript / lip evidence — secondary only, never elected to auto-apply
 *    (spec 05 §19: a validator, not an authority);
 * 6. manual anchor — the operator's own statement, the documented fallback.
 *
 * Spec 05 §8 lists audio fingerprint above the marker in its table row order.
 * That table documents *precision targets and typical failures*, not
 * precedence; §14.1 places the Apollo Marker above opportunistic audio, and so
 * does this module. The marker's precondition ("this exact sequence number was
 * observed in both tracks") is verifiable; "the tracks sound alike here" is
 * not.
 *
 * ## What is weighed, and all of it is persisted
 *
 * precedence, preconditions, independence of the signals, ambiguity, peak vs
 * second-peak separation, temporal distribution of anchors, residual, coverage,
 * confidence, and contradictions between signals. Every one of them appears in
 * the record, per signal, with the threshold that was actually applied — so a
 * disputed sync can be re-argued from the record instead of re-run from
 * memory.
 *
 * ## The rule that outranks the rest
 *
 * **Contradictory or insufficient evidence never yields an offset.** The
 * outcome is `insufficient-evidence`, `clockMap` is `null`, and
 * `manualRequired` is true. A cascade that guesses is worse than one that
 * refuses, because a refusal is visible and a guess is not.
 *
 * Ticks are `bigint` in the session timebase and offsets stay exact end to end.
 * Scores are floats because they only ever *rank*; nothing numeric that reaches
 * the timeline is derived from one.
 */

export const SYNC_EVIDENCE_SCHEMA_VERSION = 'sync-evidence/v1' as const

/** Ordered so the index doubles as the deterministic within-tier tiebreak. */
export const SYNC_METHODS = [
  'shared-timecode',
  'trusted-metadata',
  'apollo-marker',
  'audio-fingerprint',
  'visual-event',
  'transcript-lip',
  'manual-anchor',
] as const
export type SyncMethod = (typeof SYNC_METHODS)[number]

/**
 * The tier. Lower is stronger. Two methods share a tier when the *kind* of
 * evidence is the same — a shared timecode and trustworthy recorder metadata
 * are both "one clock, read directly".
 */
export const SYNC_METHOD_PRECEDENCE: Readonly<Record<SyncMethod, number>> = Object.freeze({
  'shared-timecode': 1,
  'trusted-metadata': 1,
  'apollo-marker': 2,
  'audio-fingerprint': 3,
  'visual-event': 4,
  'transcript-lip': 5,
  'manual-anchor': 6,
})

/**
 * Preconditions a provider must have checked before the signal is even
 * considered. Declaring them is not paperwork: it is what stops
 * `trusted-metadata` from degenerating into "the filenames sort the same way",
 * which spec 05 §2 lists as an explicit non-goal. A missing id is treated as an
 * unmet precondition, never as a pass.
 */
export const REQUIRED_SYNC_PRECONDITIONS: Readonly<Record<SyncMethod, readonly string[]>> = Object.freeze({
  'shared-timecode': Object.freeze(['shared-clock-declared', 'timecode-continuous']),
  'trusted-metadata': Object.freeze(['metadata-origin-trusted', 'metadata-not-derived-from-filename']),
  'apollo-marker': Object.freeze(['marker-sequence-matched', 'marker-observed-in-both-tracks']),
  'audio-fingerprint': Object.freeze(['both-tracks-carry-audio', 'common-acoustic-event']),
  'visual-event': Object.freeze(['event-visible-in-both-tracks']),
  'transcript-lip': Object.freeze(['speech-present', 'transcript-aligned-to-media']),
  'manual-anchor': Object.freeze(['operator-identified', 'anchor-reviewable']),
})

/**
 * Methods that locate the offset by *searching* must report what the search
 * nearly chose instead. Without a second peak there is no way to tell a lock
 * from a coincidence. Methods that read a clock have no search and no second
 * peak, so demanding one from them would only invite a fabricated number.
 */
export const SYNC_METHODS_REQUIRING_AMBIGUITY_EVIDENCE: Readonly<Record<SyncMethod, boolean>> = Object.freeze({
  'shared-timecode': false,
  'trusted-metadata': false,
  'apollo-marker': true,
  'audio-fingerprint': true,
  'visual-event': true,
  'transcript-lip': true,
  'manual-anchor': false,
})

/**
 * Spec 05 §19. Lip/transcript agreement confirms a map; it must not become one
 * on its own, because the same evidence is consistent with a whole family of
 * offsets a few frames apart.
 */
export const SECONDARY_ONLY_SYNC_METHODS: Readonly<Record<SyncMethod, boolean>> = Object.freeze({
  'shared-timecode': false,
  'trusted-metadata': false,
  'apollo-marker': false,
  'audio-fingerprint': false,
  'visual-event': false,
  'transcript-lip': true,
  'manual-anchor': false,
})

export const SYNC_OUTCOMES = ['auto-apply', 'review', 'insufficient-evidence'] as const
export type SyncOutcome = (typeof SYNC_OUTCOMES)[number]

export const SYNC_DISCARD_REASONS = [
  'precondition-unmet',
  'ambiguity-evidence-missing',
  'ambiguous-peak',
  'residual-above-method-limit',
  'coverage-below-floor',
  'confidence-below-floor',
  'no-anchors',
  'outranked-by-precedence',
  'lower-ranked-within-tier',
  'contradicted-by-independent-signal',
] as const
export type SyncDiscardReason = (typeof SYNC_DISCARD_REASONS)[number]

export const CONTRADICTION_SEVERITIES = ['soft', 'hard'] as const
export type ContradictionSeverity = (typeof CONTRADICTION_SEVERITIES)[number]

/** A precondition the provider claims to have checked, and the result. */
export interface SyncPrecondition {
  readonly id: string
  readonly satisfied: boolean
  readonly detail: string
}

/**
 * How close the runner-up came. `peakRatio` is `best / secondBest`; a ratio
 * near 1 means the search could have picked either, which is exactly the
 * situation in which an offset must not be invented.
 */
export interface SyncAmbiguityEvidence {
  readonly bestPeak: number
  readonly secondBestPeak: number
  readonly windowsConsidered: number
  readonly windowsAgreeing: number
}

/** One measured correspondence between a source instant and a session instant. */
export interface SyncAnchorObservation {
  readonly anchorId: string
  readonly sourceTick: bigint
  readonly sessionTick: bigint
  readonly evidenceRef: string
}

/**
 * A single candidate alignment, as reported by one provider.
 *
 * `offsetTicks` and every anchor are counted in `timebase`; the cascade
 * converts them into the session timebase exactly once, with the kernel, and
 * never lets a provider's timebase leak downstream.
 */
export interface SyncSignalObservation {
  readonly signalId: string
  readonly method: SyncMethod
  readonly timebase: Readonly<Timebase>
  /** `session = offsetTicks + rate * source`, offset counted in `timebase`. */
  readonly offsetTicks: bigint
  /** Measured clock rate, when the provider measured one. Absent means "not measured", never "1.0". */
  readonly rate?: Rational
  readonly anchors: readonly Readonly<SyncAnchorObservation>[]
  readonly preconditions: readonly Readonly<SyncPrecondition>[]
  readonly ambiguity?: Readonly<SyncAmbiguityEvidence>
  /** Session-tick ranges this signal actually supports. Outside them it proves nothing. */
  readonly coverage: readonly Readonly<TickInterval>[]
  /** Largest absolute residual at the validation anchors, counted in `timebase`. */
  readonly residualTicks: bigint
  /** The provider's own confidence in [0,1]. Read as a claim, not as a fact. */
  readonly confidence: number
  /**
   * Signals sharing a group share a physical measurement and therefore cannot
   * corroborate — nor meaningfully contradict — one another. Two windows of the
   * same correlation are one opinion, not two.
   */
  readonly independenceGroup: string
  readonly evidenceRefs: readonly string[]
}

export interface SyncEvidenceThresholds {
  readonly schemaVersion: typeof SYNC_EVIDENCE_SCHEMA_VERSION
  /** Below this peak ratio the search did not lock; the signal is not considered. */
  readonly minimumPeakRatioForAdmission: number
  /** Spec 05 §9.1: at or above this, and consistent across windows, is "high". */
  readonly minimumPeakRatioForAutoApply: number
  readonly minimumAgreeingWindowsForAutoApply: number
  /** Per-method residual ceilings, in session frames (spec 05 §8 precision targets). */
  readonly maximumResidualFramesByMethod: Readonly<Record<SyncMethod, number>>
  /** Spec 05 §10: a linear map may only be called high confidence within 2 frames. */
  readonly maximumResidualFramesForAutoApply: number
  readonly minimumCoverageRatioForAdmission: number
  readonly minimumCoverageRatioForAutoApply: number
  readonly minimumConfidenceForAdmission: number
  readonly minimumConfidenceForAutoApply: number
  readonly minimumAnchorsForAutoApply: number
  /** Anchors must occupy at least this many thirds of the session (start/middle/end). */
  readonly minimumAnchorThirdsForAutoApply: number
  /** Independent signals disagreeing by more than this many frames are in conflict. */
  readonly softContradictionFrames: number
  /** Beyond this the conflict is irreconcilable and no offset may be emitted. */
  readonly hardContradictionFrames: number
  /** How the score is composed. Ranking only — nothing on the timeline comes from it. */
  readonly scoreWeights: Readonly<{
    ambiguity: number
    residual: number
    anchorDistribution: number
    coverage: number
    confidence: number
    corroboration: number
  }>
}

export const DEFAULT_SYNC_EVIDENCE_THRESHOLDS: Readonly<SyncEvidenceThresholds> = Object.freeze({
  schemaVersion: SYNC_EVIDENCE_SCHEMA_VERSION,
  minimumPeakRatioForAdmission: 1.2,
  minimumPeakRatioForAutoApply: 1.5,
  minimumAgreeingWindowsForAutoApply: 2,
  maximumResidualFramesByMethod: Object.freeze({
    'shared-timecode': 1,
    'trusted-metadata': 2,
    'apollo-marker': 2,
    'audio-fingerprint': 2,
    'visual-event': 3,
    'transcript-lip': 10,
    'manual-anchor': 3,
  }),
  maximumResidualFramesForAutoApply: 2,
  minimumCoverageRatioForAdmission: 0.05,
  minimumCoverageRatioForAutoApply: 0.6,
  minimumConfidenceForAdmission: 0.35,
  minimumConfidenceForAutoApply: 0.8,
  minimumAnchorsForAutoApply: 2,
  minimumAnchorThirdsForAutoApply: 2,
  softContradictionFrames: 1,
  hardContradictionFrames: 5,
  scoreWeights: Object.freeze({
    ambiguity: 0.25,
    residual: 0.25,
    anchorDistribution: 0.15,
    coverage: 0.15,
    confidence: 0.1,
    corroboration: 0.1,
  }),
})

/** Everything measured about one signal, admissible or not. All of it persists. */
export interface SyncSignalAssessment {
  readonly signalId: string
  readonly method: SyncMethod
  readonly precedence: number
  readonly independenceGroup: string
  /** The offset converted into the session timebase. Exact. */
  readonly sessionOffsetTicks: bigint
  readonly rate: Rational
  readonly rateMeasured: boolean
  readonly ratePpm: number
  readonly residualSessionTicks: bigint
  readonly residualFrames: number
  readonly anchorCount: number
  readonly anchorThirdsOccupied: number
  readonly anchorSpanRatio: number
  readonly coverageRatio: number
  readonly coveredSessionTicks: bigint
  readonly peakRatio: number | null
  readonly windowsConsidered: number
  readonly windowsAgreeing: number
  readonly reportedConfidence: number
  readonly unmetPreconditions: readonly string[]
  readonly independentAgreements: number
  readonly independentDisagreements: number
  readonly admissible: boolean
  readonly inadmissibleReasons: readonly SyncDiscardReason[]
  /** Within-tier ranking aid in [0,1]. Never compared across tiers. */
  readonly score: number
  readonly autoApplyBlockers: readonly string[]
  readonly evidenceRefs: readonly string[]
}

export interface SyncContradiction {
  readonly signalId: string
  readonly method: SyncMethod
  readonly againstSignalId: string
  readonly deltaSessionTicks: bigint
  readonly deltaFrames: number
  readonly severity: ContradictionSeverity
}

export interface SyncCorroboration {
  readonly signalId: string
  readonly method: SyncMethod
  readonly independenceGroup: string
  readonly deltaSessionTicks: bigint
  readonly deltaFrames: number
}

export interface SyncDiscardedAlternative {
  readonly signalId: string
  readonly method: SyncMethod
  readonly precedence: number
  readonly score: number
  readonly reason: SyncDiscardReason
  readonly detail: string
}

export interface SyncEvidenceRecord {
  readonly schemaVersion: typeof SYNC_EVIDENCE_SCHEMA_VERSION
  readonly sessionId: string
  readonly trackId: string
  readonly referenceTrackId: string
  readonly sessionTimebase: Readonly<Timebase>
  readonly sessionFrameRate: Rational
  readonly sessionBounds: Readonly<TickInterval>
  readonly outcome: SyncOutcome
  readonly manualRequired: boolean
  readonly selectedSignalId: string | null
  readonly selectedMethod: SyncMethod | null
  /** `null` whenever the outcome is `insufficient-evidence`. Enforced, not merely intended. */
  readonly clockMap: Readonly<AffineClockMap> | null
  readonly assessments: readonly Readonly<SyncSignalAssessment>[]
  readonly discarded: readonly Readonly<SyncDiscardedAlternative>[]
  readonly contradictions: readonly Readonly<SyncContradiction>[]
  readonly corroborations: readonly Readonly<SyncCorroboration>[]
  readonly outcomeReasons: readonly string[]
  readonly thresholds: Readonly<SyncEvidenceThresholds>
}

const IDENTIFIER = /^[A-Za-z0-9][A-Za-z0-9._:-]{0,127}$/
const MAX_SIGNALS = 512
const MAX_ANCHORS_PER_SIGNAL = 4096
/**
 * A second peak of zero would make the ratio infinite, which is not a number
 * that can be persisted or compared. The cap says "cleanly separated" without
 * pretending to a precision the measurement does not have.
 */
export const MAXIMUM_REPORTABLE_PEAK_RATIO = 1_000

function roundScore(value: number): number {
  return Math.round(value * 1e6) / 1e6
}

function clamp01(value: number): number {
  if (!Number.isFinite(value)) return 0
  return value < 0 ? 0 : value > 1 ? 1 : value
}

function absBigInt(value: bigint): bigint {
  return value < BigInt(0) ? -value : value
}

/**
 * Session ticks per frame, exactly.
 *
 * Thresholds in this module are stated in frames because that is the unit the
 * spec calibrates and the unit an operator can see. Converting them through a
 * rational keeps 30000/1001 exact instead of turning it into 29.97.
 */
export function sessionTicksPerFrame(
  sessionTimebase: Readonly<Timebase>,
  sessionFrameRate: Rational,
): Rational {
  assertDomain(sessionFrameRate.num > BigInt(0), 'INVALID_ARGUMENT', 'Session frame rate must be strictly positive')
  const secondsPerFrame = rational(sessionFrameRate.den, sessionFrameRate.num)
  return divideRational(secondsPerFrame, sessionTimebase.secondsPerTick)
}

/** A frame threshold as a tick count, rounded up: a boundary must not exclude what it names. */
function frameThresholdToTicks(ticksPerFrame: Rational, frames: number): bigint {
  const scaled = multiplyRational(ticksPerFrame, rational(Math.round(frames * 1_000_000), 1_000_000))
  const quotient = scaled.num / scaled.den
  return scaled.num % scaled.den === BigInt(0) ? quotient : quotient + BigInt(1)
}

function ticksToFrames(ticksPerFrame: Rational, ticks: bigint): number {
  const value = Number(ticks) / (Number(ticksPerFrame.num) / Number(ticksPerFrame.den))
  return Number.isFinite(value) ? Math.round(value * 1e4) / 1e4 : Number.POSITIVE_INFINITY
}

function validateObservation(observation: Readonly<SyncSignalObservation>): void {
  assertDomain(IDENTIFIER.test(observation.signalId), 'INVALID_ARGUMENT', 'A sync signal needs a well-formed id')
  assertDomain(
    (SYNC_METHODS as readonly string[]).includes(observation.method),
    'INVALID_ARGUMENT',
    `Unknown sync method: ${observation.method}`,
  )
  assertDomain(
    typeof observation.independenceGroup === 'string' && observation.independenceGroup.length > 0,
    'INVALID_ARGUMENT',
    'A sync signal must declare which measurement it came from (independenceGroup)',
  )
  assertDomain(
    Number.isFinite(observation.confidence) && observation.confidence >= 0 && observation.confidence <= 1,
    'INVALID_ARGUMENT',
    'Reported sync confidence must be a number in [0,1]',
  )
  assertDomain(observation.residualTicks >= BigInt(0), 'INVALID_ARGUMENT', 'A residual is a magnitude and cannot be negative')
  assertDomain(
    observation.anchors.length <= MAX_ANCHORS_PER_SIGNAL,
    'INVALID_ARGUMENT',
    'A sync signal carries more anchors than can be assessed',
  )
  if (observation.rate) {
    assertDomain(observation.rate.num > BigInt(0), 'INVALID_ARGUMENT', 'A measured clock rate must be strictly positive')
  }
  if (observation.ambiguity) {
    const { bestPeak, secondBestPeak, windowsConsidered, windowsAgreeing } = observation.ambiguity
    assertDomain(
      Number.isFinite(bestPeak) && bestPeak >= 0 && Number.isFinite(secondBestPeak) && secondBestPeak >= 0,
      'INVALID_ARGUMENT',
      'Correlation peaks must be finite, non-negative numbers',
    )
    assertDomain(
      Number.isSafeInteger(windowsConsidered) &&
        windowsConsidered >= 0 &&
        Number.isSafeInteger(windowsAgreeing) &&
        windowsAgreeing >= 0 &&
        windowsAgreeing <= windowsConsidered,
      'INVALID_ARGUMENT',
      'Window agreement counts must be integers with agreeing <= considered',
    )
  }
}

export function peakRatioOf(ambiguity: Readonly<SyncAmbiguityEvidence> | undefined): number | null {
  if (!ambiguity) return null
  if (ambiguity.bestPeak <= 0) return 0
  if (ambiguity.secondBestPeak <= 0) return MAXIMUM_REPORTABLE_PEAK_RATIO
  const ratio = ambiguity.bestPeak / ambiguity.secondBestPeak
  return Math.round(Math.min(ratio, MAXIMUM_REPORTABLE_PEAK_RATIO) * 1e4) / 1e4
}

/**
 * How the anchors are spread across the session.
 *
 * Three anchors in the first ten seconds are one anchor with error bars: they
 * pin the offset and say nothing about drift. Occupied thirds is the cheapest
 * honest description of "start, middle and end were all seen".
 */
function anchorDistribution(
  anchors: readonly Readonly<SyncAnchorObservation>[],
  bounds: Readonly<TickInterval>,
): Readonly<{ thirdsOccupied: number; spanRatio: number }> {
  if (anchors.length === 0) return Object.freeze({ thirdsOccupied: 0, spanRatio: 0 })
  const total = intervalDuration(bounds)
  const thirds = new Set<number>()
  let earliest = anchors[0].sessionTick
  let latest = anchors[0].sessionTick
  for (const anchor of anchors) {
    if (anchor.sessionTick < earliest) earliest = anchor.sessionTick
    if (anchor.sessionTick > latest) latest = anchor.sessionTick
    const offset = anchor.sessionTick - bounds.start
    if (offset < BigInt(0) || offset >= total) continue
    const third = Number((offset * BigInt(3)) / total)
    thirds.add(third > 2 ? 2 : third)
  }
  const span = latest - earliest
  const spanRatio = total > BigInt(0) ? Math.min(1, Number(span) / Number(total)) : 0
  return Object.freeze({ thirdsOccupied: thirds.size, spanRatio: Math.round(spanRatio * 1e4) / 1e4 })
}

function coverageOf(
  coverage: readonly Readonly<TickInterval>[],
  bounds: Readonly<TickInterval>,
): Readonly<{ coveredTicks: bigint; ratio: number }> {
  const clipped = coverage
    .map((interval) => intervalIntersection(interval, bounds))
    .filter((interval): interval is Readonly<TickInterval> => interval !== null)
  if (clipped.length === 0) return Object.freeze({ coveredTicks: BigInt(0), ratio: 0 })
  const { merged } = canonicalizeIntervals(clipped)
  const coveredTicks = merged.reduce((total, interval) => total + intervalDuration(interval), BigInt(0))
  const total = intervalDuration(bounds)
  const ratio = total > BigInt(0) ? Math.min(1, Number(coveredTicks) / Number(total)) : 0
  return Object.freeze({ coveredTicks, ratio: Math.round(ratio * 1e6) / 1e6 })
}

export interface EvaluateSyncEvidenceInput {
  readonly sessionId: string
  readonly trackId: string
  readonly referenceTrackId: string
  readonly sessionTimebase: Readonly<Timebase>
  readonly sessionFrameRate: Rational
  readonly sessionBounds: Readonly<TickInterval>
  readonly signals: readonly Readonly<SyncSignalObservation>[]
  readonly thresholds?: Readonly<SyncEvidenceThresholds>
}

/**
 * Run the cascade.
 *
 * The order of operations is the design:
 *
 * 1. measure every signal against every criterion, admissible or not;
 * 2. cross-compare *independent* signals to find agreement and conflict;
 * 3. elect by precedence tier first, quality only within the elected tier;
 * 4. decide the outcome, and withhold the offset entirely when the evidence
 *    does not support one.
 *
 * Step 2 runs before step 3 on purpose. Contradiction is a property of the set,
 * not of the winner, so it has to be known before anything is elected —
 * otherwise the elected signal is the only one that ever gets challenged.
 */
export function evaluateSyncEvidence(input: EvaluateSyncEvidenceInput): Readonly<SyncEvidenceRecord> {
  assertDomain(IDENTIFIER.test(input.sessionId), 'INVALID_ARGUMENT', 'A capture session needs a well-formed id')
  assertDomain(IDENTIFIER.test(input.trackId), 'INVALID_ARGUMENT', 'A track needs a well-formed id')
  assertDomain(
    IDENTIFIER.test(input.referenceTrackId),
    'INVALID_ARGUMENT',
    'A reference track needs a well-formed id',
  )
  assertDomain(
    input.trackId !== input.referenceTrackId,
    'INVALID_ARGUMENT',
    'A track cannot be synchronized against itself',
  )
  assertDomain(
    input.signals.length <= MAX_SIGNALS,
    'INVALID_ARGUMENT',
    'More sync signals were submitted than a single evaluation may consider',
  )
  assertDomain(
    new Set(input.signals.map((signal) => signal.signalId)).size === input.signals.length,
    'INVALID_ARGUMENT',
    'Sync signal ids must be unique within one evaluation',
  )

  const thresholds = input.thresholds ?? DEFAULT_SYNC_EVIDENCE_THRESHOLDS
  const ticksPerFrame = sessionTicksPerFrame(input.sessionTimebase, input.sessionFrameRate)
  const softContradictionTicks = frameThresholdToTicks(ticksPerFrame, thresholds.softContradictionFrames)
  const hardContradictionTicks = frameThresholdToTicks(ticksPerFrame, thresholds.hardContradictionFrames)

  // --- 1. measure ---------------------------------------------------------
  type Measured = {
    observation: Readonly<SyncSignalObservation>
    sessionOffsetTicks: bigint
    residualSessionTicks: bigint
    residualFrames: number
    rate: Rational
    rateMeasured: boolean
    peakRatio: number | null
    thirdsOccupied: number
    spanRatio: number
    coverageRatio: number
    coveredTicks: bigint
    unmetPreconditions: readonly string[]
    inadmissibleReasons: SyncDiscardReason[]
  }

  const measured: Measured[] = input.signals.map((observation) => {
    validateObservation(observation)
    const sessionOffsetTicks = convertTick({
      tick: observation.offsetTicks,
      from: observation.timebase,
      to: input.sessionTimebase,
    })
    const residualSessionTicks = convertTick({
      tick: observation.residualTicks,
      from: observation.timebase,
      to: input.sessionTimebase,
      rounding: 'ceil',
    })
    const declared = new Map(observation.preconditions.map((item) => [item.id, item.satisfied]))
    const unmetPreconditions = REQUIRED_SYNC_PRECONDITIONS[observation.method].filter(
      (id) => declared.get(id) !== true,
    )
    const distribution = anchorDistribution(observation.anchors, input.sessionBounds)
    const coverage = coverageOf(observation.coverage, input.sessionBounds)
    const peakRatio = peakRatioOf(observation.ambiguity)
    const residualFrames = ticksToFrames(ticksPerFrame, residualSessionTicks)
    const methodResidualLimit = frameThresholdToTicks(
      ticksPerFrame,
      thresholds.maximumResidualFramesByMethod[observation.method],
    )

    const inadmissibleReasons: SyncDiscardReason[] = []
    if (unmetPreconditions.length > 0) inadmissibleReasons.push('precondition-unmet')
    if (observation.anchors.length === 0) inadmissibleReasons.push('no-anchors')
    if (SYNC_METHODS_REQUIRING_AMBIGUITY_EVIDENCE[observation.method] && peakRatio === null) {
      inadmissibleReasons.push('ambiguity-evidence-missing')
    }
    if (peakRatio !== null && peakRatio < thresholds.minimumPeakRatioForAdmission) {
      inadmissibleReasons.push('ambiguous-peak')
    }
    if (residualSessionTicks > methodResidualLimit) inadmissibleReasons.push('residual-above-method-limit')
    if (coverage.ratio < thresholds.minimumCoverageRatioForAdmission) {
      inadmissibleReasons.push('coverage-below-floor')
    }
    if (observation.confidence < thresholds.minimumConfidenceForAdmission) {
      inadmissibleReasons.push('confidence-below-floor')
    }

    return {
      observation,
      sessionOffsetTicks,
      residualSessionTicks,
      residualFrames,
      rate: observation.rate ?? rational(BigInt(1), BigInt(1)),
      rateMeasured: observation.rate !== undefined,
      peakRatio,
      thirdsOccupied: distribution.thirdsOccupied,
      spanRatio: distribution.spanRatio,
      coverageRatio: coverage.ratio,
      coveredTicks: coverage.coveredTicks,
      unmetPreconditions,
      inadmissibleReasons,
    }
  })

  // --- 2. cross-compare independent signals -------------------------------
  // Only admissible signals may challenge or support one another. An
  // inadmissible signal already failed to prove itself; letting it veto a good
  // one would hand the decision to the worst measurement in the set.
  const admissible = measured.filter((item) => item.inadmissibleReasons.length === 0)
  const agreements = new Map<string, number>()
  const disagreements = new Map<string, number>()
  const contradictions: SyncContradiction[] = []
  const corroborations = new Map<string, SyncCorroboration[]>()

  for (const left of admissible) {
    agreements.set(left.observation.signalId, 0)
    disagreements.set(left.observation.signalId, 0)
    corroborations.set(left.observation.signalId, [])
  }
  for (const left of admissible) {
    for (const right of admissible) {
      if (left === right) continue
      if (left.observation.independenceGroup === right.observation.independenceGroup) continue
      const delta = absBigInt(left.sessionOffsetTicks - right.sessionOffsetTicks)
      if (delta <= softContradictionTicks) {
        agreements.set(left.observation.signalId, (agreements.get(left.observation.signalId) ?? 0) + 1)
        corroborations.get(left.observation.signalId)?.push(
          Object.freeze({
            signalId: right.observation.signalId,
            method: right.observation.method,
            independenceGroup: right.observation.independenceGroup,
            deltaSessionTicks: delta,
            deltaFrames: ticksToFrames(ticksPerFrame, delta),
          }),
        )
      } else {
        disagreements.set(left.observation.signalId, (disagreements.get(left.observation.signalId) ?? 0) + 1)
      }
    }
  }

  // --- score --------------------------------------------------------------
  const weights = thresholds.scoreWeights
  const weightTotal =
    weights.ambiguity +
    weights.residual +
    weights.anchorDistribution +
    weights.coverage +
    weights.confidence +
    weights.corroboration
  assertDomain(weightTotal > 0, 'INVALID_ARGUMENT', 'Score weights must sum to a positive number')

  function scoreOf(item: Measured): number {
    const ambiguityScore =
      item.peakRatio === null
        ? // No search happened, so there is nothing to be ambiguous about. A
          // clock read is credited as separated rather than penalised for a
          // measurement its method never performs.
          1
        : clamp01(
            (item.peakRatio - thresholds.minimumPeakRatioForAdmission) /
              Math.max(1e-9, thresholds.minimumPeakRatioForAutoApply - thresholds.minimumPeakRatioForAdmission),
          )
    const residualLimitFrames = Math.max(1e-9, thresholds.maximumResidualFramesByMethod[item.observation.method])
    const residualScore = clamp01(1 - item.residualFrames / residualLimitFrames)
    const anchorScore = clamp01(
      (Math.min(item.thirdsOccupied, 3) / 3) * 0.6 +
        item.spanRatio * 0.2 +
        Math.min(item.observation.anchors.length, thresholds.minimumAnchorsForAutoApply) /
          Math.max(1, thresholds.minimumAnchorsForAutoApply) *
          0.2,
    )
    const corroborationScore = clamp01((agreements.get(item.observation.signalId) ?? 0) / 2)
    return roundScore(
      clamp01(
        (weights.ambiguity * ambiguityScore +
          weights.residual * residualScore +
          weights.anchorDistribution * anchorScore +
          weights.coverage * clamp01(item.coverageRatio) +
          weights.confidence * clamp01(item.observation.confidence) +
          weights.corroboration * corroborationScore) /
          weightTotal,
      ),
    )
  }

  function autoApplyBlockersOf(item: Measured): string[] {
    const blockers: string[] = []
    if (SECONDARY_ONLY_SYNC_METHODS[item.observation.method]) {
      blockers.push(`${item.observation.method} is secondary evidence and never applies on its own`)
    }
    if (item.peakRatio !== null && item.peakRatio < thresholds.minimumPeakRatioForAutoApply) {
      blockers.push(
        `peak/second-peak ${item.peakRatio} is below the auto-apply separation ${thresholds.minimumPeakRatioForAutoApply}`,
      )
    }
    if (
      item.observation.ambiguity &&
      item.observation.ambiguity.windowsAgreeing < thresholds.minimumAgreeingWindowsForAutoApply
    ) {
      blockers.push(
        `only ${item.observation.ambiguity.windowsAgreeing} window(s) agreed, ${thresholds.minimumAgreeingWindowsForAutoApply} required`,
      )
    }
    if (item.residualFrames > thresholds.maximumResidualFramesForAutoApply) {
      blockers.push(
        `residual ${item.residualFrames} frames exceeds the auto-apply limit ${thresholds.maximumResidualFramesForAutoApply}`,
      )
    }
    if (item.coverageRatio < thresholds.minimumCoverageRatioForAutoApply) {
      blockers.push(
        `coverage ${item.coverageRatio} is below the auto-apply floor ${thresholds.minimumCoverageRatioForAutoApply}`,
      )
    }
    if (item.observation.confidence < thresholds.minimumConfidenceForAutoApply) {
      blockers.push(
        `reported confidence ${item.observation.confidence} is below ${thresholds.minimumConfidenceForAutoApply}`,
      )
    }
    if (item.observation.anchors.length < thresholds.minimumAnchorsForAutoApply) {
      blockers.push(
        `${item.observation.anchors.length} anchor(s) cannot support an unattended map; ${thresholds.minimumAnchorsForAutoApply} required`,
      )
    }
    if (item.thirdsOccupied < thresholds.minimumAnchorThirdsForAutoApply) {
      blockers.push(
        `anchors occupy ${item.thirdsOccupied} third(s) of the session; ${thresholds.minimumAnchorThirdsForAutoApply} required`,
      )
    }
    if ((disagreements.get(item.observation.signalId) ?? 0) > 0) {
      blockers.push('an independent signal disagrees about the offset')
    }
    return blockers
  }

  const assessments: SyncSignalAssessment[] = measured.map((item) =>
    Object.freeze({
      signalId: item.observation.signalId,
      method: item.observation.method,
      precedence: SYNC_METHOD_PRECEDENCE[item.observation.method],
      independenceGroup: item.observation.independenceGroup,
      sessionOffsetTicks: item.sessionOffsetTicks,
      rate: item.rate,
      rateMeasured: item.rateMeasured,
      ratePpm: rationalToPpm(item.rate),
      residualSessionTicks: item.residualSessionTicks,
      residualFrames: item.residualFrames,
      anchorCount: item.observation.anchors.length,
      anchorThirdsOccupied: item.thirdsOccupied,
      anchorSpanRatio: item.spanRatio,
      coverageRatio: item.coverageRatio,
      coveredSessionTicks: item.coveredTicks,
      peakRatio: item.peakRatio,
      windowsConsidered: item.observation.ambiguity?.windowsConsidered ?? 0,
      windowsAgreeing: item.observation.ambiguity?.windowsAgreeing ?? 0,
      reportedConfidence: item.observation.confidence,
      unmetPreconditions: Object.freeze([...item.unmetPreconditions]),
      independentAgreements: agreements.get(item.observation.signalId) ?? 0,
      independentDisagreements: disagreements.get(item.observation.signalId) ?? 0,
      admissible: item.inadmissibleReasons.length === 0,
      inadmissibleReasons: Object.freeze([...item.inadmissibleReasons]),
      score: scoreOf(item),
      autoApplyBlockers: Object.freeze(
        item.inadmissibleReasons.length === 0 ? autoApplyBlockersOf(item) : [],
      ),
      evidenceRefs: Object.freeze([...item.observation.evidenceRefs]),
    }),
  )
  const assessmentById = new Map(assessments.map((assessment) => [assessment.signalId, assessment]))

  // --- 3. elect by precedence, then quality inside the tier ---------------
  // This is the whole point of the module. `sort` compares precedence FIRST and
  // only consults the score when the tier is equal, so a tier-3 signal scoring
  // 0.99 can never displace an admissible tier-1 signal scoring 0.61.
  const ranked = [...admissible].sort((left, right) => {
    const tier =
      SYNC_METHOD_PRECEDENCE[left.observation.method] - SYNC_METHOD_PRECEDENCE[right.observation.method]
    if (tier !== 0) return tier
    const score = (assessmentById.get(right.observation.signalId)?.score ?? 0) -
      (assessmentById.get(left.observation.signalId)?.score ?? 0)
    if (score !== 0) return score
    const method =
      SYNC_METHODS.indexOf(left.observation.method) - SYNC_METHODS.indexOf(right.observation.method)
    if (method !== 0) return method
    return left.observation.signalId < right.observation.signalId ? -1 : 1
  })

  const elected = ranked[0] ?? null
  const discarded: SyncDiscardedAlternative[] = []
  const outcomeReasons: string[] = []

  for (const item of measured) {
    if (elected && item === elected) continue
    const assessment = assessmentById.get(item.observation.signalId)!
    if (item.inadmissibleReasons.length > 0) {
      const reason = item.inadmissibleReasons[0]
      discarded.push(
        Object.freeze({
          signalId: item.observation.signalId,
          method: item.observation.method,
          precedence: assessment.precedence,
          score: assessment.score,
          reason,
          detail: describeInadmissibility(item.inadmissibleReasons, item, thresholds),
        }),
      )
      continue
    }
    if (!elected) continue
    const sameTier =
      SYNC_METHOD_PRECEDENCE[item.observation.method] === SYNC_METHOD_PRECEDENCE[elected.observation.method]
    discarded.push(
      Object.freeze({
        signalId: item.observation.signalId,
        method: item.observation.method,
        precedence: assessment.precedence,
        score: assessment.score,
        reason: sameTier ? 'lower-ranked-within-tier' : 'outranked-by-precedence',
        detail: sameTier
          ? `scored ${assessment.score} against ${assessmentById.get(elected.observation.signalId)?.score ?? 0} in tier ${assessment.precedence}`
          : `tier ${assessment.precedence} is weaker evidence than tier ${SYNC_METHOD_PRECEDENCE[elected.observation.method]} (${elected.observation.method}), regardless of score`,
      }),
    )
  }

  // --- 4. contradiction, then outcome -------------------------------------
  let hardConflict = false
  if (elected) {
    for (const other of admissible) {
      if (other === elected) continue
      if (other.observation.independenceGroup === elected.observation.independenceGroup) continue
      const delta = absBigInt(other.sessionOffsetTicks - elected.sessionOffsetTicks)
      if (delta <= softContradictionTicks) continue
      const severity: ContradictionSeverity = delta > hardContradictionTicks ? 'hard' : 'soft'
      if (severity === 'hard') hardConflict = true
      contradictions.push(
        Object.freeze({
          signalId: other.observation.signalId,
          method: other.observation.method,
          againstSignalId: elected.observation.signalId,
          deltaSessionTicks: delta,
          deltaFrames: ticksToFrames(ticksPerFrame, delta),
          severity,
        }),
      )
    }
  }

  let outcome: SyncOutcome
  let clockMap: Readonly<AffineClockMap> | null = null
  let selectedSignalId: string | null = null
  let selectedMethod: SyncMethod | null = null

  if (!elected) {
    outcome = 'insufficient-evidence'
    outcomeReasons.push(
      measured.length === 0
        ? 'no synchronization signal was observed for this track'
        : 'every observed signal failed admission; no offset may be derived from evidence that did not hold',
    )
  } else if (hardConflict) {
    // The strongest available evidence is contradicted beyond reconciliation by
    // an independent measurement. Emitting either offset would be picking a
    // winner by fiat, so nothing is emitted.
    outcome = 'insufficient-evidence'
    outcomeReasons.push(
      `independent signals disagree by more than ${thresholds.hardContradictionFrames} frame(s); no offset is emitted`,
    )
    for (const contradiction of contradictions.filter((item) => item.severity === 'hard')) {
      discarded.push(
        Object.freeze({
          signalId: elected.observation.signalId,
          method: elected.observation.method,
          precedence: SYNC_METHOD_PRECEDENCE[elected.observation.method],
          score: assessmentById.get(elected.observation.signalId)?.score ?? 0,
          reason: 'contradicted-by-independent-signal',
          detail: `contradicted by ${contradiction.signalId} (${contradiction.method}) by ${contradiction.deltaFrames} frames`,
        }),
      )
    }
  } else {
    selectedSignalId = elected.observation.signalId
    selectedMethod = elected.observation.method
    clockMap = createAffineClockMap({ rate: elected.rate, offsetTicks: elected.sessionOffsetTicks })
    const blockers = assessmentById.get(elected.observation.signalId)?.autoApplyBlockers ?? []
    if (blockers.length === 0) {
      outcome = 'auto-apply'
      outcomeReasons.push(
        `${elected.observation.method} met every auto-apply threshold in precedence tier ${SYNC_METHOD_PRECEDENCE[elected.observation.method]}`,
      )
    } else {
      outcome = 'review'
      outcomeReasons.push(...blockers)
    }
  }

  const flatCorroborations: SyncCorroboration[] = []
  if (selectedSignalId) flatCorroborations.push(...(corroborations.get(selectedSignalId) ?? []))

  // The invariant this module exists to hold. Asserted rather than trusted:
  // a future edit that reorders the branches above must fail here, loudly.
  assertDomain(
    outcome !== 'insufficient-evidence' || clockMap === null,
    'INVALID_ARGUMENT',
    'Insufficient evidence must never carry a clock map',
  )

  return Object.freeze({
    schemaVersion: SYNC_EVIDENCE_SCHEMA_VERSION,
    sessionId: input.sessionId,
    trackId: input.trackId,
    referenceTrackId: input.referenceTrackId,
    sessionTimebase: input.sessionTimebase,
    sessionFrameRate: input.sessionFrameRate,
    sessionBounds: input.sessionBounds,
    outcome,
    manualRequired: outcome === 'insufficient-evidence',
    selectedSignalId,
    selectedMethod,
    clockMap,
    assessments: Object.freeze(assessments),
    discarded: Object.freeze(discarded),
    contradictions: Object.freeze(contradictions),
    corroborations: Object.freeze(flatCorroborations),
    outcomeReasons: Object.freeze(outcomeReasons),
    thresholds,
  })
}

function describeInadmissibility(
  reasons: readonly SyncDiscardReason[],
  item: {
    observation: Readonly<SyncSignalObservation>
    unmetPreconditions: readonly string[]
    peakRatio: number | null
    residualFrames: number
    coverageRatio: number
  },
  thresholds: Readonly<SyncEvidenceThresholds>,
): string {
  return reasons
    .map((reason) => {
      switch (reason) {
        case 'precondition-unmet':
          return `unmet preconditions: ${item.unmetPreconditions.join(', ')}`
        case 'ambiguity-evidence-missing':
          return `${item.observation.method} searches for its offset and must report a second-best peak`
        case 'ambiguous-peak':
          return `peak/second-peak ${item.peakRatio} is below the admission separation ${thresholds.minimumPeakRatioForAdmission}`
        case 'residual-above-method-limit':
          return `residual ${item.residualFrames} frames exceeds the ${item.observation.method} limit ${thresholds.maximumResidualFramesByMethod[item.observation.method]}`
        case 'coverage-below-floor':
          return `coverage ${item.coverageRatio} is below the admission floor ${thresholds.minimumCoverageRatioForAdmission}`
        case 'confidence-below-floor':
          return `reported confidence ${item.observation.confidence} is below ${thresholds.minimumConfidenceForAdmission}`
        case 'no-anchors':
          return 'the signal carries no anchor, so it locates nothing'
        default:
          return reason
      }
    })
    .join('; ')
}

/**
 * Map a source tick through an accepted record.
 *
 * Refuses when the record has no map. A caller that wants "just give me a
 * number" has to say so somewhere else; this function will not be the place a
 * refusal quietly becomes a zero.
 */
export function applySyncEvidenceRecord(record: Readonly<SyncEvidenceRecord>, sourceTick: bigint): bigint {
  assertDomain(
    record.clockMap !== null,
    'INVALID_ARGUMENT',
    'This synchronization record carries no clock map; the evidence did not support one',
  )
  return applyAffineClockMap(record.clockMap, sourceTick)
}

/**
 * JSON-safe projection for persistence. `bigint` has no JSON form, so ticks
 * become decimal strings and rationals become "num/den" — losslessly, and
 * readable in a database column without a decoder.
 *
 * Persistence itself belongs to the capture repository, not here.
 */
export function serializeSyncEvidenceRecord(record: Readonly<SyncEvidenceRecord>): Readonly<Record<string, unknown>> {
  return Object.freeze({
    schemaVersion: record.schemaVersion,
    sessionId: record.sessionId,
    trackId: record.trackId,
    referenceTrackId: record.referenceTrackId,
    sessionSecondsPerTick: serializeRational(record.sessionTimebase.secondsPerTick),
    sessionFrameRate: serializeRational(record.sessionFrameRate),
    sessionBounds: serializeTickInterval(record.sessionBounds),
    outcome: record.outcome,
    manualRequired: record.manualRequired,
    selectedSignalId: record.selectedSignalId,
    selectedMethod: record.selectedMethod,
    clockMap: record.clockMap
      ? {
          rate: serializeRational(record.clockMap.rate),
          offsetTicks: record.clockMap.offsetTicks.toString(),
          rounding: record.clockMap.rounding,
        }
      : null,
    assessments: record.assessments.map((assessment) => ({
      ...assessment,
      sessionOffsetTicks: assessment.sessionOffsetTicks.toString(),
      residualSessionTicks: assessment.residualSessionTicks.toString(),
      coveredSessionTicks: assessment.coveredSessionTicks.toString(),
      rate: serializeRational(assessment.rate),
    })),
    discarded: record.discarded.map((item) => ({ ...item })),
    contradictions: record.contradictions.map((item) => ({
      ...item,
      deltaSessionTicks: item.deltaSessionTicks.toString(),
    })),
    corroborations: record.corroborations.map((item) => ({
      ...item,
      deltaSessionTicks: item.deltaSessionTicks.toString(),
    })),
    outcomeReasons: [...record.outcomeReasons],
    thresholds: {
      ...record.thresholds,
      maximumResidualFramesByMethod: { ...record.thresholds.maximumResidualFramesByMethod },
      scoreWeights: { ...record.thresholds.scoreWeights },
    },
  })
}

/**
 * Sort helper for diagnostics: strongest evidence first, ties broken the same
 * way the election breaks them, so a rendered table matches the decision.
 */
export function compareAssessments(
  left: Readonly<SyncSignalAssessment>,
  right: Readonly<SyncSignalAssessment>,
): number {
  if (left.admissible !== right.admissible) return left.admissible ? -1 : 1
  if (left.precedence !== right.precedence) return left.precedence - right.precedence
  if (left.score !== right.score) return right.score - left.score
  return left.signalId < right.signalId ? -1 : left.signalId > right.signalId ? 1 : 0
}

/** Re-exported so callers can canonicalize coverage without importing the kernel twice. */
export { compareIntervals, compareRational, createTickInterval }
