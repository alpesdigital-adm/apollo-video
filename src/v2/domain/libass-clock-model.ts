import { assertDomain, DomainError } from './errors.ts'

/**
 * Pure model of what FFmpeg `vf_subtitles` hands to libass, and of the ASS
 * centisecond boundaries that make libass draw exactly the requested frames.
 *
 * Cause of the W69 v5 failures (limits 99/3699/8029 instead of 100/3700/8030):
 * `vf_subtitles` does not pass the exact rational time of a frame. It computes
 *   double time_ms = pts * av_q2d(time_base) * 1000;
 * and the implicit conversion at `ass_render_frame(…, long long now, …)`
 * truncates toward zero. Binary64 rounds after `av_q2d`, after the product with
 * the PTS and after `* 1000`, so a frame that sits exactly on a millisecond can
 * arrive one millisecond low (6 @ 1/60 s is 100, but 100000 @ 1/1000000 s is
 * 99.99999999999999 and truncates to 99; 111 @ 1/30 is 3699; 803 @ 1/100 is
 * 8029). libass shows an event iff `start <= now < start + duration`
 * (half-open, milliseconds) and ASS stores centiseconds, so a boundary written
 * at the ideal centisecond lands one frame late exactly on those frames. The
 * visibility rule itself, the rounding direction of the centisecond and the
 * inclusivity were not at fault: the evidence pins them (an event starting at
 * the exact `now` is shown, one ending at it is not).
 *
 * The binder below never repairs the clock numerically: no epsilon, no shifted
 * expectation, no frame-rate cap. It selects, for each requested boundary, an
 * integer centisecond inside the interval of centiseconds that is representable
 * for that frame, or refuses with a typed error when that interval is empty.
 */
export const LIBASS_NOW_CONVERSION_POLICY = 'ffmpeg-ass-fp64-q2d-mul1000-trunc-int64/v1' as const

export interface ClockTimeBase { numerator: string; denominator: string }

const MIN_I64 = -(BigInt(1) << BigInt(63)), MAX_I64 = (BigInt(1) << BigInt(63)) - BigInt(1)
const MAX_I32 = BigInt(2147483647)
/** `fps=<rate>` is parsed by `av_parse_video_rate` with this bound on each term. */
const MAX_FRAME_RATE_TERM = BigInt(1001000)

const check = (value: unknown, message: string, details: Record<string, unknown> = {}) =>
  assertDomain(Boolean(value), 'INVALID_RENDER_INPUT', message, details)
const integer = (value: unknown) => typeof value === 'number' && Number.isSafeInteger(value) && value >= 0

export function parseClockInt64(value: string): bigint {
  check(typeof value === 'string' && /^(?:0|-?[1-9]\d{0,18})$/.test(value), 'Clock integer must be canonical signed int64')
  const result = BigInt(value)
  check(result >= MIN_I64 && result <= MAX_I64, 'Clock integer overflow')
  return result
}
export function parseClockTimeBase(value: ClockTimeBase): readonly [bigint, bigint] {
  check(value !== null && typeof value === 'object' && Object.keys(value).length === 2 &&
    Object.keys(value).every((key) => key === 'numerator' || key === 'denominator'),
  'Clock document has missing or unsupported fields')
  const num = parseClockInt64(value.numerator), den = parseClockInt64(value.denominator)
  check(num > 0 && den > 0 && num <= MAX_I32 && den <= MAX_I32, 'Clock time_base must be positive AVRational int32')
  return [num, den]
}

/** Deliberately preserves binary64 rounding at q2d and both multiplications.
 * Exact rational rescaling, n/fps, epsilon and reassociation are different policies. */
export function derivePinnedLibassNowMs(pts: string, tb: ClockTimeBase): bigint {
  const value = parseClockInt64(pts)
  check(value !== MIN_I64, 'AV_NOPTS_VALUE is not an observed timestamp')
  const [num, den] = parseClockTimeBase(tb)
  const q2d = Number(num) / Number(den)
  const seconds = Number(value) * q2d
  const milliseconds = seconds * 1000
  check(Number.isFinite(milliseconds), 'Non-finite libass clock conversion')
  const result = BigInt(Math.trunc(milliseconds))
  check(result >= MIN_I64 && result <= MAX_I64, 'Libass millisecond conversion overflows int64')
  return result
}

