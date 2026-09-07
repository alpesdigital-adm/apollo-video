import { execFile } from 'node:child_process'
import { stat } from 'node:fs/promises'
import { isAbsolute } from 'node:path'
import { promisify } from 'node:util'

import type {
  MulticamAudioWindow,
  MulticamSilenceEvidenceProvider,
  MulticamSilenceMeasurement,
  MulticamSilentStretch,
} from '../../application/ports/multicam-evidence-sources.ts'
import { DomainError } from '../../domain/errors.ts'
import { resolveFfmpegBinary } from '../media/ffmpeg-binary.ts'

/**
 * The `silence` evidence kind, measured (F4.012, spec 05 §20 and §29.1).
 *
 * `MULTICAM_EVIDENCE_KINDS` has carried `silence` since the kind was modelled,
 * `multicam_observations_kind_check` in the migration has accepted it, the
 * aggregate validates it and the repository stores it — and no adapter anywhere
 * produced one. A kind that is validated and persisted and never observed is a
 * shape, not evidence. This class is what makes it a measurement.
 *
 * **What the numbers ARE.** One FFmpeg pass per window runs two filters over
 * the same samples and reads both:
 *
 * - `silencedetect=noise=<threshold>dB:d=<minimum>` decides WHERE the stretches
 *   are. It reports one only after the level has stayed under the threshold for
 *   the whole minimum duration, which is why the gap between two words does not
 *   become a silence observation.
 * - `astats` over fixed blocks of samples (`asetnsamples`) decides HOW QUIET
 *   each stretch was. `ceilingDbfs` is the loudest block inside the stretch — an
 *   upper bound the samples really respected, not a mean that would understate a
 *   stretch with one thump in it.
 *
 * **Digital silence has no dBFS.** A block of exact zeros makes `astats` print
 * `RMS_level=-inf`, and `-inf` is not a level. It is reported as
 * `MULTICAM_SILENCE_MEASUREMENT_FLOOR_DBFS`, the same −120 dB floor the sibling
 * pass already uses for the same reason
 * (`ffmpeg-contiguous-audio-evidence-provider.ts:24`), so the number stays
 * finite, stays honest about being a floor, and does not turn into a `null` that
 * would claim nobody listened.
 *
 * **A file with no audio is not a silent file.** FFmpeg exits non-zero both when
 * the input carries no audio stream and when the decode broke, and the two are
 * opposite facts. They are separated by the same stderr patterns
 * `ffmpeg-audio-sync-signal-source.ts:743-750` already uses: no audio stream
 * returns `measuredBlockCount: 0` with no stretches, which the producer drops
 * and REPORTS; a broken decode throws.
 *
 * No parameter properties: the strip-only plain `node` runs refuse
 * `constructor(private readonly …)` (CONTRACT §2, precedent
 * `ffmpeg-sync-marker-renderer.ts:187-195`).
 */

const execFileAsync = promisify(execFile)

export const MULTICAM_SILENCE_EVIDENCE_METHOD = 'ffmpeg/silencedetect+astats'

/**
 * The level reported for a block of exact zeros.
 *
 * A floor, said out loud, rather than an `-inf` the JSON codec cannot carry or
 * a `null` that would mean "not measured". Same value and same reason as
 * `MEASUREMENT_FLOOR_DB` in `ffmpeg-contiguous-audio-evidence-provider.ts`.
 */
export const MULTICAM_SILENCE_MEASUREMENT_FLOOR_DBFS = -120

/**
 * −50 dBFS over at least 700 ms.
 *
 * The threshold sits below the room tone of a treated room and far below any
 * speech; the duration is longer than the gap between two words and shorter than
 * the pause that means somebody stopped talking. Both are named here rather than
 * taken from a request because they are the definition of the measurement — a
 * caller that could move them could ask for the answer it wanted (CONTRACT §2).
 */
export const MULTICAM_SILENCE_DEFAULTS = Object.freeze({
  thresholdDbfs: -50,
  minimumSilenceMs: 700,
  /** One `astats` reading per 100 ms of audio, at the analysis sample rate. */
  blockMs: 100,
  /** Mono at 16 kHz: this pass reads the level of a stretch, not its content. */
  sampleRate: 16_000,
})

const NO_AUDIO_STREAM = /does not contain any stream|matches no streams|Output file is empty/i

function assertWindow(window: Readonly<MulticamAudioWindow>, index: number): void {
  const invalid = !isAbsolute(window.path)
    || !Number.isFinite(window.sourceStartMs)
    || !Number.isFinite(window.sourceEndMs)
    || window.sourceStartMs < 0
    || window.sourceEndMs <= window.sourceStartMs
  if (invalid) {
    throw new DomainError(
      'INVALID_ARGUMENT',
      `multicam audio window ${index} must name an absolute path and a forward millisecond range`,
    )
  }
}

/** One `astats` reading: the instant it covers and the level it measured. */
interface LevelBlock {
  readonly atMs: number
  readonly levelDbfs: number
}

