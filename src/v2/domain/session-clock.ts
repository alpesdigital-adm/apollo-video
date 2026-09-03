import { calculateCanonicalHash } from './canonical-hash.ts'
import { assertDomain } from './errors.ts'
import {
  applyAffineClockMap,
  compareRational,
  createAffineClockMap,
  createTickInterval,
  divideRational,
  intervalContains,
  invertAffineClockMap,
  multiplyRational,
  rational,
  rationalToPpm,
  serializeRational,
  type AffineClockMap,
  type Rational,
  type RoundingPolicy,
  type TickInterval,
  type Timebase,
} from './session-time.ts'

/**
 * The canonical clock of a capture session (F4.003, spec 05 §5–§7, ADR-130).
 *
 * A multicam session has as many clocks as it has recorders, and none of them
 * is neutral. Editing needs exactly one timeline that every source is measured
 * against, and this module is what that timeline is.
 *
 * Three rules shape everything below, and each of them exists because the
 * obvious shortcut is wrong:
 *
 * **The session clock is never a media file.** The tempting choice is "use the
 * normalized MP4 we already transcoded" — it is CFR, it starts at zero, it is
 * easy. It is also a *derived artifact*: re-encode it with different settings
 * and every timestamp in the session moves. A timing authority that changes
 * when a transcode setting changes is not an authority. So the clock is a
 * declared `Timebase` plus a declared reason for choosing it, and a reference
 * to a normalized rendition is refused at construction.
 *
 * **A map is always source → session.** Never source → source. Chaining
 * A→B→C compounds the rounding of two maps and, worse, silently promotes B to
 * an authority it was never audited as. When someone genuinely needs "where is
 * this instant of camera A in camera B", `locateAcrossSources` answers it by
 * going through the session twice and *reporting the accumulated bound* —
 * and deliberately returns no `AffineClockMap`, so the answer cannot be
 * persisted as a source → source map.
 *
 * **Precision and confidence travel with the map, not with the session.** A
 * session is rarely uniformly well synchronized: a camera with shared timecode
 * and a phone aligned by a spoken code do not deserve the same claim. Both
 * fields are per-mapping, and `high` confidence is refused when the measured
 * precision does not support it.
 */

export const SESSION_CLOCK_SCHEMA_VERSION = 'session-clock/v1' as const

const ID = /^[A-Za-z0-9][A-Za-z0-9._:/-]{2,127}$/
const EVIDENCE_REF_MAX = 512

/**
 * Every conversion in this slice rounds exactly once, half-to-even.
 *
 * Half-even is unbiased: half-up would push every tie in the same direction, so
 * a two-hour session accumulates a systematic offset that looks exactly like
 * drift and would be "corrected" by stretching real audio. The policy is
 * declared here so it is a decision, not an accident of whichever helper ran.
 */
export const SESSION_CLOCK_ROUNDING: RoundingPolicy = 'nearest-half-even'

/**
 * Rounding a single exact rational to a tick can move it by at most half a
 * tick, so a round trip through a map can move it by at most one whole tick.
 * Every precision bound in this module carries this term; a bound that ignored
 * it would claim an accuracy the integer representation cannot deliver.
 */
export const SESSION_CLOCK_ROUNDING_BOUND_TICKS = BigInt(1)

/** How the session clock was chosen. Spec 05 §5, in the spec's priority order. */
export const SESSION_CLOCK_ORIGINS = Object.freeze([
  'shared-timecode',
  'master-audio',
  'primary-camera',
  'operator-selected',
  'synthetic-union',
] as const)
export type SessionClockOrigin = (typeof SESSION_CLOCK_ORIGINS)[number]

/**
 * What a clock reference points at.
 *
 * This is a required field rather than an inferred one on purpose. The rule
 * "a normalized file is not the timing authority" can only be enforced if the
 * caller has to say which kind of thing it is handing over; a boolean with a
 * safe default is a rule that is silently satisfied by forgetting it.
 */
