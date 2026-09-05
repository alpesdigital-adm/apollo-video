import { execFile } from 'node:child_process'
import { createRequire } from 'node:module'
import { stat } from 'node:fs/promises'
import { isAbsolute } from 'node:path'
import { promisify } from 'node:util'

import type {
  MulticamVisualEvidenceProvider,
  MulticamVisualMeasurement,
  MulticamVisualWindow,
} from '../../application/ports/multicam-evidence-sources.ts'
import { DomainError } from '../../domain/errors.ts'

/**
 * Screen activity and technical quality of a capture window, from FFmpeg
 * (F4.012, spec 05 §20).
 *
 * One decode per window with `signalstats`, in the shape
 * `ffmpeg-contiguous-visual-evidence-provider.ts:253-350` established: the
 * filter graph prints per-frame metadata, this class averages the frames of the
 * window, and nothing here decides anything about angles.
 *
 * The graph carried `scdet=threshold=10` and the method string said
 * `ffmpeg/signalstats+scdet`, and nothing ever read a single `lavfi.scd.*` key:
 * a provenance that names a filter which contributed nothing is a claimed
 * measurement with no command behind it, so the filter and the name went
 * together. What that costs is stated below rather than hidden.
 *
 * What each number IS, because a plausible-looking basis-point value with no
 * stated derivation is the thing this codebase refuses:
 *
 * - **activity** is `YDIF`, the mean absolute luma difference between
 *   consecutive frames, as a fraction of full scale. A slide that never changes
 *   measures near zero and produces NO observation; a screen share being
 *   scrolled measures a real number. A hard cut inside the window raises YDIF
 *   for the one frame it lands on and this pass does NOT separate it out — with
 *   a 30 s window and 30 fps a single cut moves the mean by about 1/900 of full
 *   scale, which is smaller than the spread between the sources measured in
 *   `multicam-visual-evidence.integration.mjs`. It is a known limit of the
 *   number, not a correction applied behind the reader's back.
 *
 *   **The axis is full scale, and full scale is enormous compared to real
 *   footage.** Measured with this exact code over generated sources (the
 *   integration suite prints the table): a still colour field is 0 bps, a
 *   slideshow changing every two seconds is 4 bps, a moving test pattern is
 *   103 bps, a mandelbrot zoom is 137 bps, and full-frame random noise — more
 *   change than any real recording contains — is 3151 bps. So a busy screen
 *   share lives in the low hundreds of basis points OF FULL SCALE, and the
 *   domain converts it with `SCREEN_ACTIVITY_SATURATION_BPS` rather than by
 *   dividing by 10 000. This paragraph exists because the two numbers used to
 *   disagree by two orders of magnitude and only the fakes knew.
 * - **stability** is `1 - TOUT`, the complement of the temporal-outlier ratio:
 *   pixels whose value disagrees violently with their temporal neighbours are
 *   sensor noise and shake, and a frame full of them is not stable footage.
 * - **exposure** is how close the mean luma `YAVG` sits to mid-grey, linearly:
 *   `1 - |YAVG - 128| / 128`. Blown-out and crushed both fall towards zero.
 * - **sharpness is `null`.** `signalstats` measures no sharpness, and neither
 *   `VREP` (repeated pixels) nor `YDIF` is one — VREP rises on a static shot
 *   that is perfectly sharp. Reporting either as sharpness would be a number
 *   with a wrong name on it, which is worse than the absence, so this pass
 *   returns null and the producer omits the dimension.
 *
 * A window whose decode produced no frames at all returns nulls throughout
 * rather than zeros; the caller drops it (`sampledFrameCount === 0`).
 *
 * No parameter properties: the strip-only TypeScript plain `node` runs refuses
 * `constructor(private readonly …)` outright (CONTRACT §2, precedent
 * `ffmpeg-sync-marker-renderer.ts:187-195`).
 */

const require = createRequire(import.meta.url)
const ffmpegStatic = require('ffmpeg-static') as string | null
const execFileAsync = promisify(execFile)

const FULL_SCALE = 255
const MID_GREY = 128

export const MULTICAM_VISUAL_EVIDENCE_METHOD = 'ffmpeg/signalstats'

function bps(fraction: number): number {
  return Math.max(0, Math.min(10_000, Math.round(fraction * 10_000)))
}

function samples(output: string, field: string): number[] {
  const escaped = field.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')
  return [...output.matchAll(new RegExp(`${escaped}=(-?[0-9]+(?:\\.[0-9]+)?)`, 'g'))]
    .map((match) => Number(match[1]))
    .filter((value) => Number.isFinite(value))
}

function mean(values: readonly number[]): number | null {
  if (values.length === 0) return null
  return values.reduce((total, value) => total + value, 0) / values.length
}

