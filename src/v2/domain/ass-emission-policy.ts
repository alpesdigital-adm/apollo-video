import { assertDomain } from './errors.ts'
import { LIBASS_NOW_CONVERSION_POLICY, createClosedClockAssBoundaryBinder,
  type AssBoundaryBinder, type AssFrameRate } from './libass-clock-model.ts'

export type { AssBoundaryBinder, AssFrameRate }

/** v3 keeps the v2 binder and changes only the stage that closes the clock. v2 replaced the
 * reprobated exact-rational v1 arithmetic. FFmpeg vf_subtitles
 * hands libass `trunc(pts * q2d * 1000)` in binary64, not the exact frame time;
 * libass events are half-open in milliseconds and ASS stores centiseconds. The
 * boundary of a frame is therefore an integer centisecond inside the window
 * `previousNow < 10*cs <= currentNow` of the clock the subtitles filter really
 * sees, never the centisecond of the ideal time, and an empty window is a typed
 * refusal. The clock is closed-form because the last stage before the filter is
 * `settb=1/<rate>,setpts=N`: the frames are numbered consecutively in the inverse
 * of the rate (v2 used `fps=<rate>`, which lost the last frame on FFmpeg 6.1.1;
 * see ffmpeg-editorial-composition-graph.ts). A representable global interval does not authorize a
 * clipped/rebased fragment: every fragment is bound again in its own clock.
 * Model, cause and proofs: libass-clock-model.ts. */
export const ASS_EMISSION_POLICY = Object.freeze({
  version: 'ass-frame-clock/v3',
  clock: 'settb-setpts-consecutive-pts/v1',
  conversion: LIBASS_NOW_CONVERSION_POLICY,
  boundary: 'libass-now-preimage-maximum-centisecond',
  domain: 'first-minus-one-ms-last-plus-ten-ms',
  unrepresentable: 'typed-refusal-before-render',
  text: 'nfc-c0-del-reject-lf-wrap',
  fragment: 'revalidate-after-clip-and-rebase',
} as const)

/** Binder of one fragment: `durationFrames` frames numbered from 0 at `fps`. */
export function assFrameClockBinder(fps: AssFrameRate, durationFrames: number): AssBoundaryBinder {
  assertDomain(Number.isSafeInteger(durationFrames) && durationFrames > 0,
    'INVALID_RENDER_INPUT', 'ASS clock requires a positive fragment frame count')
  return createClosedClockAssBoundaryBinder({ fps, frameCount: durationFrames })
}

/** Validates a half-open frame interval of a fragment against its own clock. */
export function assertAssFrameInterval(start: number, end: number, fps: AssFrameRate, durationFrames: number): void {
  assertDomain(Number.isSafeInteger(start) && Number.isSafeInteger(end) && start >= 0 && end > start,
    'INVALID_RENDER_INPUT', 'ASS interval must be positive in safe integer frames')
  const binder = assFrameClockBinder(fps, durationFrames)
  assertDomain(end <= durationFrames, 'INVALID_RENDER_INPUT',
    'ASS interval ends after the fragment', { start, end, durationFrames })
  binder.interval(start, end)
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