export const MEDIA_PROVENANCES = Object.freeze([
  'original-capture',
  'normalized-rendition',
  'synthetic',
] as const)
export type MediaProvenance = (typeof MEDIA_PROVENANCES)[number]

/** Confidence a *mapping* may carry. Spec 05 §9.1. */
export const CLOCK_CONFIDENCES = Object.freeze(['high', 'medium', 'low'] as const)
export type ClockConfidence = (typeof CLOCK_CONFIDENCES)[number]

const CONFIDENCE_RANK: Readonly<Record<ClockConfidence, number>> = Object.freeze({ high: 3, medium: 2, low: 1 })

/**
 * Precision expressed against the session's own frame grid.
 *
 * The authoritative number is always `boundTicks`; the class exists so
 * thresholds and diagnostics can be stated in the unit editors think in.
 */
export const CLOCK_PRECISION_CLASSES = Object.freeze(['sub-frame', 'frame', 'multi-frame', 'coarse'] as const)
export type ClockPrecisionClass = (typeof CLOCK_PRECISION_CLASSES)[number]

/** Spec 05 §10: a linear map may only be called high confidence within two frames. */
export const HIGH_CONFIDENCE_MAX_FRAMES = BigInt(2)

export interface ClockPrecision {
  /** Upper bound of the mapping error in session ticks. A bound, not an estimate. */
  readonly boundTicks: bigint
  readonly precisionClass: ClockPrecisionClass
}

export interface ClockAuthority {
  readonly origin: SessionClockOrigin
  /** The capture source the clock is anchored to; `null` only for a synthetic timeline. */
  readonly sourceId: string | null
  readonly provenance: MediaProvenance
  /** Where the choice can be audited — a timecode dump, a marker detection, an operator action. */
  readonly evidenceRef: string
}

export interface SessionClock {
  readonly schemaVersion: typeof SESSION_CLOCK_SCHEMA_VERSION
  readonly sessionId: string
  /** The unit session time is counted in. Independent of every source and every rendition. */
  readonly timebase: Readonly<Timebase>
  /** The frame grid diagnostics are reported against. Rational, so 30000/1001 is exact. */
  readonly frameRate: Rational
  readonly authority: Readonly<ClockAuthority>
  readonly establishedAt: string
  readonly clockHash: string
}

/** A source's own clock, as recorded. Never the clock of a transcode of it. */
export interface SourceClock {
  readonly sourceId: string
  readonly timebase: Readonly<Timebase>
  readonly provenance: MediaProvenance
}

export interface SourceToSessionMapping {
  readonly schemaVersion: typeof SESSION_CLOCK_SCHEMA_VERSION
  readonly sessionId: string
  readonly sourceId: string
  /** Half-open, in *source* ticks. Outside it this mapping says nothing. */
  readonly sourceCoverage: Readonly<TickInterval>
  /** Half-open, in *session* ticks: the projection of `sourceCoverage`. */
  readonly sessionCoverage: Readonly<TickInterval>
  /** source tick → session tick, including the timebase ratio and the drift. */
  readonly map: Readonly<AffineClockMap>
  /** Clock drift alone, with the timebase ratio divided out. The authority. */
  readonly driftRate: Rational
  /** Truncated report of `driftRate` for humans and dashboards. Never the authority. */
  readonly driftPpm: number
  readonly precision: Readonly<ClockPrecision>
  readonly confidence: ClockConfidence
  readonly anchorIds: readonly string[]
  readonly evidenceRefs: readonly string[]
}

function assertId(value: string, field: string): string {
  assertDomain(ID.test(value), 'INVALID_ARGUMENT', `${field} is not a valid identifier`)
  return value
}

function assertEvidenceRef(value: string, field: string): string {
  const trimmed = value.trim()
  assertDomain(
    trimmed.length > 0 && trimmed.length <= EVIDENCE_REF_MAX,
    'INVALID_ARGUMENT',
    `${field} is required so the decision can be audited`,
  )
  return trimmed
}

