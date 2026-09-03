import { assertDomain } from './errors.ts'

/**
 * The shared temporal kernel for capture sessions (Wave 18, F4.002–F4.008).
 *
 * Every front in this wave maps source media onto one canonical session clock.
 * If each of them invented its own notion of "a time", the maps would not
 * compose and the integration would be a translation layer instead of a model.
 * So the vocabulary lives here, once, and everything else builds on it.
 *
 * Three decisions are load-bearing and none of them is stylistic:
 *
 * **Ticks are integers, held as `bigint`.** Media timestamps arrive as integer
 * ticks in a source timebase and are persisted as 64-bit integers. A double can
 * represent every integer only up to 2^53; a 90 kHz stream reaches that in
 * about three thousand years, but a nanosecond timebase reaches it in fourteen
 * weeks, and the failure mode is silent — two distinct instants compare equal.
 * `bigint` removes the question.
 *
 * **Rates are rational, never decimal.** 30000/1001 is exactly representable as
 * a pair of integers and not representable at all as a float. A drift estimate
 * of +120 ppm is 1000120/1000000. Storing either as a decimal and multiplying
 * makes round-trip conversion lossy in a way that accumulates across a
 * two-hour session.
 *
 * **Intervals are half-open, `[start, end)`.** Adjacent intervals then tile the
 * timeline with no gap and no overlap: `[0,100)` and `[100,200)` are
 * neighbours, not conflicting claims on tick 100. Closed intervals make every
 * boundary ambiguous, and coverage is nothing but boundaries.
 */

export const SESSION_TIME_SCHEMA_VERSION = 'session-time/v1' as const

/** An exact rational number. Always normalized, always positive denominator. */
export interface Rational {
  readonly num: bigint
  readonly den: bigint
}

/**
 * A half-open interval of ticks, `[start, end)`.
 *
 * Zero-length is invalid on purpose: an interval that contains no tick is not a
 * degenerate interval, it is the absence of one, and letting it exist means
 * every consumer has to decide separately what it means.
 */
export interface TickInterval {
  readonly start: bigint
  readonly end: bigint
}

/** How a non-integral conversion result is turned back into a tick. */
export const ROUNDING_POLICIES = ['nearest-half-even', 'floor', 'ceil'] as const
export type RoundingPolicy = (typeof ROUNDING_POLICIES)[number]

/**
 * Ticks are meaningless without the timebase they count in. A "tick" of
 * 1/90000 s and a "tick" of 1/48000 s are different quantities, and mixing them
 * silently is the classic multicam bug.
 */
export interface Timebase {
  readonly schemaVersion: typeof SESSION_TIME_SCHEMA_VERSION
  /** Seconds per tick, exactly. 1/90000 for MPEG-TS, 1/48000 for 48 kHz audio. */
  readonly secondsPerTick: Rational
}

// 64-bit signed range. Anything outside it cannot be persisted, so it must not
// be constructible either — a value that only fails at write time fails in the
// worst possible place.
const INT64_MIN = -(BigInt(2) ** BigInt(63))
const INT64_MAX = BigInt(2) ** BigInt(63) - BigInt(1)

function gcd(a: bigint, b: bigint): bigint {
  let x = a < BigInt(0) ? -a : a
  let y = b < BigInt(0) ? -b : b
  while (y !== BigInt(0)) {
    const t = x % y
    x = y
    y = t
  }
  return x
}

export function rational(num: bigint | number, den: bigint | number = BigInt(1)): Rational {
  const n = typeof num === 'bigint' ? num : BigInt(assertSafeInteger(num, 'rational numerator'))
  const d = typeof den === 'bigint' ? den : BigInt(assertSafeInteger(den, 'rational denominator'))
  assertDomain(d !== BigInt(0), 'INVALID_ARGUMENT', 'A rational cannot have a zero denominator')
  // Normalize sign onto the numerator so equality is structural: 1/-2 and -1/2
  // must not be two different objects meaning the same number.
  const sign = d < BigInt(0) ? -BigInt(1) : BigInt(1)
  const divisor = gcd(n, d) || BigInt(1)
  return Object.freeze({ num: (n / divisor) * sign, den: (d / divisor) * sign })
}

