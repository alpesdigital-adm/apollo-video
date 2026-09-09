import type { CameraColorMeasurement } from '../../domain/color-measurement.ts'
import type { TickInterval } from '../../domain/session-time.ts'

/**
 * The instrument that reads colour out of decoded frames (F4.013/F4.014).
 *
 * The port exists so the application service never holds an FFmpeg process, and
 * so the numbers it plans with are always produced by an instrument rather than
 * supplied by a caller. Everything a request carries is a position — which file,
 * which bytes, which camera, which stretch of it — and everything that comes
 * back is measured.
 *
 * The source extent is named in seconds rather than frames on purpose. A capture
 * session counts in ticks; a tick converts to seconds exactly through its
 * timebase and to a frame index only through a frame rate, which the probe
 * knows and the service does not. Converting in the service would mean carrying
 * a guessed rate, and a frame index derived from a guessed rate points at the
 * wrong picture without ever failing.
 */
export interface CameraColorProbeRange {
  /** Session ticks this range describes. */
  readonly sessionRange: Readonly<TickInterval>
  /** Seconds from the start of the file, half-open. */
  readonly sourceStartSeconds: number
  readonly sourceEndSeconds: number
  readonly measurementId?: string
}

export interface CameraColorProbe {
  measureCameraColor(input: {
    readonly mediaPath: string
    readonly cameraId: string
    readonly sourceAssetId: string
    readonly sourceSha256: string
    readonly sessionId?: string | null
    readonly ranges: readonly Readonly<CameraColorProbeRange>[]
    readonly sampleEveryMs?: number
    readonly signal?: AbortSignal
  }): Promise<readonly Readonly<CameraColorMeasurement>[]>
}

/**
 * A capture part's file, materialized, plus the way to give it back.
 *
 * `release` is not optional politeness: the S3 driver materializes by
 * downloading the whole recording, so a measurement sweep over a six-track
 * session that forgets leaks six recordings a pass. Mirrors
 * `CaptureMediaResolver.resolve` so the existing adapter satisfies this port
 * without a wrapper.
 */
export interface CaptureMediaPort {
  resolve(input: {
    workspaceId: string
    part: Readonly<{ partId: string; evidence: Readonly<{ ingestArtifactId: string; ingestSha256: string }> }>
  }): Promise<Readonly<{ path: string; release: () => Promise<void> }>>
}