function assertInstant(value: string, field: string): string {
  assertDomain(
    Number.isFinite(Date.parse(value)) && new Date(value).toISOString() === value,
    'INVALID_ARGUMENT',
    `${field} must be a canonical ISO instant`,
  )
  return value
}

/**
 * Session ticks per frame, exactly.
 *
 * `1 / (frameRate * secondsPerTick)`. For 90 kHz at 30000/1001 fps this is
 * exactly 3003 — a number no float pipeline reproduces, and the reason both
 * inputs are rational.
 */
export function sessionTicksPerFrame(clock: Readonly<SessionClock>): Rational {
  return divideRational(rational(BigInt(1)), multiplyRational(clock.frameRate, clock.timebase.secondsPerTick))
}

export function classifyClockPrecision(clock: Readonly<SessionClock>, boundTicks: bigint): ClockPrecisionClass {
  assertDomain(boundTicks >= BigInt(0), 'INVALID_ARGUMENT', 'a precision bound cannot be negative')
  const perFrame = sessionTicksPerFrame(clock)
  const bound = rational(boundTicks)
  if (compareRational(multiplyRational(bound, rational(BigInt(2))), perFrame) < 0) return 'sub-frame'
  if (compareRational(bound, perFrame) <= 0) return 'frame'
  if (compareRational(bound, multiplyRational(perFrame, rational(BigInt(3)))) <= 0) return 'multi-frame'
  return 'coarse'
}

export function createClockPrecision(clock: Readonly<SessionClock>, boundTicks: bigint): Readonly<ClockPrecision> {
  return Object.freeze({ boundTicks, precisionClass: classifyClockPrecision(clock, boundTicks) })
}

function assertAuthority(authority: Readonly<ClockAuthority>): Readonly<ClockAuthority> {
  assertDomain(
    SESSION_CLOCK_ORIGINS.includes(authority.origin),
    'INVALID_ARGUMENT',
    `session clock origin ${authority.origin} is not a recognized choice`,
  )
  // The rule this whole type exists for. A normalized file is an output of the
  // pipeline; making it the clock means the timeline moves whenever a transcode
  // setting changes, and nothing downstream can tell that it moved.
  assertDomain(
    authority.provenance !== 'normalized-rendition',
    'INVALID_ARGUMENT',
    'a normalized rendition cannot be the session timing authority; anchor the clock to the original capture',
  )
  if (authority.origin === 'synthetic-union') {
    assertDomain(
      authority.sourceId === null && authority.provenance === 'synthetic',
      'INVALID_ARGUMENT',
      'a synthetic session clock is anchored to no source and must declare synthetic provenance',
    )
  } else {
    assertDomain(
      authority.sourceId !== null && authority.provenance === 'original-capture',
      'INVALID_ARGUMENT',
      `session clock origin ${authority.origin} must name the original capture source it is anchored to`,
    )
    assertId(authority.sourceId!, 'session clock authority sourceId')
  }
  return Object.freeze({
    origin: authority.origin,
    sourceId: authority.sourceId,
    provenance: authority.provenance,
    evidenceRef: assertEvidenceRef(authority.evidenceRef, 'session clock authority evidenceRef'),
  })
}

export function calculateSessionClockHash(clock: Omit<SessionClock, 'clockHash'>): string {
  return calculateCanonicalHash({
    schemaVersion: clock.schemaVersion,
    sessionId: clock.sessionId,
    secondsPerTick: serializeRational(clock.timebase.secondsPerTick),
    frameRate: serializeRational(clock.frameRate),
    authority: {
      origin: clock.authority.origin,
      sourceId: clock.authority.sourceId,
      provenance: clock.authority.provenance,
      evidenceRef: clock.authority.evidenceRef,
    },
    establishedAt: clock.establishedAt,
  })
}