function assertSafeInteger(value: number, field: string): number {
  assertDomain(Number.isSafeInteger(value), 'INVALID_ARGUMENT', `${field} must be a safe integer`)
  return value
}

export function rationalEquals(left: Rational, right: Rational): boolean {
  return left.num === right.num && left.den === right.den
}

export function multiplyRational(left: Rational, right: Rational): Rational {
  return rational(left.num * right.num, left.den * right.den)
}

export function divideRational(left: Rational, right: Rational): Rational {
  assertDomain(right.num !== BigInt(0), 'INVALID_ARGUMENT', 'Cannot divide a rational by zero')
  return rational(left.num * right.den, left.den * right.num)
}

export function addRational(left: Rational, right: Rational): Rational {
  return rational(left.num * right.den + right.num * left.den, left.den * right.den)
}

export function subtractRational(left: Rational, right: Rational): Rational {
  return rational(left.num * right.den - right.num * left.den, left.den * right.den)
}

export function compareRational(left: Rational, right: Rational): number {
  const l = left.num * right.den
  const r = right.num * left.den
  return l < r ? -1 : l > r ? 1 : 0
}

/** `1000000 * (rate - 1)`, truncated toward zero. The unit drift is reported in. */
export function rationalToPpm(rate: Rational): number {
  const delta = subtractRational(rate, rational(BigInt(1), BigInt(1)))
  const scaled = (delta.num * BigInt(1000000)) / delta.den
  assertInt64(scaled, 'ppm')
  return Number(scaled)
}

export function ppmToRate(ppm: number): Rational {
  assertSafeInteger(ppm, 'ppm')
  return addRational(rational(BigInt(1), BigInt(1)), rational(BigInt(ppm), BigInt(1000000)))
}

export function assertInt64(value: bigint, field: string): bigint {
  assertDomain(
    value >= INT64_MIN && value <= INT64_MAX,
    'INVALID_ARGUMENT',
    `${field} overflows the 64-bit range it must be persisted in`,
  )
  return value
}

export function createTimebase(secondsPerTick: Rational): Readonly<Timebase> {
  assertDomain(secondsPerTick.num > BigInt(0), 'INVALID_ARGUMENT', 'A timebase must advance forward in time')
  return Object.freeze({ schemaVersion: SESSION_TIME_SCHEMA_VERSION, secondsPerTick })
}

/** `1/rate` seconds per tick — the form ffprobe reports. */
export function timebaseFromRate(ticksPerSecond: bigint | number): Readonly<Timebase> {
  const ticks = typeof ticksPerSecond === 'bigint' ? ticksPerSecond : BigInt(assertSafeInteger(ticksPerSecond, 'ticksPerSecond'))
  assertDomain(ticks > BigInt(0), 'INVALID_ARGUMENT', 'ticksPerSecond must be positive')
  return createTimebase(rational(BigInt(1), ticks))
}

export function createTickInterval(start: bigint, end: bigint): Readonly<TickInterval> {
  assertInt64(start, 'interval start')
  assertInt64(end, 'interval end')
  // Strictly forward. `[t, t)` contains nothing; treating it as an interval
  // would make "is this covered" answerable two ways.
  assertDomain(end > start, 'INVALID_ARGUMENT', 'A tick interval must be non-empty and forward: [start, end)')
  return Object.freeze({ start, end })
}

export function intervalDuration(interval: Readonly<TickInterval>): bigint {
  return interval.end - interval.start
}

/** Half-open containment: `start <= tick < end`. */
export function intervalContains(interval: Readonly<TickInterval>, tick: bigint): boolean {
  return tick >= interval.start && tick < interval.end
}

export function intervalContainsInterval(outer: Readonly<TickInterval>, inner: Readonly<TickInterval>): boolean {
  return inner.start >= outer.start && inner.end <= outer.end
}

/**
 * True when the two intervals share at least one tick.
 *
 * `[0,100)` and `[100,200)` do **not** overlap. That is the whole point of
 * half-open bounds, and it is why coverage can be canonicalized without a
 * fudge factor.
 */
export function intervalsOverlap(left: Readonly<TickInterval>, right: Readonly<TickInterval>): boolean {
  return left.start < right.end && right.start < left.end
}

