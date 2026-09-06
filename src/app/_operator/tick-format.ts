/**
 * Reading session time and measurements out loud, for the Wave 20 operator
 * surfaces.
 *
 * Shared rather than copied into each page. The three screens were carrying
 * byte-identical copies of these four functions, which meant a rounding defect
 * had to be found and fixed three times — and the one that was here really did
 * exist in all three at once.
 */

/** Seconds per tick, kept as the pair it arrived as. */
export interface TickRate {
  readonly numerator: bigint
  readonly denominator: bigint
}

/**
 * `"1001/30000"` seconds per tick, kept whole.
 *
 * The obvious reading — "ticks per second is denominator over numerator" —
 * truncates every rate that is not `1/N`. A 30000/1001 clock became 29 ticks a
 * second, and a five-minute interval printed as `310,034 s`: three per cent
 * long, with nothing on screen saying it was approximate. The boundary accepts
 * any rational (`session-time.ts` only asserts a positive numerator), so the
 * pair is carried through and the division is done once, exactly, in
 * {@link formatTicks}.
 */
export function tickRateFrom(secondsPerTick: string | undefined): TickRate | null {
  if (!secondsPerTick) return null
  const [num, den] = secondsPerTick.split('/')
  try {
    const numerator = BigInt(num ?? '')
    const denominator = BigInt(den ?? '')
    if (numerator <= BigInt(0) || denominator <= BigInt(0)) return null
    return { numerator, denominator }
  } catch {
    return null
  }
}

/**
 * Ticks divided exactly, or handed back as they arrived.
 *
 * A tick is 64-bit. Parsing one into a `Number` to divide it would undo the
 * whole reason the boundary sends decimal strings, and the rounding would be
 * invisible. When the timebase is unknown the raw string is shown: a duration
 * invented from an assumed rate would be a measurement nobody took.
 */
export function formatTicks(ticks: string, rate: TickRate | null): string {
  if (rate === null) return `${ticks} ticks`
  try {
    const value = BigInt(ticks)
    const negative = value < BigInt(0)
    const absolute = negative ? -value : value
    // seconds = ticks × numerator ÷ denominator, in integers, once.
    const scaled = absolute * rate.numerator
    const seconds = scaled / rate.denominator
    const millis = ((scaled % rate.denominator) * BigInt(1_000)) / rate.denominator
    return `${negative ? '−' : ''}${seconds},${String(millis).padStart(3, '0')} s`
  } catch {
    return `${ticks} ticks`
  }
}

/** A measurement in basis points, or the honest absence of one. */
export function showBps(value: number | null): string {
  return value === null ? 'não medida' : `${(value / 100).toFixed(2)} %`
}

/** A ratio, or the honest absence of one. */
export function showRatio(value: number | null): string {
  return value === null ? 'não medida' : value.toFixed(3)
}

/**
 * A number, or the honest absence of one.
 *
 * This function is the whole reason the deltas table is readable. Rendering a
 * null as `0.00` would say "measured, and this camera already matches the
 * reference" — the one claim nobody made.
 */
export function showNumber(value: number | null, digits = 3, unit = ''): string {
  return value === null ? 'não medido' : `${value.toFixed(digits)}${unit}`
}
