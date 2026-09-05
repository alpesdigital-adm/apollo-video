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

/**
 * Normalised correlation of one needle against one offset of the haystack.
 *
 * Kept as the definition the transform below has to agree with: it is what the
 * unit suite compares `createCorrelationPlan` against, and a direct loop is the
 * only version of this whose correctness is obvious by reading it.
 */
export function scoreAt(
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

function nextPowerOfTwo(value: number): number {
  let size = 1
  while (size < value) size *= 2
  return size
}

/**
 * A radix-2 transform whose twiddle factors are computed by direct
 * trigonometry rather than by the usual recurrence.
 *
 * The recurrence drifts across a transform of a million points, and being exact
 * at every lag is the entire reason this exists. The table costs one pass of
 * `cos`/`sin` per plan and is reused by all three transforms of every window.
 */
interface FourierPlan {
  readonly size: number
  readonly cos: Float64Array
  readonly sin: Float64Array
}

function createFourierPlan(size: number): FourierPlan {
  const cos = new Float64Array(size / 2)
  const sin = new Float64Array(size / 2)
  for (let index = 0; index < size / 2; index += 1) {
    const angle = (-2 * Math.PI * index) / size
    cos[index] = Math.cos(angle)
    sin[index] = Math.sin(angle)
  }
  return { size, cos, sin }
}

function transform(plan: FourierPlan, re: Float64Array, im: Float64Array, inverse: boolean): void {
  const n = plan.size
  for (let index = 1, target = 0; index < n; index += 1) {
    let bit = n >> 1
    for (; target & bit; bit >>= 1) target ^= bit
    target ^= bit
    if (index < target) {
      const swapRe = re[index]!
      re[index] = re[target]!
      re[target] = swapRe
      const swapIm = im[index]!
      im[index] = im[target]!
      im[target] = swapIm
    }
  }
  for (let length = 2; length <= n; length <<= 1) {
    const half = length >> 1
    const step = n / length
    for (let start = 0; start < n; start += length) {
      for (let k = 0; k < half; k += 1) {
        const twiddle = k * step
        const wRe = plan.cos[twiddle]!
        const wIm = inverse ? -plan.sin[twiddle]! : plan.sin[twiddle]!
        const evenRe = re[start + k]!
        const evenIm = im[start + k]!
        const oddRe = re[start + k + half]!
        const oddIm = im[start + k + half]!
        const productRe = oddRe * wRe - oddIm * wIm
        const productIm = oddRe * wIm + oddIm * wRe
        re[start + k] = evenRe + productRe
        im[start + k] = evenIm + productIm
        re[start + k + half] = evenRe - productRe
        im[start + k + half] = evenIm - productIm
      }
    }
  }
  if (inverse) {
    for (let index = 0; index < n; index += 1) {
      re[index] = re[index]! / n
      im[index] = im[index]! / n
    }
  }
}

/**
 * Every offset scored, not a grid of them.
 *
 * What this replaces sampled the offsets on a coarse stride of an eighth of the
 * needle and refined only around the winner. That is sound when the correlation
 * peak is wider than the stride, and the normalised correlation of audio
 * against itself has a main lobe about *one sample* wide — so the coarse pass
 * could only find the peak when the true lag happened to be a multiple of the
 * stride. Both F4.015 fixtures were built from integer-second offsets, which are
 * exactly such multiples, so the search looked correct while it would have
 * missed almost every real lag: measured here, an off-grid lag of 1.52 s over a
 * 40 s reference came back as 7.785 s with a peak ratio of 14 behind it.
 *
 * The transform scores every offset exactly and costs less than the grid did:
 * the reference is transformed once per call, and each window is two transforms
 * instead of one multiply-accumulate per needle sample per grid point.
 */
export interface CorrelationPlan {
  /** The highest offset the needle still fits at. */
  readonly available: number
  /**
   * Scores for every offset in `[0, available]`. The array is reused between
   * calls: read it, or copy it, before correlating the next window.
   */
  correlate(needle: Float64Array, needleEnergy: number): Float64Array
}

export function createCorrelationPlan(
  haystack: Float64Array,
  needleLength: number,
): CorrelationPlan {
  const available = haystack.length - needleLength
  const size = nextPowerOfTwo(haystack.length + needleLength)
  const plan = createFourierPlan(size)
  const haystackRe = new Float64Array(size)
  const haystackIm = new Float64Array(size)
  haystackRe.set(haystack)
  transform(plan, haystackRe, haystackIm, false)

  // Sliding energy of the haystack, so the normalisation is exactly the one
  // `scoreAt` computes rather than an approximation of it.
  const energyPrefix = new Float64Array(haystack.length + 1)
  for (let index = 0; index < haystack.length; index += 1) {
    energyPrefix[index + 1] = energyPrefix[index]! + haystack[index]! * haystack[index]!
  }

  const workRe = new Float64Array(size)
  const workIm = new Float64Array(size)
  const scores = new Float64Array(Math.max(0, available + 1))

  return {
    available,
    correlate(needle: Float64Array, needleEnergy: number): Float64Array {
      workRe.fill(0)
      workIm.fill(0)
      // Reversed, because the convolution a transform gives is the
      // cross-correlation once one of the two sequences is reversed.
      for (let index = 0; index < needle.length; index += 1) {
        workRe[needle.length - 1 - index] = needle[index]!
      }
      transform(plan, workRe, workIm, false)
      for (let index = 0; index < size; index += 1) {
        const re = haystackRe[index]! * workRe[index]! - haystackIm[index]! * workIm[index]!
        const im = haystackRe[index]! * workIm[index]! + haystackIm[index]! * workRe[index]!
        workRe[index] = re
        workIm[index] = im
      }
      transform(plan, workRe, workIm, true)
      for (let offset = 0; offset <= available; offset += 1) {
        const energy = energyPrefix[offset + needle.length]! - energyPrefix[offset]!
        const denominator = Math.sqrt(energy > 0 ? energy : 0) * needleEnergy
        scores[offset] = denominator === 0
          ? 0
          : workRe[offset + needle.length - 1]! / denominator
      }
      return scores
    },
  }
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

/**
 * The most an absence can be believed, and why it is not 1.
 *
 * A window with no correlation proves the recording does not contain the
 * reference's audio there. It does not prove the player was stopped: a reference
 * can play a silent passage, and a reactor can mute it. Nothing this detector
 * measures earns certainty about a negative.
 */
export const MAXIMUM_ABSENCE_CONFIDENCE = 0.95

/**
 * How confidently a refused window says the reference was not playing.
 *
 * The number a rejected window carries has to measure the rejection, not the
 * sharpness of the correlation that was rejected. Two cases separate:
 *
 * - The peak never reached the correlation floor. Then the shortfall *is* the
 *   measurement: nothing in the window is explained by the reference, and the
 *   further below the floor it landed, the better established the absence. On
 *   the F4.015 fixture the reactor's own noise peaks at 0.055–0.485 against a
 *   floor of 0.5, which reads here as 0.05–0.85 — high where the window is
 *   plainly not the reference, low where it half is.
 * - The peak cleared the floor and only the runner-up test refused it. That is
 *   ambiguity, not absence: the reference is plausibly there and the correlator
 *   could not say where. Such a window is no evidence of a gap at all, so it
 *   contributes nothing (0) and the domain's `min` across the run keeps it.
 */
export function absenceConfidence(peak: number, minimumPeak: number): number {
  if (!Number.isFinite(peak) || peak <= 0) return MAXIMUM_ABSENCE_CONFIDENCE
  if (!Number.isFinite(minimumPeak) || minimumPeak <= 0) return 0
  if (peak >= minimumPeak) return 0
  return Math.min(MAXIMUM_ABSENCE_CONFIDENCE, 1 - peak / minimumPeak)
}

/**
 * How the lag is looked for.
 *
 * `grid` is the original search: the offsets are sampled on a stride of an
 * eighth of the needle and only the winner is refined. `exhaustive` scores every
 * offset with a transform. They are not two speeds of the same answer — see
 * `SEARCH_MODES` below — and the default is `grid` only because F4.015's
 * published measurements were taken with it.
 */
export const SEARCH_MODES = Object.freeze(['grid', 'exhaustive'] as const)
export type SearchMode = (typeof SEARCH_MODES)[number]

export interface CorrelateAudioWindowsInput {
  readonly reference: Samples
  readonly candidate: Samples
  readonly sampleRate: number
  readonly windowMs?: number
  readonly hopMs?: number
  readonly energyFloor?: number
  readonly correlationRate?: number
  /**
   * Defaults to `grid`, which is what F4.015 measured and published.
   *
   * **The grid search can only find a lag that is a multiple of its stride.**
   * The stride is an eighth of the needle, and the normalised correlation of
   * audio against itself has a main lobe about one sample wide, so an off-grid
   * peak is not merely located imprecisely — it is not seen at all, and the
   * winner is then whichever unrelated offset happened to sit on the grid.
   * Measured on the F4.012 fixture: a true lag of 1.52 s over a 40 s reference
   * came back as 7.785 s, with a peak ratio of 14 standing behind it.
   *
   * Both F4.015 fixtures are built from integer-second offsets, which are
   * exactly such multiples, which is why the grid search looks correct there and
   * has never been exercised off-grid. Anything measuring a lag that was not
   * chosen in advance — which is every real recording — must ask for
   * `exhaustive`.
   *
   * Flipping the default is not this slice's call to make: an exhaustive search
   * finds stronger runner-ups, which correctly pushes windows that straddle a
   * boundary below the admission ratio, which shortens each locked run by half a
   * window, which makes `playback-map.ts` read one replay in the F4.015 fixture
   * as a rewind (its "already played" test asks whether one earlier interval
   * contains the range, and the range now spans two of them across a
   * half-window hole). That chain is worth following, and it belongs to whoever
   * owns F4.015 rather than to a caller passing an option.
   */
  readonly search?: SearchMode
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
  // `NaN <= 0` is false, so a bare `<= 0` let a non-finite window through, and
  // `Math.round(NaN)` windows produced an empty result — which the domain reads
  // as "the reference was never playing", not as "bad input".
  if (!Number.isFinite(hopMs) || !Number.isFinite(windowMs) || hopMs <= 0 || windowMs <= 0) {
    throw new TypeError('correlateAudioWindows needs a positive window and hop')
  }

  const reference = toFloat(input.reference)
  const candidate = toFloat(input.candidate)
  const factor = Math.max(1, Math.floor(sampleRate / Math.min(sampleRate, correlationRate)))
  const smallReference = decimate(reference, factor)
  const smallCandidate = decimate(candidate, factor)

  const windowSamples = Math.max(1, Math.round((windowMs / 1_000) * sampleRate))
  const hopSamples = Math.max(1, Math.round((hopMs / 1_000) * sampleRate))
  const smallWindow = Math.max(1, Math.floor(windowSamples / factor))
  const stride = Math.max(1, Math.floor(smallWindow / 8))
  const search = input.search ?? 'grid'
  // One plan for the whole call: the reference is transformed once and every
  // window reuses it, which is what makes scoring every offset cheaper than
  // scoring a grid of them.
  const plan = search === 'exhaustive' && smallReference.length >= smallWindow
    ? createCorrelationPlan(smallReference, smallWindow)
    : null

  const results: Readonly<AudioWindowCorrelation>[] = []
  // Whole windows only. A partial window at the tail would be measured against a
  // shorter needle and produce a peak that is not comparable with the others,
  // and downstream it would open a piece of its own out of an artefact.
  for (let start = 0; start + windowSamples <= candidate.length; start += hopSamples) {
    const rms = windowEnergy(candidate, start, windowSamples) / Math.sqrt(windowSamples)
    const smallStart = Math.floor(start / factor)
    const available = smallReference.length - smallWindow
    // Non-finite PCM is treated as silence rather than slipping past both energy
    // gates: `NaN < energyFloor` is false, every score was then NaN, the sort was
    // a no-op and `lagSamples` came back 0 — naming the first sample of the
    // reference as the answer, which this type's own contract forbids.
    if (
      !Number.isFinite(rms) || rms < energyFloor || available < 0 ||
      smallStart + smallWindow > smallCandidate.length
    ) {
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
    if (!Number.isFinite(needleEnergy) || needleEnergy === 0) {
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

    // Outside a guard band of one window: nearer offsets are the same match seen
    // from one sample over, and counting them as rivals would make every clean
    // lock look like a coin toss.
    const guard = smallWindow
    let bestOffset = 0
    let bestScore = Number.NEGATIVE_INFINITY
    let secondPeak = 0
    if (plan) {
      const scores = plan.correlate(needle, needleEnergy)
      for (let offset = 0; offset <= available; offset += 1) {
        if (scores[offset]! > bestScore) {
          bestScore = scores[offset]!
          bestOffset = offset
        }
      }
      // The runner-up here is the best of *every* remaining offset rather than
      // the best of a grid, which can only lower a reported ratio: a rival
      // sitting between two grid points is invisible to the grid, and an
      // invisible rival makes an ambiguous window look decisive.
      for (let offset = 0; offset <= available; offset += 1) {
        if (Math.abs(offset - bestOffset) > guard && scores[offset]! > secondPeak) {
          secondPeak = scores[offset]!
        }
      }
    } else {
      // Coarse pass, then a fine pass around the winner. Identical in shape to
      // `correlate` (ffmpeg-marker-detectors.ts:353-379), and subject to the
      // stride limitation documented on `CorrelateAudioWindowsInput.search`.
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
      const rival = coarse.find((entry) => Math.abs(entry.offset - best.offset) > guard)
      bestOffset = best.offset
      bestScore = best.score
      secondPeak = Math.max(0, rival?.score ?? 0)
    }
    const peak = Math.max(0, bestScore)
    const peakRatio = secondPeak > 0
      ? Math.min(MAXIMUM_REPORTABLE_PEAK_RATIO, peak / secondPeak)
      : peak > 0 ? MAXIMUM_REPORTABLE_PEAK_RATIO : 0
    results.push(Object.freeze({
      startSample: start,
      lagSamples: bestOffset * factor,
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

export interface ObservationsFromCorrelationsInput {
  readonly correlations: readonly Readonly<AudioWindowCorrelation>[]
  readonly sampleRate: number
  readonly reactionTimebase: Readonly<Timebase>
  readonly referenceTimebase: Readonly<Timebase>
  readonly minimumPeak?: number
}

/**
 * Turn correlations into observations. Pure, and separately testable on purpose.
 *
 * This is the whole judgement the detector makes, and while it lived inside the
 * FFmpeg method it could only be reached by decoding two real files — which is
 * how it shipped emitting a rejected correlation's peak-over-runner-up ratio as
 * the confidence of a window it had refused. The admission rule and the honesty
 * rule now sit in one function that synthetic correlations can exercise.
 *
 * The detector still decides no mode. It says where the window matched, or that
 * it did not, and how much either answer is worth.
 */
export function observationsFromCorrelations(
  input: ObservationsFromCorrelationsInput,
): readonly Readonly<PlaybackObservation>[] {
  const sampleTimebase = timebaseFromRate(input.sampleRate)
  const admission = DEFAULT_SYNC_EVIDENCE_THRESHOLDS.minimumPeakRatioForAdmission
  const minimumPeak = input.minimumPeak ?? PLAYBACK_FINGERPRINT_DEFAULTS.minimumPeak
  return Object.freeze(input.correlations.map((correlation) => {
    const reactionTick = convertTick({
      tick: BigInt(correlation.startSample),
      from: sampleTimebase,
      to: input.reactionTimebase,
    })
    // Below the energy floor, below the correlation floor, or below the
    // admission ratio, the window gets no reference tick at all. Reporting the
    // best guess with a low confidence would put a number where there is no
    // measurement, and the domain would have to reconstruct the absence from the
    // confidence.
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
      // A window the detector refused reports confidence in its ABSENCE, not the
      // peak-over-runner-up ratio of a match that was rejected. Emitting
      // `correlation.confidence` unconditionally sent numbers up to 0.86 on
      // windows whose peak never reached a seventh of the floor, and the domain
      // stamped them onto `paused` pieces as the confidence of the pause. See
      // `absenceConfidence`.
      confidence: locked
        ? correlation.confidence
        : absenceConfidence(correlation.peak, minimumPeak),
      method: 'audio-fingerprint' as const,
      evidenceRef: `fingerprint:${reactionTick}`,
      peakRatio: correlation.peakRatio,
    })
  }))
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

      return observationsFromCorrelations({
        correlations,
        sampleRate,
        reactionTimebase: input.reactionTimebase,
        referenceTimebase: input.referenceTimebase,
        minimumPeak: input.minimumPeak,
      })
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