export function intervalIntersection(
  left: Readonly<TickInterval>,
  right: Readonly<TickInterval>,
): Readonly<TickInterval> | null {
  const start = left.start > right.start ? left.start : right.start
  const end = left.end < right.end ? left.end : right.end
  return end > start ? Object.freeze({ start, end }) : null
}

/** Ascending by start, then by end. Total and stable, so canonicalization is deterministic. */
export function compareIntervals(left: Readonly<TickInterval>, right: Readonly<TickInterval>): number {
  if (left.start !== right.start) return left.start < right.start ? -1 : 1
  if (left.end !== right.end) return left.end < right.end ? -1 : 1
  return 0
}

function roundQuotient(numerator: bigint, denominator: bigint, policy: RoundingPolicy): bigint {
  assertDomain(denominator !== BigInt(0), 'INVALID_ARGUMENT', 'Cannot round a quotient with a zero denominator')
  const negative = (numerator < BigInt(0)) !== (denominator < BigInt(0))
  const absNumerator = numerator < BigInt(0) ? -numerator : numerator
  const absDenominator = denominator < BigInt(0) ? -denominator : denominator
  const quotient = absNumerator / absDenominator
  const remainder = absNumerator % absDenominator

  if (remainder === BigInt(0)) return negative ? -quotient : quotient
  if (policy === 'floor') return negative ? -(quotient + BigInt(1)) : quotient
  if (policy === 'ceil') return negative ? -quotient : quotient + BigInt(1)

  // nearest-half-even: unbiased, so a long chain of conversions does not drift
  // in one direction the way half-up does.
  const twice = remainder * BigInt(2)
  let magnitude = quotient
  if (twice > absDenominator) magnitude = quotient + BigInt(1)
  else if (twice === absDenominator) magnitude = quotient % BigInt(2) === BigInt(0) ? quotient : quotient + BigInt(1)
  return negative ? -magnitude : magnitude
}

/**
 * Convert a tick from one timebase to another, exactly, then round once.
 *
 * The rounding happens a single time on the exact rational result. Converting
 * in stages and rounding at each one is how a two-hour session accumulates a
 * frame of error that nobody can attribute.
 */
export function convertTick(input: {
  tick: bigint
  from: Readonly<Timebase>
  to: Readonly<Timebase>
  rounding?: RoundingPolicy
}): bigint {
  const ratio = divideRational(input.from.secondsPerTick, input.to.secondsPerTick)
  const rounded = roundQuotient(input.tick * ratio.num, ratio.den, input.rounding ?? 'nearest-half-even')
  return assertInt64(rounded, 'converted tick')
}

/**
 * The affine map from one clock to another: `session = offset + rate * source`.
 *
 * `rate` is rational and `offset` is an integer tick, so the map is exact up to
 * the single rounding at the end. A map is only ever source → session; chaining
 * source → source through a third clock compounds error and, worse, hides which
 * clock is the authority.
 */
export interface AffineClockMap {
  readonly rate: Rational
  readonly offsetTicks: bigint
  readonly rounding: RoundingPolicy
}

export function createAffineClockMap(input: {
  rate: Rational
  offsetTicks: bigint
  rounding?: RoundingPolicy
}): Readonly<AffineClockMap> {
  // A zero or negative rate would make time stop or run backwards, and the
  // inverse map would not exist. Refuse it here rather than producing a map
  // whose round-trip silently fails later.
  assertDomain(input.rate.num > BigInt(0), 'INVALID_ARGUMENT', 'A clock map rate must be strictly positive')
  assertInt64(input.offsetTicks, 'clock map offset')
  return Object.freeze({
    rate: input.rate,
    offsetTicks: input.offsetTicks,
    rounding: input.rounding ?? 'nearest-half-even',
  })
}

export function applyAffineClockMap(map: Readonly<AffineClockMap>, sourceTick: bigint): bigint {
  const scaled = roundQuotient(sourceTick * map.rate.num, map.rate.den, map.rounding)
  return assertInt64(map.offsetTicks + scaled, 'mapped session tick')
}

/**
 * The inverse map.
 *
 * Rounding makes the inverse a near-inverse, not an exact one: distinct source
 * ticks can map to the same session tick when the rate compresses. Callers that
 * need an exact round-trip must check it, and `affineRoundTripError` is how.
 */