export function createSessionClock(
  input: Omit<SessionClock, 'schemaVersion' | 'clockHash'>,
): Readonly<SessionClock> {
  assertId(input.sessionId, 'session clock sessionId')
  assertDomain(
    input.timebase.secondsPerTick.num > BigInt(0),
    'INVALID_ARGUMENT',
    'a session timebase must advance forward in time',
  )
  assertDomain(input.frameRate.num > BigInt(0), 'INVALID_ARGUMENT', 'a session frame rate must be strictly positive')

  const clock: Omit<SessionClock, 'clockHash'> = {
    schemaVersion: SESSION_CLOCK_SCHEMA_VERSION,
    sessionId: input.sessionId,
    timebase: Object.freeze({ ...input.timebase }),
    frameRate: input.frameRate,
    authority: assertAuthority(input.authority),
    establishedAt: assertInstant(input.establishedAt, 'session clock establishedAt'),
  }

  // A timebase coarser than the frame grid cannot name a frame boundary, so
  // every "within one frame" claim made against it would be unverifiable.
  assertDomain(
    compareRational(sessionTicksPerFrame(clock as SessionClock), rational(BigInt(1))) >= 0,
    'INVALID_ARGUMENT',
    'the session timebase must resolve at least one tick per frame',
  )

  return Object.freeze({ ...clock, clockHash: calculateSessionClockHash(clock) })
}

export function assertSessionClockIntegrity(clock: Readonly<SessionClock>): Readonly<SessionClock> {
  const { clockHash: _stored, ...content } = clock
  assertDomain(
    calculateSessionClockHash(content) === clock.clockHash,
    'PERSISTENCE_CONFLICT',
    'session clock hash does not match its stored content',
  )
  return clock
}

export function createSourceClock(input: {
  sourceId: string
  timebase: Readonly<Timebase>
  provenance: MediaProvenance
}): Readonly<SourceClock> {
  assertId(input.sourceId, 'source clock sourceId')
  assertDomain(
    input.timebase.secondsPerTick.num > BigInt(0),
    'INVALID_ARGUMENT',
    'a source timebase must advance forward in time',
  )
  // Spec 05 invariant 1: the original PTS and timebase are preserved *before*
  // normalization. Reading them off the transcode instead would bake whatever
  // the transcode did to the timestamps into the sync evidence.
  assertDomain(
    input.provenance === 'original-capture',
    'INVALID_ARGUMENT',
    'a source clock must be read from the original capture, not from a normalized rendition',
  )
  return Object.freeze({
    sourceId: input.sourceId,
    timebase: Object.freeze({ ...input.timebase }),
    provenance: input.provenance,
  })
}

/**
 * How many session ticks one source tick is worth, before any drift.
 *
 * Keeping this separate from drift is not tidiness. A 90 kHz source on a
 * 1 MHz session clock has a full map rate near 11.1; reporting that as ppm
 * would announce ten million ppm of "drift" on a perfectly synchronized
 * recorder. Drift is only ever the residual *after* this ratio is divided out.
 */
export function timebaseRatio(source: Readonly<Timebase>, session: Readonly<Timebase>): Rational {
  return divideRational(source.secondsPerTick, session.secondsPerTick)
}

export function composeClockRate(input: {
  source: Readonly<Timebase>
  session: Readonly<Timebase>
  driftRate: Rational
}): Rational {
  assertDomain(input.driftRate.num > BigInt(0), 'INVALID_ARGUMENT', 'a drift rate must be strictly positive')
  return multiplyRational(timebaseRatio(input.source, input.session), input.driftRate)
}

export function extractDriftRate(input: {
  rate: Rational
  source: Readonly<Timebase>
  session: Readonly<Timebase>
}): Rational {
  return divideRational(input.rate, timebaseRatio(input.source, input.session))
}