/**
 * `ametadata=mode=print` writes a frame line and then the key it was asked for,
 * so one block is a pair of consecutive lines and the parser has to keep them
 * together. Reading the levels alone would attribute them to the wrong instants
 * the moment one frame carried no level.
 */
function readLevelBlocks(output: string): readonly LevelBlock[] {
  const blocks: LevelBlock[] = []
  let pending: number | null = null
  for (const line of output.split(/\r?\n/)) {
    const frame = /(?:^|\s)pts_time:(-?[0-9]+(?:\.[0-9]+)?)/.exec(line)
    if (frame) {
      pending = Number(frame[1]) * 1_000
      continue
    }
    const level = /lavfi\.astats\.Overall\.RMS_level=(-?(?:inf|[0-9]+(?:\.[0-9]+)?))/.exec(line)
    if (level && pending !== null) {
      const text = level[1] ?? ''
      blocks.push(Object.freeze({
        atMs: pending,
        levelDbfs: text.endsWith('inf') ? MULTICAM_SILENCE_MEASUREMENT_FLOOR_DBFS : Number(text),
      }))
      pending = null
    }
  }
  return Object.freeze(blocks)
}

/**
 * The stretches `silencedetect` reported, in milliseconds from the window start.
 *
 * A stretch still open at the end is closed at the window's own end: FFmpeg does
 * not always print `silence_end` when the input ends inside a silence, and
 * dropping it would report a recording that faded out as one that never went
 * quiet.
 */
function readSilentRanges(
  output: string,
  windowMs: number,
): readonly Readonly<{ startMs: number; endMs: number }>[] {
  const ranges: Array<{ startMs: number; endMs: number }> = []
  let open: number | null = null
  for (const line of output.split(/\r?\n/)) {
    const start = /silence_start:\s*(-?[0-9]+(?:\.[0-9]+)?)/.exec(line)
    if (start) {
      open = Math.max(0, Number(start[1]) * 1_000)
      continue
    }
    const end = /silence_end:\s*(-?[0-9]+(?:\.[0-9]+)?)/.exec(line)
    if (end && open !== null) {
      ranges.push({ startMs: open, endMs: Math.min(windowMs, Number(end[1]) * 1_000) })
      open = null
    }
  }
  if (open !== null && open < windowMs) ranges.push({ startMs: open, endMs: windowMs })
  return Object.freeze(
    ranges
      .filter((range) => range.endMs > range.startMs)
      .map((range) => Object.freeze(range)),
  )
}

export class FfmpegMulticamSilenceProvider implements MulticamSilenceEvidenceProvider {
  private readonly ffmpegPath: string
  private readonly timeoutMs: number
  private readonly thresholdDbfs: number
  private readonly minimumSilenceMs: number

  constructor(options: {
    ffmpegPath?: string
    timeoutMs?: number
    thresholdDbfs?: number
    minimumSilenceMs?: number
  } = {}) {
    this.ffmpegPath = resolveFfmpegBinary(options.ffmpegPath)
    this.timeoutMs = options.timeoutMs ?? 5 * 60_000
    this.thresholdDbfs = options.thresholdDbfs ?? MULTICAM_SILENCE_DEFAULTS.thresholdDbfs
    this.minimumSilenceMs = options.minimumSilenceMs ?? MULTICAM_SILENCE_DEFAULTS.minimumSilenceMs
    if (!Number.isSafeInteger(this.timeoutMs) || this.timeoutMs < 5_000 || this.timeoutMs > 60 * 60_000) {
      throw new DomainError('PERSISTENCE_NOT_CONFIGURED', 'Multicam silence measurement timeout is not configured')
    }
    if (
      !Number.isFinite(this.thresholdDbfs)
      || this.thresholdDbfs >= 0
      || this.thresholdDbfs <= MULTICAM_SILENCE_MEASUREMENT_FLOOR_DBFS
    ) {
      throw new DomainError(
        'PERSISTENCE_NOT_CONFIGURED',
        'Multicam silence threshold must be a negative dBFS level above the measurement floor',
      )
    }
    if (!Number.isSafeInteger(this.minimumSilenceMs) || this.minimumSilenceMs < 100 || this.minimumSilenceMs > 60_000) {
      throw new DomainError(
        'PERSISTENCE_NOT_CONFIGURED',
        'Multicam silence minimum duration must be between 100 ms and one minute',
      )
    }
  }