function assertWindow(window: Readonly<MulticamVisualWindow>, index: number): void {
  const invalid = !isAbsolute(window.path)
    || !Number.isFinite(window.sourceStartMs)
    || !Number.isFinite(window.sourceEndMs)
    || window.sourceStartMs < 0
    || window.sourceEndMs <= window.sourceStartMs
  if (invalid) {
    throw new DomainError(
      'INVALID_ARGUMENT',
      `multicam visual window ${index} must name an absolute path and a forward millisecond range`,
    )
  }
}

export class FfmpegMulticamVisualEvidenceProvider implements MulticamVisualEvidenceProvider {
  private readonly ffmpegPath: string
  private readonly timeoutMs: number

  constructor(options: { ffmpegPath?: string; timeoutMs?: number } = {}) {
    this.ffmpegPath = options.ffmpegPath?.trim() || ffmpegStatic || 'ffmpeg'
    this.timeoutMs = options.timeoutMs ?? 5 * 60_000
    if (!Number.isSafeInteger(this.timeoutMs) || this.timeoutMs < 5_000 || this.timeoutMs > 60 * 60_000) {
      throw new DomainError('PERSISTENCE_NOT_CONFIGURED', 'Multicam visual measurement timeout is not configured')
    }
  }

  async measure(input: {
    windows: readonly Readonly<MulticamVisualWindow>[]
    signal?: AbortSignal
  }): Promise<readonly Readonly<MulticamVisualMeasurement>[]> {
    input.windows.forEach(assertWindow)
    const measurements: Readonly<MulticamVisualMeasurement>[] = []
    for (const window of input.windows) {
      if (input.signal?.aborted) {
        throw new DomainError('VERSION_CONFLICT', 'Multicam visual measurement was cancelled')
      }
      const media = await stat(window.path).catch(() => null)
      if (!media?.isFile()) {
        throw new DomainError(
          'MEDIA_ARTIFACT_NOT_FOUND',
          `Multicam visual source for ${window.trackId} was not found at the materialized path`,
        )
      }
      const durationMs = window.sourceEndMs - window.sourceStartMs
      let output: string
      try {
        const result = await execFileAsync(
          this.ffmpegPath,
          [
            '-hide_banner', '-nostats', '-loglevel', 'info',
            '-ss', (window.sourceStartMs / 1_000).toFixed(3),
            '-t', (durationMs / 1_000).toFixed(3),
            '-i', window.path,
            '-map', '0:v:0',
            '-vf', 'setpts=PTS-STARTPTS,signalstats=stat=tout+vrep+brng,metadata=mode=print',
            '-an', '-f', 'null', '-',
          ],
          {
            windowsHide: true,
            timeout: this.timeoutMs,
            maxBuffer: 16 * 1024 * 1024,
            encoding: 'utf8',
            ...(input.signal ? { signal: input.signal } : {}),
          },
        )
        output = `${result.stdout}\n${result.stderr}`
      } catch {
        throw new DomainError(
          input.signal?.aborted ? 'VERSION_CONFLICT' : 'RENDER_EXECUTION_FAILED',
          input.signal?.aborted
            ? 'Multicam visual measurement was cancelled'
            : `FFmpeg multicam visual measurement failed for ${window.trackId}`,
        )
      }
      const luma = samples(output, 'lavfi.signalstats.YAVG')
      const difference = samples(output, 'lavfi.signalstats.YDIF')
      const outliers = samples(output, 'lavfi.signalstats.TOUT')
      const meanLuma = mean(luma)
      const meanDifference = mean(difference)
      const meanOutliers = mean(outliers)
      measurements.push(Object.freeze({
        trackId: window.trackId,
        partId: window.partId,
        sourceArtifactId: window.sourceArtifactId,
        sourceStartMs: window.sourceStartMs,
        sourceEndMs: window.sourceEndMs,
        sampledFrameCount: luma.length,
        activityBps: meanDifference === null ? null : bps(meanDifference / FULL_SCALE),
        // Not measured by this pass. See the header: no signalstats field is a
        // sharpness, and naming one of them sharpness would be a lie with a
        // number attached.
        sharpnessBps: null,
        stabilityBps: meanOutliers === null ? null : bps(1 - Math.min(1, meanOutliers)),
        exposureBps: meanLuma === null ? null : bps(1 - Math.abs(meanLuma - MID_GREY) / MID_GREY),
        method: MULTICAM_VISUAL_EVIDENCE_METHOD,
        evidenceRef: `media-artifact:${window.sourceArtifactId}:${window.sourceStartMs}-${window.sourceEndMs}`,
      }))
    }
    return Object.freeze(measurements)
  }
}