export function createSourceToSessionMapping(input: {
  clock: Readonly<SessionClock>
  source: Readonly<SourceClock>
  sourceCoverage: Readonly<TickInterval>
  /** Clock drift only. Use `rational(BigInt(1))` when the clocks are believed identical. */
  driftRate: Rational
  offsetTicks: bigint
  /** Largest residual measured against evidence, in session ticks. */
  residualBoundTicks: bigint
  confidence: ClockConfidence
  anchorIds: readonly string[]
  evidenceRefs: readonly string[]
  rounding?: RoundingPolicy
}): Readonly<SourceToSessionMapping> {
  assertDomain(
    CLOCK_CONFIDENCES.includes(input.confidence),
    'INVALID_ARGUMENT',
    `clock confidence ${input.confidence} is not a recognized level`,
  )
  assertDomain(input.residualBoundTicks >= BigInt(0), 'INVALID_ARGUMENT', 'a residual bound cannot be negative')

  const rate = composeClockRate({
    source: input.source.timebase,
    session: input.clock.timebase,
    driftRate: input.driftRate,
  })
  const map = createAffineClockMap({
    rate,
    offsetTicks: input.offsetTicks,
    rounding: input.rounding ?? SESSION_CLOCK_ROUNDING,
  })

  const start = applyAffineClockMap(map, input.sourceCoverage.start)
  const end = applyAffineClockMap(map, input.sourceCoverage.end)
  // A source range shorter than one session tick projects onto nothing. That is
  // not a degenerate mapping to tolerate, it is a coverage claim the session
  // clock cannot represent, and pretending otherwise creates an interval that
  // contains no instant.
  assertDomain(
    end > start,
    'INVALID_ARGUMENT',
    'the source coverage is too short to occupy a session tick; it cannot be mapped',
  )
  const sessionCoverage = createTickInterval(start, end)

  const precision = createClockPrecision(
    input.clock,
    input.residualBoundTicks + SESSION_CLOCK_ROUNDING_BOUND_TICKS,
  )
  // Spec 05 §21: "residual alto → não marcar synced-high". The claim is checked
  // against the measurement instead of being taken on trust.
  if (input.confidence === 'high') {
    const limit = multiplyRational(sessionTicksPerFrame(input.clock), rational(HIGH_CONFIDENCE_MAX_FRAMES))
    assertDomain(
      compareRational(rational(precision.boundTicks), limit) <= 0,
      'INVALID_ARGUMENT',
      'high confidence requires a precision bound within two session frames',
    )
  }

  const anchorIds = Object.freeze([...input.anchorIds].map((id) => assertId(id, 'mapping anchorId')))
  const evidenceRefs = Object.freeze(
    input.evidenceRefs.map((ref) => assertEvidenceRef(ref, 'mapping evidenceRef')),
  )
  const driftRate = extractDriftRate({ rate, source: input.source.timebase, session: input.clock.timebase })

  return Object.freeze({
    schemaVersion: SESSION_CLOCK_SCHEMA_VERSION,
    sessionId: input.clock.sessionId,
    sourceId: input.source.sourceId,
    sourceCoverage: Object.freeze({ ...input.sourceCoverage }),
    sessionCoverage,
    map,
    driftRate,
    driftPpm: rationalToPpm(driftRate),
    precision,
    confidence: input.confidence,
    anchorIds,
    evidenceRefs,
  })
}

/**
 * source → session, refusing every tick the mapping was not measured over.
 *
 * The old shallow implementation used a closed interval (`pts <= end`), which
 * makes the boundary tick belong to two adjacent pieces at once and lets a
 * lookup succeed one tick past the evidence. Half-open is not a style choice;
 * it is what makes coverage tile without overlap.
 */
export function mapSourceTickToSession(
  mapping: Readonly<SourceToSessionMapping>,
  sourceTick: bigint,
): bigint {
  assertDomain(
    intervalContains(mapping.sourceCoverage, sourceTick),
    'INVALID_ARGUMENT',
    `source tick ${sourceTick} is outside the coverage this mapping was measured over`,
  )
  return applyAffineClockMap(mapping.map, sourceTick)
}