  async measure(input: {
    windows: readonly Readonly<MulticamAudioWindow>[]
    signal?: AbortSignal
  }): Promise<readonly Readonly<MulticamSilenceMeasurement>[]> {
    input.windows.forEach(assertWindow)
    const measurements: Readonly<MulticamSilenceMeasurement>[] = []
    const samplesPerBlock = Math.round(
      (MULTICAM_SILENCE_DEFAULTS.sampleRate * MULTICAM_SILENCE_DEFAULTS.blockMs) / 1_000,
    )
    for (const window of input.windows) {
      if (input.signal?.aborted) {
        throw new DomainError('VERSION_CONFLICT', 'Multicam silence measurement was cancelled')
      }
      const media = await stat(window.path).catch(() => null)
      if (!media?.isFile()) {
        throw new DomainError(
          'MEDIA_ARTIFACT_NOT_FOUND',
          `Multicam audio source for ${window.trackId} was not found at the materialized path`,
        )
      }
      const durationMs = window.sourceEndMs - window.sourceStartMs
      const heardNothing = Object.freeze({
        trackId: window.trackId,
        partId: window.partId,
        sourceArtifactId: window.sourceArtifactId,
        sourceStartMs: window.sourceStartMs,
        sourceEndMs: window.sourceEndMs,
        measuredBlockCount: 0,
        blockMs: MULTICAM_SILENCE_DEFAULTS.blockMs,
        thresholdDbfs: this.thresholdDbfs,
        minimumSilenceMs: this.minimumSilenceMs,
        stretches: Object.freeze([]),
        method: MULTICAM_SILENCE_EVIDENCE_METHOD,
        evidenceRef: `media-artifact:${window.sourceArtifactId}:${window.sourceStartMs}-${window.sourceEndMs}:audio`,
      })
      let output: string
      try {
        const result = await execFileAsync(
          this.ffmpegPath,
          [
            '-hide_banner', '-nostdin', '-nostats', '-loglevel', 'info',
            '-ss', (window.sourceStartMs / 1_000).toFixed(3),
            '-t', (durationMs / 1_000).toFixed(3),
            '-i', window.path,
            '-map', '0:a:0',
            '-vn',
            // The rate is forced INSIDE the chain, not by `-ar` on the output.
            // Output options resample after the filters, so `asetnsamples` would
            // count samples at whatever rate the file happened to carry and a
            // block would stop being 100 ms: measured against a 48 kHz source it
            // was 33 ms, and every block boundary landed somewhere else than the
            // arithmetic below assumes.
            '-af', [
              'asetpts=PTS-STARTPTS',
              `aresample=${MULTICAM_SILENCE_DEFAULTS.sampleRate}`,
              'aformat=channel_layouts=mono',
              `silencedetect=noise=${this.thresholdDbfs}dB:d=${(this.minimumSilenceMs / 1_000).toFixed(3)}`,
              `asetnsamples=n=${samplesPerBlock}:p=0`,
              'astats=metadata=1:reset=1',
              'ametadata=mode=print:key=lavfi.astats.Overall.RMS_level',
            ].join(','),
            '-f', 'null', '-',
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
      } catch (error) {
        if (input.signal?.aborted) {
          throw new DomainError('VERSION_CONFLICT', 'Multicam silence measurement was cancelled')
        }
        // No audio stream is a fact about the recording; a broken decode is a
        // fact about the run. Collapsing them would turn a failing codec into
        // "this camera was silent the whole time".
        const stderr = String((error as { stderr?: unknown }).stderr ?? '')
        if (NO_AUDIO_STREAM.test(stderr)) {
          measurements.push(heardNothing)
          continue
        }
        throw new DomainError(
          'RENDER_EXECUTION_FAILED',
          `FFmpeg multicam silence measurement failed for ${window.trackId}: ${stderr.split('\n').slice(-3).join(' ').trim() || String(error)}`,
        )
      }
      const blocks = readLevelBlocks(output)
      if (blocks.length === 0) {
        measurements.push(heardNothing)
        continue
      }
      const stretches: Readonly<MulticamSilentStretch>[] = []
      for (const range of readSilentRanges(output, durationMs)) {
        // Wholly inside, not merely starting inside. The block that straddles
        // the end of a stretch contains the sound that ENDED it: counted, it
        // reported a room-tone pause at −9 dBFS because speech resumed 20 ms
        // into that block. Measured, not reasoned about — see the numbers in
        // `multicam-silence-evidence.integration.mjs`.
        const inside = blocks
          .filter((block) => block.atMs >= range.startMs
            && block.atMs + MULTICAM_SILENCE_DEFAULTS.blockMs <= range.endMs)
          .map((block) => block.levelDbfs)
        // A stretch that holds no whole block gets no reading of its own; the
        // threshold it was detected under is then the tightest bound anybody
        // measured, and it is a bound the samples really respected.
        const ceiling = inside.length === 0 ? this.thresholdDbfs : Math.max(...inside)
        stretches.push(Object.freeze({
          startMs: window.sourceStartMs + range.startMs,
          endMs: window.sourceStartMs + range.endMs,
          ceilingDbfs: Math.min(0, Number(ceiling.toFixed(2))),
        }))
      }
      measurements.push(Object.freeze({
        ...heardNothing,
        measuredBlockCount: blocks.length,
        stretches: Object.freeze(stretches),
      }))
    }
    return Object.freeze(measurements)
  }
}