export function invertAffineClockMap(map: Readonly<AffineClockMap>, sessionTick: bigint): bigint {
  const delta = sessionTick - map.offsetTicks
  const scaled = roundQuotient(delta * map.rate.den, map.rate.num, map.rounding)
  return assertInt64(scaled, 'inverted source tick')
}

/** Ticks lost in a source → session → source round trip. Zero when exact. */
export function affineRoundTripError(map: Readonly<AffineClockMap>, sourceTick: bigint): bigint {
  return invertAffineClockMap(map, applyAffineClockMap(map, sourceTick)) - sourceTick
}

/**
 * Canonicalize a set of intervals: sort, then merge only what actually touches.
 *
 * Adjacency merges (`[0,100)` + `[100,200)` = `[0,200)`) because with half-open
 * bounds they are contiguous by definition. Overlap merges too, but the caller
 * is told it happened — two parts claiming the same ticks is a fact about the
 * recording that coverage must not quietly smooth over.
 */
export function canonicalizeIntervals(intervals: readonly Readonly<TickInterval>[]): Readonly<{
  merged: readonly Readonly<TickInterval>[]
  overlaps: readonly Readonly<TickInterval>[]
}> {
  if (intervals.length === 0) return Object.freeze({ merged: Object.freeze([]), overlaps: Object.freeze([]) })
  const sorted = [...intervals].sort(compareIntervals)
  const merged: TickInterval[] = []
  const overlaps: TickInterval[] = []
  let current = { start: sorted[0]!.start, end: sorted[0]!.end }

  for (const interval of sorted.slice(1)) {
    if (interval.start < current.end) {
      const overlap = { start: interval.start, end: interval.end < current.end ? interval.end : current.end }
      if (overlap.end > overlap.start) overlaps.push(Object.freeze(overlap))
      if (interval.end > current.end) current.end = interval.end
    } else if (interval.start === current.end) {
      current.end = interval.end
    } else {
      merged.push(Object.freeze({ ...current }))
      current = { start: interval.start, end: interval.end }
    }
  }
  merged.push(Object.freeze({ ...current }))
  return Object.freeze({ merged: Object.freeze(merged), overlaps: Object.freeze(overlaps) })
}

/** The holes between canonical intervals, inside an explicit outer bound. */
export function intervalGaps(
  intervals: readonly Readonly<TickInterval>[],
  bounds: Readonly<TickInterval>,
): readonly Readonly<TickInterval>[] {
  const { merged } = canonicalizeIntervals(intervals)
  const gaps: TickInterval[] = []
  let cursor = bounds.start
  for (const interval of merged) {
    const clipped = intervalIntersection(interval, bounds)
    if (!clipped) continue
    if (clipped.start > cursor) gaps.push(Object.freeze({ start: cursor, end: clipped.start }))
    if (clipped.end > cursor) cursor = clipped.end
  }
  if (cursor < bounds.end) gaps.push(Object.freeze({ start: cursor, end: bounds.end }))
  return Object.freeze(gaps)
}

/** Canonical serialization. `bigint` has no JSON representation, so it is decimal text. */
export function serializeTickInterval(interval: Readonly<TickInterval>): Readonly<{ start: string; end: string }> {
  return Object.freeze({ start: interval.start.toString(), end: interval.end.toString() })
}

export function deserializeTickInterval(value: Readonly<{ start: string; end: string }>): Readonly<TickInterval> {
  return createTickInterval(parseTick(value.start, 'interval start'), parseTick(value.end, 'interval end'))
}

export function serializeRational(value: Rational): string {
  return `${value.num}/${value.den}`
}

export function deserializeRational(value: string): Rational {
  const match = /^(-?\d{1,32})\/(-?\d{1,32})$/.exec(value)
  assertDomain(Boolean(match), 'INVALID_ARGUMENT', 'A serialized rational must be "num/den"')
  return rational(BigInt(match![1]!), BigInt(match![2]!))
}

export function parseTick(value: string, field: string): bigint {
  assertDomain(/^-?\d{1,19}$/.test(value), 'INVALID_ARGUMENT', `${field} must be a decimal integer string`)
  return assertInt64(BigInt(value), field)
}