function floorDiv(value: bigint, divisor: bigint): bigint {
  const quotient = value / divisor
  return value < BigInt(0) && value % divisor !== BigInt(0) ? quotient - BigInt(1) : quotient
}

export const ASS_BOUNDARY_UNREPRESENTABLE = 'ASS_BOUNDARY_UNREPRESENTABLE' as const
export type AssBoundaryRefusal = 'no-centisecond-in-frame-window' | 'collapsed-milliseconds'
/** Typed refusal: the requested boundary cannot be expressed in ASS centiseconds
 * for this clock. It is raised before any renderer, cache or publication work. */
export class AssBoundaryUnrepresentableError extends DomainError {
  readonly reason = ASS_BOUNDARY_UNREPRESENTABLE
  readonly refusal: AssBoundaryRefusal
  constructor(message: string, refusal: AssBoundaryRefusal, details: Record<string, unknown>) {
    super('INVALID_RENDER_INPUT', message, { reason: ASS_BOUNDARY_UNREPRESENTABLE, refusal, ...details })
    this.name = 'AssBoundaryUnrepresentableError'
    this.refusal = refusal
  }
}
export const isAssBoundaryUnrepresentable = (error: unknown): error is AssBoundaryUnrepresentableError =>
  error instanceof AssBoundaryUnrepresentableError

/** Integer centiseconds `cs` with `previousMs < 10*cs <= currentMs`: the only
 * values for which libass has not yet shown the event at the previous frame and
 * already shows it at this one. The same set governs an exclusive end. */
export function legalAssCentisecondPreimage(previousMs: bigint, currentMs: bigint,
  context: Readonly<{ frame?: number }> = {}): Readonly<{ minimum: bigint; maximum: bigint }> {
  check(typeof previousMs === 'bigint' && typeof currentMs === 'bigint' &&
    previousMs >= MIN_I64 && previousMs <= MAX_I64 && currentMs >= MIN_I64 && currentMs <= MAX_I64,
  'ASS boundary requires ordered int64 milliseconds')
  const where = { previousMs: String(previousMs), currentMs: String(currentMs),
    ...(context.frame === undefined ? {} : { frame: context.frame }) }
  if (currentMs <= previousMs) {
    throw new AssBoundaryUnrepresentableError('ASS boundary requires ordered int64 milliseconds', 'collapsed-milliseconds', where)
  }
  const minimum = floorDiv(previousMs, BigInt(10)) + BigInt(1), maximum = floorDiv(currentMs, BigInt(10))
  if (!(maximum >= minimum && maximum >= BigInt(0))) {
    throw new AssBoundaryUnrepresentableError('ASS interval is not representable in the materialized clock',
      'no-centisecond-in-frame-window', where)
  }
  return Object.freeze({ minimum: minimum < BigInt(0) ? BigInt(0) : minimum, maximum })
}

export function assCentisecondTimestamp(cs: bigint): string {
  check(typeof cs === 'bigint' && cs >= BigInt(0) && cs * BigInt(10) <= MAX_I64 &&
    cs / BigInt(360000) <= MAX_I32, 'ASS timestamp overflows the millisecond/parser clock')
  return cs / BigInt(360000) + ':' + String(cs % BigInt(360000) / BigInt(6000)).padStart(2, '0') + ':' +
    String(cs % BigInt(6000) / BigInt(100)).padStart(2, '0') + '.' + String(cs % BigInt(100)).padStart(2, '0')
}

export interface AssBoundaryBinder {
  readonly frameCount: number
  /** libass `now` of frame `frame` (0 <= frame < frameCount). */
  nowMs(frame: number): bigint
  /** Centisecond that starts (or exclusively ends) at `frame` (0 <= frame <= frameCount). */
  boundary(frame: number): bigint
  /** Half-open frame interval [start, end) as centiseconds that draw exactly those frames. */
  interval(start: number, end: number): Readonly<{ startCs: bigint; endCs: bigint }>
  timestamps(start: number, end: number): Readonly<{ start: string; end: string }>
}

