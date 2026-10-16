import { assertDomain } from './errors.ts'

/** FFmpeg vf_subtitles forwards PTS * time_base * 1000 to libass. Events are
 * half-open in milliseconds; ASS stores centiseconds. Never round a boundary
 * into the next frame. A representable global interval does not authorize a
 * clipped/rebased fragment: validate the fragment in its own clock as well. */
export const ASS_EMISSION_POLICY = Object.freeze({
  version: 'ass-frame-clock/v1',
  boundary: 'floor-centiseconds-exact-frame-ceiling',
  text: 'nfc-c0-del-reject-lf-wrap',
  fragment: 'revalidate-after-clip-and-rebase',
} as const)

export type AssFrameRate = number | Readonly<{ numerator: number; denominator: number }>
const ONE = BigInt(1)
const CS_PER_SECOND = BigInt(100)
const CS_PER_MINUTE = BigInt(6000)
const CS_PER_HOUR = BigInt(360000)

function rational(fps: AssFrameRate): readonly [bigint, bigint] {
  const numerator = typeof fps === 'number' ? fps : fps.numerator
  const denominator = typeof fps === 'number' ? 1 : fps.denominator
  assertDomain(Number.isSafeInteger(numerator) && Number.isSafeInteger(denominator) &&
    numerator > 0 && denominator > 0,
  'INVALID_RENDER_INPUT', 'ASS clock requires a positive safe integer rational frame rate')
  const num = BigInt(numerator), den = BigInt(denominator)
  assertDomain(num >= den && num <= BigInt(120) * den,
    'INVALID_RENDER_INPUT', 'ASS frame rate must be between 1 and 120')
  return [num, den]
}

export function assFrameCentiseconds(frame: number, fps: AssFrameRate): bigint {
  assertDomain(Number.isSafeInteger(frame) && frame >= 0,
    'INVALID_RENDER_INPUT', 'ASS boundary frame must be a non-negative safe integer')
  const [num, den] = rational(fps)
  const cs = BigInt(frame) * CS_PER_SECOND * den / num
  const scale = CS_PER_SECOND * den
  assertDomain((cs * num + scale - ONE) / scale === BigInt(frame),
    'INVALID_RENDER_INPUT', 'ASS boundary cannot represent the exact frame at this frame rate', { frame })
  return cs
}

export function assFrameTimestamp(frame: number, fps: AssFrameRate): string {
  const cs = assFrameCentiseconds(frame, fps)
  return `${cs / CS_PER_HOUR}:${String(cs % CS_PER_HOUR / CS_PER_MINUTE).padStart(2, '0')}:` +
    `${String(cs % CS_PER_MINUTE / CS_PER_SECOND).padStart(2, '0')}.${String(cs % CS_PER_SECOND).padStart(2, '0')}`
}

export function assertAssFrameInterval(start: number, end: number, fps: AssFrameRate): void {
  assertDomain(Number.isSafeInteger(start) && Number.isSafeInteger(end) && start >= 0 && end > start,
    'INVALID_RENDER_INPUT', 'ASS interval must be positive in safe integer frames')
  const startCs = assFrameCentiseconds(start, fps)
  const endCs = assFrameCentiseconds(end, fps)
  assertDomain(endCs > startCs, 'INVALID_RENDER_INPUT', 'ASS interval collapses in centiseconds')
}

/** LF is the only accepted control; the renderer wraps it as ordinary word
 * whitespace and emits its own explicit \\N line breaks. No CR normalization
 * or whitespace trimming may hide a forbidden control before this gate. */
export function assertAssCueText(value: string): void {
  assertDomain(typeof value === 'string', 'INVALID_RENDER_INPUT', 'ASS text must be a string')
  for (let index = 0; index < value.length; index += 1) {
    const code = value.charCodeAt(index)
    assertDomain((code >= 0x20 || code === 0x0a) && code !== 0x7f,
      'INVALID_RENDER_INPUT', 'ASS text contains forbidden control characters')
  }
}
