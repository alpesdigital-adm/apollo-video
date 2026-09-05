import { execFile } from 'node:child_process'
import { mkdir, mkdtemp, readFile, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { promisify } from 'node:util'

import ffmpegStatic from 'ffmpeg-static'

import type { PlaybackObservation } from '../../domain/playback-map.ts'
import {
  convertTick,
  timebaseFromRate,
  type Timebase,
} from '../../domain/session-time.ts'
import {
  DEFAULT_SYNC_EVIDENCE_THRESHOLDS,
  MAXIMUM_REPORTABLE_PEAK_RATIO,
} from '../../domain/sync-evidence.ts'

const execFileAsync = promisify(execFile)

/**
 * F4.015 — finding the reference inside a react recording, by its audio.
 *
 * Two layers, deliberately separated (MAP §3.4, orchestrator addendum): the
 * correlator is a pure function over PCM with no FFmpeg in sight, and the
 * detector is the thing that gets PCM out of two media files and calls it. The
 * correlator is what the phase-3 `SyncSignalSource` adapter will reuse —
 * `runCaptureSyncWorker` has no signal producer in runtime today, and this is
 * the first one — so it must be testable with synthetic arrays and nothing else.
 *
 * **The detector does not decide anything.** It reports, per window, where in
 * the reference that window best matched, how sharp the match was, and how it
 * compares to its runner-up. Whether a run of unmatched windows was a pause, a
 * commentary or a hidden player is a domain question, answered in
 * `domain/playback-map.ts` from the shape of the whole sequence. A detector that
 * returned modes would be making an editorial judgement out of one second of
 * audio.
 *
 * The correlation itself is the algorithm of `correlate` in
 * `ffmpeg-marker-detectors.ts:334-392` (normalised cross-correlation, coarse
 * stride then fine refinement, runner-up taken from outside a guard band of one
 * needle length), copied rather than imported because that function is private
 * to the marker path and the two must be free to diverge. What is added here:
 * the needle is a *window of the reaction* rather than a known waveform, so the
 * search runs once per window, and the signals are decimated first — a full
 * search at 16 kHz over minutes of audio is billions of multiplies for a lag
 * resolution three orders of magnitude finer than the window hop that bounds a
 * piece boundary anyway.
 */

export const PLAYBACK_FINGERPRINT_DEFAULTS = Object.freeze({
  sampleRate: 16_000,
  windowMs: 1_000,
  hopMs: 500,
  /**
   * Amplitude below which a window is silence rather than quiet content.
   * -40 dBFS: a hidden player behind room tone falls under it, a person talking
   * does not.
   */
  energyFloor: 0.01,
  /**
   * Normalised correlation below which a window is not the reference, whatever
   * its runner-up looked like.
   *
   * The peak-over-runner-up test cannot see this on its own: a window of pure
   * room noise still has a best offset and a second-best one, and their ratio is
   * routinely well above the admission floor. Measured on the F4.015 fixture
   * (N=119 windows, one run): windows over reference audio peak between 0.699
   * and 1.000, while windows over the reactor's own noise peak between 0.055 and
   * 0.485 — with ratios up to 8.5. Only the two windows that *straddle* a
   * boundary land in between (0.637, 0.674), and those are half reference by
   * construction. Half the window's energy explained by the reference is the
   * line this draws.
   */
  minimumPeak: 0.5,
  /**
   * The rate the search actually runs at. 2 kHz gives a lag resolution of half a
   * millisecond, which is sixty times finer than a frame at 30 fps and a
   * thousand times finer than the hop.
   */
  correlationRate: 2_000,
})

export interface AudioWindowCorrelation {
  /** First sample of this window, in the candidate's own samples. */
  readonly startSample: number
  /**
   * Where the window matched in the reference, in reference samples. Null when
   * the window had no energy to match with — not zero, which would name the
   * first sample of the reference as the answer.
   */
  readonly lagSamples: number | null
  /** Normalised correlation at the winning lag, in [0, 1]. */
  readonly peak: number
  /** Best correlation outside a guard band of one window around the winner. */
  readonly secondPeak: number
  /** Peak over runner-up, capped at the reportable maximum. */
  readonly peakRatio: number
  /** Derived from `peakRatio` alone, and never 1 — see `confidenceFromPeakRatio`. */
  readonly confidence: number
  /** Root-mean-square amplitude of the window, so a caller can see the gate. */
  readonly rms: number
}

type Samples = Int16Array | Float32Array | Float64Array

function toFloat(samples: Samples): Float64Array {
  if (samples instanceof Float64Array) return samples
  const out = new Float64Array(samples.length)
  const scale = samples instanceof Int16Array ? 1 / 32_768 : 1
  for (let index = 0; index < samples.length; index += 1) out[index] = samples[index]! * scale
  return out
}

/**
 * Box-average decimation.
 *
 * A box of `factor` samples is a crude low-pass whose first null sits exactly at
 * the new Nyquist frequency, which is enough anti-aliasing for a correlator that
 * only needs to know *where*, not *what*. Anything sharper would cost more than
 * the precision it buys.
 */
function decimate(samples: Float64Array, factor: number): Float64Array {
  if (factor <= 1) return samples
  const length = Math.floor(samples.length / factor)
  const out = new Float64Array(length)
  for (let index = 0; index < length; index += 1) {
    let sum = 0
    const base = index * factor
    for (let step = 0; step < factor; step += 1) sum += samples[base + step]!
    out[index] = sum / factor
  }
  return out
}

function windowEnergy(samples: Float64Array, offset: number, length: number): number {
  let energy = 0
  for (let index = 0; index < length; index += 1) {
    const value = samples[offset + index] ?? 0
    energy += value * value
  }
  return Math.sqrt(energy)
}

function scoreAt(
  haystack: Float64Array,
  needle: Float64Array,
  offset: number,
  needleEnergy: number,
): number {
  let dot = 0
  let energy = 0
  for (let index = 0; index < needle.length; index += 1) {
    const sample = haystack[offset + index]!
    dot += sample * needle[index]!
    energy += sample * sample
  }
  const denominator = Math.sqrt(energy) * needleEnergy
  return denominator === 0 ? 0 : dot / denominator
}

/**
 * How much a peak-over-runner-up ratio is worth as confidence.
 *
 * The two hinge points are the sync cascade's own thresholds — 1.2 to be
 * admitted at all, 1.5 to be trusted without review — imported rather than
 * retyped so a window cannot be admissible here and inadmissible there. Above
 * 1.5 the curve approaches 0.99 and never reaches it: a correlator that returns
 * certainty has stopped measuring and started asserting.
 */
export function confidenceFromPeakRatio(ratio: number): number {
  const admission = DEFAULT_SYNC_EVIDENCE_THRESHOLDS.minimumPeakRatioForAdmission
  const trusted = DEFAULT_SYNC_EVIDENCE_THRESHOLDS.minimumPeakRatioForAutoApply
  const floor = DEFAULT_SYNC_EVIDENCE_THRESHOLDS.minimumConfidenceForAdmission
  const ceiling = DEFAULT_SYNC_EVIDENCE_THRESHOLDS.minimumConfidenceForAutoApply
  if (!Number.isFinite(ratio) || ratio <= 1) return 0
  if (ratio < admission) return (floor * (ratio - 1)) / (admission - 1)
  if (ratio < trusted) return floor + ((ceiling - floor) * (ratio - admission)) / (trusted - admission)
  return Math.min(0.99, ceiling + (0.99 - ceiling) * (1 - trusted / ratio))
}

export interface CorrelateAudioWindowsInput {
  readonly reference: Samples
  readonly candidate: Samples
  readonly sampleRate: number
  readonly windowMs?: number
  readonly hopMs?: number
  readonly energyFloor?: number
  readonly correlationRate?: number
}

/**
 * Slide every window of the candidate against the whole reference.
 *
 * Pure: arrays in, measurements out, no filesystem and no FFmpeg. The result has
 * one entry per window, in order, including the windows that matched nothing —
 * a missing entry would leave a caller unable to tell "no reference here" from
 * "nobody looked here".
 */
export function correlateAudioWindows(
  input: CorrelateAudioWindowsInput,
): readonly Readonly<AudioWindowCorrelation>[] {
  const sampleRate = input.sampleRate
  if (!Number.isFinite(sampleRate) || sampleRate <= 0) {
    throw new TypeError('correlateAudioWindows needs a positive sample rate')
  }
  const windowMs = input.windowMs ?? PLAYBACK_FINGERPRINT_DEFAULTS.windowMs
  const hopMs = input.hopMs ?? PLAYBACK_FINGERPRINT_DEFAULTS.hopMs
  const energyFloor = input.energyFloor ?? PLAYBACK_FINGERPRINT_DEFAULTS.energyFloor
  const correlationRate = input.correlationRate ?? PLAYBACK_FINGERPRINT_DEFAULTS.correlationRate
  if (hopMs <= 0 || windowMs <= 0) throw new TypeError('correlateAudioWindows needs a positive window and hop')

  const reference = toFloat(input.reference)
  const candidate = toFloat(input.candidate)
  const factor = Math.max(1, Math.floor(sampleRate / Math.min(sampleRate, correlationRate)))
  const smallReference = decimate(reference, factor)
  const smallCandidate = decimate(candidate, factor)

  const windowSamples = Math.max(1, Math.round((windowMs / 1_000) * sampleRate))
  const hopSamples = Math.max(1, Math.round((hopMs / 1_000) * sampleRate))
  const smallWindow = Math.max(1, Math.floor(windowSamples / factor))
  const stride = Math.max(1, Math.floor(smallWindow / 8))

  const results: Readonly<AudioWindowCorrelation>[] = []
  // Whole windows only. A partial window at the tail would be measured against a
  // shorter needle and produce a peak that is not comparable with the others,
  // and downstream it would open a piece of its own out of an artefact.
  for (let start = 0; start + windowSamples <= candidate.length; start += hopSamples) {
    const rms = windowEnergy(candidate, start, windowSamples) / Math.sqrt(windowSamples)
    const smallStart = Math.floor(start / factor)
    const available = smallReference.length - smallWindow
    if (rms < energyFloor || available < 0 || smallStart + smallWindow > smallCandidate.length) {
      results.push(Object.freeze({
        startSample: start,
        lagSamples: null,
        peak: 0,
        secondPeak: 0,
        peakRatio: 0,
        confidence: 0,
        rms,
      }))
      continue
    }

    const needle = smallCandidate.subarray(smallStart, smallStart + smallWindow)
    let needleEnergy = 0
    for (const value of needle) needleEnergy += value * value
    needleEnergy = Math.sqrt(needleEnergy)
    if (needleEnergy === 0) {
      results.push(Object.freeze({
        startSample: start,
        lagSamples: null,
        peak: 0,
        secondPeak: 0,
        peakRatio: 0,
        confidence: 0,
        rms,
      }))
      continue
    }

    // Coarse pass, then a fine pass around the winner. Identical in shape to
    // `correlate` (ffmpeg-marker-detectors.ts:353-379).
    const coarse: { offset: number; score: number }[] = []
    for (let offset = 0; offset <= available; offset += stride) {
      coarse.push({ offset, score: scoreAt(smallReference, needle, offset, needleEnergy) })
    }
    coarse.sort((left, right) => right.score - left.score)
    let best = coarse[0]!
    const from = Math.max(0, best.offset - stride)
    const to = Math.min(available, best.offset + stride)
    for (let offset = from; offset <= to; offset += 1) {
      const value = scoreAt(smallReference, needle, offset, needleEnergy)
      if (value > best.score) best = { offset, score: value }
    }
    // Outside a guard band of one window: nearer offsets are the same match seen
    // from one sample over, and counting them as rivals would make every clean
    // lock look like a coin toss.
    const guard = smallWindow
    const rival = coarse.find((entry) => Math.abs(entry.offset - best.offset) > guard)
    const peak = Math.max(0, best.score)
    const secondPeak = Math.max(0, rival?.score ?? 0)
    const peakRatio = secondPeak > 0
      ? Math.min(MAXIMUM_REPORTABLE_PEAK_RATIO, peak / secondPeak)
      : peak > 0 ? MAXIMUM_REPORTABLE_PEAK_RATIO : 0
    results.push(Object.freeze({
      startSample: start,
      lagSamples: best.offset * factor,
      peak,
      secondPeak,
      peakRatio,
      confidence: confidenceFromPeakRatio(peakRatio),
      rms,
    }))
  }
  return Object.freeze(results)
}

export interface DetectPlaybackObservationsInput {
  readonly referencePath: string
  readonly reactionPath: string
  /** Ticks the reaction (session) timeline is counted in. */
  readonly reactionTimebase: Readonly<Timebase>
  /** Ticks the reference recording is counted in. */
  readonly referenceTimebase: Readonly<Timebase>
  readonly sampleRate?: number
  readonly windowMs?: number
  readonly hopMs?: number
  readonly energyFloor?: number
  readonly minimumPeak?: number
  readonly correlationRate?: number
}

/**
 * The FFmpeg layer: two files in, one observation per window out.
 *
 * Every process it starts is named, bounded by a timeout, and cleaned up in a
 * `finally` that reports its own failure instead of throwing over the real
 * result.
 */
export class FfmpegPlaybackFingerprinter {
  private readonly ffmpegPath: string
  private readonly workRoot: string | null

  constructor(options: { ffmpegPath?: string; workRoot?: string } = {}) {
    this.ffmpegPath = options.ffmpegPath?.trim() || ffmpegStatic || 'ffmpeg'
    this.workRoot = options.workRoot ?? null
  }

  async detectPlaybackObservations(
    input: DetectPlaybackObservationsInput,
  ): Promise<readonly Readonly<PlaybackObservation>[]> {
    const sampleRate = input.sampleRate ?? PLAYBACK_FINGERPRINT_DEFAULTS.sampleRate
    const windowMs = input.windowMs ?? PLAYBACK_FINGERPRINT_DEFAULTS.windowMs
    const hopMs = input.hopMs ?? PLAYBACK_FINGERPRINT_DEFAULTS.hopMs

    let scratch: string
    let owned = false
    if (this.workRoot) {
      scratch = join(this.workRoot, `playback-fingerprint-${process.pid}-${Date.now()}`)
      await mkdir(scratch, { recursive: true })
      owned = true
    } else {
      scratch = await mkdtemp(join(tmpdir(), 'apollo-playback-fingerprint-'))
      owned = true
    }

    try {
      const reference = await this.extractPcm(input.referencePath, join(scratch, 'reference.pcm'), sampleRate)
      const reaction = await this.extractPcm(input.reactionPath, join(scratch, 'reaction.pcm'), sampleRate)
      const correlations = correlateAudioWindows({
        reference,
        candidate: reaction,
        sampleRate,
        windowMs,
        hopMs,
        energyFloor: input.energyFloor,
        correlationRate: input.correlationRate,
      })

      const sampleTimebase = timebaseFromRate(sampleRate)
      const admission = DEFAULT_SYNC_EVIDENCE_THRESHOLDS.minimumPeakRatioForAdmission
      const minimumPeak = input.minimumPeak ?? PLAYBACK_FINGERPRINT_DEFAULTS.minimumPeak
      return Object.freeze(correlations.map((correlation) => {
        const reactionTick = convertTick({
          tick: BigInt(correlation.startSample),
          from: sampleTimebase,
          to: input.reactionTimebase,
        })
        // Below the energy floor, below the correlation floor, or below the
        // admission ratio, the window gets no reference tick at all. Reporting
        // the best guess with a low confidence would put a number where there is
        // no measurement, and the domain would have to reconstruct the absence
        // from the confidence.
        const locked = correlation.lagSamples !== null &&
          correlation.peak >= minimumPeak &&
          correlation.peakRatio >= admission
        return Object.freeze({
          reactionTick,
          referenceTick: locked
            ? convertTick({
              tick: BigInt(correlation.lagSamples!),
              from: sampleTimebase,
              to: input.referenceTimebase,
            })
            : null,
          confidence: correlation.confidence,
          method: 'audio-fingerprint' as const,
          evidenceRef: `fingerprint:${reactionTick}`,
          peakRatio: correlation.peakRatio,
        })
      }))
    } finally {
      if (owned) {
        await rm(scratch, { recursive: true, force: true }).catch((error: unknown) => {
          // Reported, never rethrown: a cleanup failure must not replace the
          // measurement the caller asked for.
          process.emitWarning(
            `playback fingerprint scratch ${scratch} could not be removed: ${String(error)}`,
          )
        })
      }
    }
  }

  private async extractPcm(mediaPath: string, pcmPath: string, sampleRate: number): Promise<Int16Array> {
    await execFileAsync(this.ffmpegPath, [
      '-hide_banner', '-nostdin', '-y',
      '-i', mediaPath,
      '-vn', '-ac', '1', '-ar', String(sampleRate),
      '-f', 's16le', pcmPath,
    ], { maxBuffer: 128 * 1024 * 1024, timeout: 300_000 })
    const bytes = await readFile(pcmPath)
    const samples = new Int16Array(Math.floor(bytes.length / 2))
    for (let index = 0; index < samples.length; index += 1) samples[index] = bytes.readInt16LE(index * 2)
    return samples
  }
}