/** Binds frame intervals to representable ASS boundaries over an explicit clock.
 * `beforeFirstNowMs` and `endExclusiveNowMs` are the explicit domain bounds: no
 * predecessor of the first frame and no successor of the last is invented.
 * The maximum of each admissible window is chosen, as in the materialized clock
 * contract, so both paths emit identical bytes for an identical clock. */
export function createAssBoundaryBinder(input: {
  frameCount: number
  nowMsAt(frame: number): bigint
  beforeFirstNowMs: bigint
  endExclusiveNowMs: bigint
}): AssBoundaryBinder {
  const { frameCount, nowMsAt, beforeFirstNowMs, endExclusiveNowMs } = input
  check(integer(frameCount) && frameCount > 0, 'ASS clock requires a positive frame count')
  const nowMs = (frame: number): bigint => {
    check(integer(frame) && frame < frameCount, 'ASS clock frame is outside the fragment')
    return nowMsAt(frame)
  }
  const boundary = (frame: number): bigint => {
    check(integer(frame) && frame <= frameCount, 'ASS boundary outside the fragment clock')
    return legalAssCentisecondPreimage(frame === 0 ? beforeFirstNowMs : nowMsAt(frame - 1),
      frame === frameCount ? endExclusiveNowMs : nowMsAt(frame), { frame }).maximum
  }
  const interval = (start: number, end: number) => {
    check(integer(start) && integer(end) && end > start, 'Invalid ASS local frame interval')
    const startCs = boundary(start), endCs = boundary(end)
    check(endCs > startCs, 'Materialized ASS interval collapses')
    return Object.freeze({ startCs, endCs })
  }
  const timestamps = (start: number, end: number) => {
    const { startCs, endCs } = interval(start, end)
    return Object.freeze({ start: assCentisecondTimestamp(startCs), end: assCentisecondTimestamp(endCs) })
  }
  return Object.freeze({ frameCount, nowMs, boundary, interval, timestamps })
}

/** Frame rate as an integer or an explicit rational. A decimal such as 29.97 is
 * refused: FFmpeg would turn it into an approximated rational and the model must
 * not guess which. */
export type AssFrameRate = number | Readonly<{ numerator: number; denominator: number }>

function gcd(left: bigint, right: bigint): bigint {
  let a = left, b = right
  while (b !== BigInt(0)) [a, b] = [b, a % b]
  return a
}
/** The time base the `fps` filter publishes: the inverse of the reduced rate. */
export function frameRateTimeBase(fps: AssFrameRate): Readonly<ClockTimeBase> {
  const numerator = typeof fps === 'number' ? fps : fps?.numerator
  const denominator = typeof fps === 'number' ? 1 : fps?.denominator
  check(Number.isSafeInteger(numerator) && Number.isSafeInteger(denominator) && numerator > 0 && denominator > 0,
    'ASS clock requires a positive safe integer rational frame rate')
  const divisor = gcd(BigInt(numerator), BigInt(denominator))
  const num = BigInt(numerator) / divisor, den = BigInt(denominator) / divisor
  check(num <= MAX_FRAME_RATE_TERM && den <= MAX_FRAME_RATE_TERM,
    'ASS frame rate terms exceed the FFmpeg rate parser bound')
  return Object.freeze({ numerator: String(den), denominator: String(num) })
}

/** Closed-form clock of a stream whose last stage before libass is `fps=<rate>`:
 * the filter publishes the inverse of the reduced rate as time base and numbers
 * the frames consecutively from the first PTS, so frame k carries PTS k. The
 * first-frame predecessor is -1 ms and the end bound is the first centisecond
 * after the last frame; nothing exists beyond either. */
export function createFpsStageAssBoundaryBinder(input: { fps: AssFrameRate; frameCount: number }): AssBoundaryBinder {
  const timeBase = frameRateTimeBase(input.fps)
  check(integer(input.frameCount) && input.frameCount > 0, 'ASS clock requires a positive frame count')
  const nowMsAt = (frame: number) => derivePinnedLibassNowMs(String(frame), timeBase)
  return createAssBoundaryBinder({ frameCount: input.frameCount, nowMsAt, beforeFirstNowMs: BigInt(-1),
    endExclusiveNowMs: nowMsAt(input.frameCount - 1) + BigInt(10) })
}