/**
 * session → source, inside the mapped range only.
 *
 * Rounding makes the inverse a near-inverse, so the result can land one tick
 * outside the source coverage at an edge. That excursion is corrected — it is a
 * known artifact of integer ticks, bounded by
 * `SESSION_CLOCK_ROUNDING_BOUND_TICKS` — and an excursion larger than the bound
 * throws rather than being clamped, because it would mean the map and the
 * coverage disagree about something real.
 */
export function mapSessionTickToSource(
  mapping: Readonly<SourceToSessionMapping>,
  sessionTick: bigint,
): bigint {
  assertDomain(
    intervalContains(mapping.sessionCoverage, sessionTick),
    'INVALID_ARGUMENT',
    `session tick ${sessionTick} is outside the coverage this mapping was measured over`,
  )
  const inverted = invertAffineClockMap(mapping.map, sessionTick)
  const { start, end } = mapping.sourceCoverage
  if (inverted < start) {
    assertDomain(
      start - inverted <= SESSION_CLOCK_ROUNDING_BOUND_TICKS,
      'INVALID_ARGUMENT',
      'inverse mapping fell outside the source coverage by more than the rounding bound',
    )
    return start
  }
  if (inverted >= end) {
    assertDomain(
      inverted - end < SESSION_CLOCK_ROUNDING_BOUND_TICKS + BigInt(1),
      'INVALID_ARGUMENT',
      'inverse mapping fell outside the source coverage by more than the rounding bound',
    )
    return end - BigInt(1)
  }
  return inverted
}

export type CrossSourceLocation =
  | Readonly<{
      status: 'resolved'
      viaSessionId: string
      sessionTick: bigint
      targetSourceTick: bigint
      /** Both hops' bounds added. Going through the session costs precision and says so. */
      precisionBoundTicks: bigint
      /** The weaker of the two mappings. A chain is never more trustworthy than its worst link. */
      confidence: ClockConfidence
    }>
  | Readonly<{ status: 'unmapped'; reason: 'outside-origin-coverage' | 'outside-target-coverage' }>

/**
 * Where an instant of one source falls in another, resolved through the session.
 *
 * This is the legitimate form of a question that must never become a stored
 * map. It returns ticks and an error budget, never an `AffineClockMap`, so
 * there is nothing here to persist as a source → source relation — which is
 * how a normalized proxy quietly becomes the authority for a third source.
 */
export function locateAcrossSources(input: {
  from: Readonly<SourceToSessionMapping>
  to: Readonly<SourceToSessionMapping>
  sourceTick: bigint
}): CrossSourceLocation {
  assertDomain(
    input.from.sessionId === input.to.sessionId,
    'INVALID_ARGUMENT',
    'two mappings can only be related through the session clock they share',
  )
  if (!intervalContains(input.from.sourceCoverage, input.sourceTick)) {
    return Object.freeze({ status: 'unmapped', reason: 'outside-origin-coverage' } as const)
  }
  const sessionTick = applyAffineClockMap(input.from.map, input.sourceTick)
  if (!intervalContains(input.to.sessionCoverage, sessionTick)) {
    return Object.freeze({ status: 'unmapped', reason: 'outside-target-coverage' } as const)
  }
  return Object.freeze({
    status: 'resolved',
    viaSessionId: input.from.sessionId,
    sessionTick,
    targetSourceTick: mapSessionTickToSource(input.to, sessionTick),
    precisionBoundTicks: input.from.precision.boundTicks + input.to.precision.boundTicks,
    confidence:
      CONFIDENCE_RANK[input.from.confidence] <= CONFIDENCE_RANK[input.to.confidence]
        ? input.from.confidence
        : input.to.confidence,
  } as const)
}

/** The weaker of two confidences. Exported because every combination step needs it. */
export function weakerConfidence(left: ClockConfidence, right: ClockConfidence): ClockConfidence {
  return CONFIDENCE_RANK[left] <= CONFIDENCE_RANK[right] ? left : right
}
