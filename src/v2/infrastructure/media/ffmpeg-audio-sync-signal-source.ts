import { execFile } from 'node:child_process'
import { mkdtemp, readFile, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { promisify } from 'node:util'

import ffmpegStatic from 'ffmpeg-static'

import type { CaptureSession, CaptureTrack, CaptureTrackPart } from '../../domain/capture-session.ts'
import { DomainError } from '../../domain/errors.ts'
import {
  convertTick,
  createTickInterval,
  timebaseFromRate,
  type Rational,
  type TickInterval,
  type Timebase,
} from '../../domain/session-time.ts'
import type { DiagnosticAnchor, SyncDiagnostic } from '../../domain/sync-diagnostic.ts'
import type { MarkerDetection } from '../../domain/sync-marker-detection.ts'
import {
  DEFAULT_SYNC_EVIDENCE_THRESHOLDS,
  type SyncAnchorObservation,
  type SyncSignalObservation,
} from '../../domain/sync-evidence.ts'
import {
  confidenceFromPeakRatio,
  correlateAudioWindows,
  type AudioWindowCorrelation,
} from './ffmpeg-playback-fingerprint.ts'

const execFileAsync = promisify(execFile)

/**
 * F4.004 at runtime — the first signal producer the sync cascade has ever had.
 *
 * `runCaptureSyncWorker` was written against a `SyncSignalSource` port that no
 * module implemented (map §14), so `POST .../sync-runs` enqueued a row nothing
 * could answer. This is the implementation: it opens the two recordings, finds
 * where one track's audio sits inside the other's, and reports what it measured.
 *
 * It decides nothing. Whether the measurement is good enough to move a timeline
 * is `evaluateSyncEvidence`'s question, and every number here exists so that
 * question can be answered honestly:
 *
 * **The correlator is not reimplemented.** `correlateAudioWindows` (F4.015,
 * `ffmpeg-playback-fingerprint.ts`) is imported. Two correlators drifting apart
 * would mean a window admissible in the react path and inadmissible here, with
 * no test able to see the disagreement.
 *
 * **Absence is never filled in.** A track with no audio produces no
 * observation, not an observation with a zero offset — the worker then reaches
 * `insufficient-evidence` through the path it already had. A camera nobody
 * pointed a microphone at is a fact about the session, and inventing an offset
 * for it would put a made-up number where the operator needs to see a gap.
 *
 * **Confidence is derived from separation and can never be 1.** It is the same
 * peak-over-runner-up curve the react detector uses, which approaches 0.99 and
 * never reaches it. A correlator that returns certainty has stopped measuring.
 */

/**
 * The measurement's shape, named because every number in it is a trade the
 * calibration will want to revisit against real material (spec 05 §26).
 */
export const AUDIO_SYNC_SIGNAL_DEFAULTS = Object.freeze({
  /**
   * Both files are decoded straight to the rate the correlation runs at, so the
   * resampler's anti-aliasing does the work a box filter would otherwise do
   * badly, and an hour of audio costs seven megabytes instead of a hundred and
   * fifteen. Half a millisecond of lag resolution is a fiftieth of a frame at
   * 25 fps — far finer than any threshold downstream compares against.
   */
  sampleRate: 2_000,
  /** A two-second needle. Long enough to be a fingerprint, short enough to be an instant. */
  windowMs: 2_000,
  /** The floor on the hop; long recordings get a larger one, see `MAXIMUM_CORRELATION_WINDOWS`. */
  minimumHopMs: 2_000,
  /**
   * The correlation is O(windows x reference length). Fixing the window count
   * rather than the hop keeps a three-hour session from costing three hundred
   * times a ten-minute one; thirty-two windows spread across the span is far
   * more than the cascade's anchor-distribution gate asks for, and the whole
   * search stays inside a few seconds of one core.
   */
  maximumCorrelationWindows: 32,
  /**
   * How much audio is examined per file at all. Beyond this the observation's
   * coverage says so — a signal that looked at the first thirty minutes of a
   * two-hour session reports a coverage ratio of a quarter, and the cascade's
   * own coverage floor decides what that is worth. Truncating silently and
   * claiming full coverage is the failure this bound is stated to avoid.
   */
  maximumAnalysisSeconds: 1_800,
  /**
   * Normalised correlation below which a window is not the reference at all.
   * Calibrated by F4.015 against real fixtures; imported rather than retyped
   * would be better still, but the react path's default is stated for a
   * one-second window and this one searches with two.
   */
  minimumPeak: 0.5,
  /**
   * How far two windows' implied offsets may differ and still be the same
   * alignment. Twenty milliseconds is half a frame at 25 fps: below what an
   * editor can see, above what resampling jitter produces.
   */
  agreementToleranceMs: 20,
  /**
   * Below this many agreeing windows there is no signal, only a coincidence.
   * Three is the smallest number that can show a trend rather than a pair.
   */
  minimumAgreeingWindows: 3,
  /** Anchors published per observation. The cascade caps at 4096; this is a working set. */
  maximumPublishedAnchors: 64,
  /**
   * How much of the session one anchor speaks for. An anchor is an instant, and
   * the coverage it supports has to be a range; a second around it is generous
   * without pretending the anchor measured a minute.
   */
  anchorSupportMs: 1_000,
  /** Seconds any one FFmpeg decode may take before it is killed. */
  decodeTimeoutMs: 300_000,
})

/** Milliseconds, the clock the diagnostic and the marker detections both use. */
const MILLISECOND_TIMEBASE = timebaseFromRate(1_000)

/** What this adapter needs from the Wave 19 media resolver, and nothing more. */
export interface CapturePartMediaResolver {
  resolve(input: {
    workspaceId: string
    part: Readonly<CaptureTrackPart>
  }): Promise<Readonly<{ path: string; release: () => Promise<void> }>>
}

/** The diagnostic's manual anchors, read from where an operator put them. */
export interface SyncDiagnosticReader {
  readHead(input: {
    workspaceId: string
    sessionId: string
  }): Promise<Readonly<SyncDiagnostic> | null>

  listDetections(input: {
    workspaceId: string
    sessionId: string
  }): Promise<readonly Readonly<MarkerDetection>[]>
}

export interface AudioSyncSignalSourceOptions {
  readonly media: CapturePartMediaResolver
  /** Optional: without it, manual anchors and markers simply do not appear. */
  readonly diagnostics?: SyncDiagnosticReader | null
  readonly ffmpegPath?: string
  readonly sampleRate?: number
  readonly windowMs?: number
  readonly minimumPeak?: number
  readonly maximumAnalysisSeconds?: number
}

function byOrdinal<T extends Readonly<{ ordinal: number }>>(entries: readonly T[]): readonly T[] {
  return [...entries].sort((left, right) => left.ordinal - right.ordinal)
}

function median(values: readonly number[]): number {
  const sorted = [...values].sort((left, right) => left - right)
  const middle = Math.floor(sorted.length / 2)
  return sorted.length % 2 === 1
    ? sorted[middle]!
    : (sorted[middle - 1]! + sorted[middle]!) / 2
}

function medianBigInt(values: readonly bigint[]): bigint {
  const sorted = [...values].sort((left, right) => (left < right ? -1 : left > right ? 1 : 0))
  return sorted[Math.floor((sorted.length - 1) / 2)]!
}

/**
 * Evenly spaced, always keeping the ends.
 *
 * The cascade scores how many thirds of the session the anchors occupy, so
 * dropping the tail of a long run would turn a well-distributed measurement
 * into a clustered one — the same evidence, reported worse.
 */
function spread<T>(entries: readonly T[], limit: number): readonly T[] {
  if (entries.length <= limit) return entries
  const step = (entries.length - 1) / (limit - 1)
  const picked: T[] = []
  for (let index = 0; index < limit; index += 1) {
    picked.push(entries[Math.round(index * step)]!)
  }
  return picked
}

interface DecodedAudio {
  readonly samples: Int16Array
  /** False when the file carries no audio stream at all — a fact, not a failure. */
  readonly hasAudio: boolean
}

/**
 * The one place a session's audio becomes numbers.
 *
 * Not a parameter-property constructor: `node` in strip-only mode refuses them
 * outside a compiler, and every infrastructure class in this tree is loaded
 * that way by the unit suites.
 */
export class FfmpegAudioSyncSignalSource {
  private readonly media: CapturePartMediaResolver
  private readonly diagnostics: SyncDiagnosticReader | null
  private readonly ffmpegPath: string
  private readonly sampleRate: number
  private readonly windowMs: number
  private readonly minimumPeak: number
  private readonly maximumAnalysisSeconds: number

  constructor(options: AudioSyncSignalSourceOptions) {
    this.media = options.media
    this.diagnostics = options.diagnostics ?? null
    this.ffmpegPath = options.ffmpegPath?.trim() || ffmpegStatic || 'ffmpeg'
    this.sampleRate = options.sampleRate ?? AUDIO_SYNC_SIGNAL_DEFAULTS.sampleRate
    this.windowMs = options.windowMs ?? AUDIO_SYNC_SIGNAL_DEFAULTS.windowMs
    this.minimumPeak = options.minimumPeak ?? AUDIO_SYNC_SIGNAL_DEFAULTS.minimumPeak
    this.maximumAnalysisSeconds =
      options.maximumAnalysisSeconds ?? AUDIO_SYNC_SIGNAL_DEFAULTS.maximumAnalysisSeconds
  }

  async observe(input: {
    session: Readonly<CaptureSession>
    track: Readonly<CaptureTrack>
    referenceTrack: Readonly<CaptureTrack>
    sessionTimebase: Readonly<Timebase>
    sessionFrameRate: Rational
    sessionBounds: Readonly<TickInterval>
  }): Promise<readonly Readonly<SyncSignalObservation>[]> {
    const observations: Readonly<SyncSignalObservation>[] = []
    observations.push(...await this.observeAudio(input))

    if (this.diagnostics) {
      const [diagnostic, detections] = await Promise.all([
        this.diagnostics.readHead({ workspaceId: input.session.workspaceId, sessionId: input.session.sessionId }),
        this.diagnostics.listDetections({
          workspaceId: input.session.workspaceId,
          sessionId: input.session.sessionId,
        }),
      ])
      const manual = this.manualAnchorObservation({
        diagnostic,
        trackId: input.track.trackId,
        sessionTimebase: input.sessionTimebase,
      })
      if (manual) observations.push(manual)
      const marker = this.markerObservation({
        detections,
        trackId: input.track.trackId,
        referenceTrackId: input.referenceTrack.trackId,
        sessionTimebase: input.sessionTimebase,
      })
      if (marker) observations.push(marker)
    }
    return Object.freeze(observations)
  }

  /**
   * Every candidate part against every reference part.
   *
   * A pair at a time, because the offset is unknown before it is measured: two
   * files that overlap in declared coverage need not overlap in reality, and
   * that discrepancy is the very thing being measured.
   */
  private async observeAudio(input: {
    session: Readonly<CaptureSession>
    track: Readonly<CaptureTrack>
    referenceTrack: Readonly<CaptureTrack>
    sessionTimebase: Readonly<Timebase>
  }): Promise<readonly Readonly<SyncSignalObservation>[]> {
    const sampleTimebase = timebaseFromRate(this.sampleRate)
    const candidateParts = byOrdinal(input.track.parts)
    const referenceParts = byOrdinal(input.referenceTrack.parts)
    const observations: Readonly<SyncSignalObservation>[] = []

    const referenceAudio = new Map<string, DecodedAudio>()
    for (const referencePart of referenceParts) {
      referenceAudio.set(
        referencePart.partId,
        await this.decode({ workspaceId: input.session.workspaceId, part: referencePart }),
      )
    }

    for (const candidatePart of candidateParts) {
      const candidate = await this.decode({ workspaceId: input.session.workspaceId, part: candidatePart })
      if (!candidate.hasAudio || candidate.samples.length === 0) continue

      for (const referencePart of referenceParts) {
        const reference = referenceAudio.get(referencePart.partId)!
        if (!reference.hasAudio || reference.samples.length === 0) continue

        const observation = this.correlatePair({
          candidate,
          reference,
          candidatePart,
          referencePart,
          track: input.track,
          referenceTrack: input.referenceTrack,
          sampleTimebase,
          sessionTimebase: input.sessionTimebase,
        })
        if (observation) observations.push(observation)
      }
    }
    return observations
  }

  private correlatePair(input: {
    candidate: DecodedAudio
    reference: DecodedAudio
    candidatePart: Readonly<CaptureTrackPart>
    referencePart: Readonly<CaptureTrackPart>
    track: Readonly<CaptureTrack>
    referenceTrack: Readonly<CaptureTrack>
    sampleTimebase: Readonly<Timebase>
    sessionTimebase: Readonly<Timebase>
  }): Readonly<SyncSignalObservation> | null {
    const windowSamples = Math.round((this.windowMs / 1_000) * this.sampleRate)
    const spanMs = (input.candidate.samples.length / this.sampleRate) * 1_000
    const hopMs = Math.max(
      AUDIO_SYNC_SIGNAL_DEFAULTS.minimumHopMs,
      Math.floor(spanMs / AUDIO_SYNC_SIGNAL_DEFAULTS.maximumCorrelationWindows),
    )
    const correlations = correlateAudioWindows({
      reference: input.reference.samples,
      candidate: input.candidate.samples,
      sampleRate: this.sampleRate,
      windowMs: this.windowMs,
      hopMs,
      correlationRate: this.sampleRate,
    })

    // The same admission rule the react detector applies, stated once: a window
    // whose peak never reached the floor, or that could not separate its winner
    // from the runner-up, located nothing.
    const admission = DEFAULT_SYNC_EVIDENCE_THRESHOLDS.minimumPeakRatioForAdmission
    const locked = correlations.filter((entry) =>
      entry.lagSamples !== null && entry.peak >= this.minimumPeak && entry.peakRatio >= admission)
    if (locked.length === 0) return null

    // Both files start where their part says they start, so a window's instant
    // is its part's origin plus its position inside the file. Skipping this and
    // treating sample zero as tick zero is how a second part of a restarted
    // recorder gets aligned to the beginning of the session.
    const candidateOrigin = convertTick({
      tick: input.candidatePart.coverage.start,
      from: input.candidatePart.timebase,
      to: input.sampleTimebase,
    })
    const referenceOrigin = convertTick({
      tick: input.referencePart.coverage.start,
      from: input.referencePart.timebase,
      to: input.sampleTimebase,
    })

    const offsets = locked.map((entry) =>
      (referenceOrigin + BigInt(entry.lagSamples!)) - (candidateOrigin + BigInt(entry.startSample)))
    const chosen = medianBigInt(offsets)
    const toleranceSamples = BigInt(
      Math.round((AUDIO_SYNC_SIGNAL_DEFAULTS.agreementToleranceMs / 1_000) * this.sampleRate),
    )
    const agreeing: { correlation: Readonly<AudioWindowCorrelation>; offset: bigint }[] = []
    for (let index = 0; index < locked.length; index += 1) {
      const deviation = offsets[index]! - chosen
      const magnitude = deviation < BigInt(0) ? -deviation : deviation
      if (magnitude <= toleranceSamples) agreeing.push({ correlation: locked[index]!, offset: offsets[index]! })
    }
    if (agreeing.length < AUDIO_SYNC_SIGNAL_DEFAULTS.minimumAgreeingWindows) return null

    const residualTicks = agreeing.reduce((worst, entry) => {
      const deviation = entry.offset - chosen
      const magnitude = deviation < BigInt(0) ? -deviation : deviation
      return magnitude > worst ? magnitude : worst
    }, BigInt(0))

    const published = spread(agreeing, AUDIO_SYNC_SIGNAL_DEFAULTS.maximumPublishedAnchors)
    const signalId = `audio-p${input.candidatePart.ordinal}-r${input.referencePart.ordinal}`
    const anchors: Readonly<SyncAnchorObservation>[] = published.map((entry, index) => Object.freeze({
      anchorId: `${signalId}-w${index}`,
      sourceTick: candidateOrigin + BigInt(entry.correlation.startSample),
      sessionTick: referenceOrigin + BigInt(entry.correlation.lagSamples!),
      evidenceRef: `${input.candidatePart.evidence.probeHash.slice(0, 16)}:${entry.correlation.startSample}`,
    }))

    // Reported in session ticks while the offset and anchors above are in the
    // signal's own timebase. That asymmetry is the cascade's
    // (`sync-evidence.ts:218-242`; `coverageOf` converts nothing), and getting
    // it wrong looks like a coverage shortfall rather than a unit error.
    const sessionTicks = anchors.map((anchor) => anchor.sessionTick)
    const supportStart = sessionTicks.reduce((least, value) => (value < least ? value : least))
    const supportEnd = sessionTicks.reduce((most, value) => (value > most ? value : most)) + BigInt(windowSamples)
    const coverage = createTickInterval(
      convertTick({ tick: supportStart, from: input.sampleTimebase, to: input.sessionTimebase, rounding: 'floor' }),
      convertTick({ tick: supportEnd, from: input.sampleTimebase, to: input.sessionTimebase, rounding: 'ceil' }),
    )

    const bestPeak = median(agreeing.map((entry) => entry.correlation.peak))
    const secondBestPeak = median(agreeing.map((entry) => entry.correlation.secondPeak))
    const peakRatio = secondBestPeak > 0 ? bestPeak / secondBestPeak : bestPeak > 0 ? Infinity : 0

    return Object.freeze({
      signalId,
      method: 'audio-fingerprint' as const,
      timebase: input.sampleTimebase,
      offsetTicks: chosen,
      // No `rate`: this measures where, not how fast. Reporting 1.0 would claim
      // the two clocks were measured and found identical.
      anchors: Object.freeze(anchors),
      preconditions: Object.freeze([
        Object.freeze({
          id: 'both-tracks-carry-audio',
          satisfied: true,
          detail: `${input.track.trackId} and ${input.referenceTrack.trackId} both decoded to ${this.sampleRate} Hz mono PCM`,
        }),
        Object.freeze({
          id: 'common-acoustic-event',
          satisfied: true,
          detail: `${agreeing.length} of ${correlations.length} windows placed the same audio at the same offset`,
        }),
      ]),
      ambiguity: Object.freeze({
        bestPeak,
        secondBestPeak,
        windowsConsidered: correlations.length,
        windowsAgreeing: agreeing.length,
      }),
      coverage: Object.freeze([coverage]),
      residualTicks,
      confidence: confidenceFromPeakRatio(peakRatio),
      // Every window of one correlation is one opinion. Two of them agreeing
      // says nothing an independent method would (ADR-151), so they share a
      // group and cannot corroborate each other.
      independenceGroup: 'audio-fingerprint',
      evidenceRefs: Object.freeze([
        `part:${input.candidatePart.partId}`,
        `part:${input.referencePart.partId}`,
      ]),
    })
  }

  /**
   * What an operator already decided, offered back to the cascade as evidence.
   *
   * Read from the diagnostic rather than taken from the caller: a request that
   * could carry anchors would let a client assert an alignment it never
   * measured, which is precisely what the request/derivation split exists to
   * prevent.
   */
  private manualAnchorObservation(input: {
    diagnostic: Readonly<SyncDiagnostic> | null
    trackId: string
    sessionTimebase: Readonly<Timebase>
  }): Readonly<SyncSignalObservation> | null {
    const track = input.diagnostic?.tracks.find((entry) => entry.trackId === input.trackId)
    const manual = (track?.manualAnchors ?? []).filter((anchor) => anchor.origin === 'manual')
    if (manual.length === 0) return null
    return this.anchorObservation({
      signalId: 'manual-anchors',
      method: 'manual-anchor',
      independenceGroup: 'operator',
      anchors: manual.map((anchor) => ({
        anchorId: anchor.anchorId,
        sourceMs: anchor.sourceMs,
        sessionMs: anchor.sessionMs,
        confidence: anchor.confidence,
        evidenceRef: anchor.evidenceRef,
      })),
      preconditions: [
        {
          id: 'operator-identified',
          satisfied: manual.every((anchor) => anchor.origin === 'manual'),
          detail: `${manual.length} anchors placed by an operator on the diagnostic`,
        },
        {
          id: 'anchor-reviewable',
          satisfied: manual.every((anchor: Readonly<DiagnosticAnchor>) => anchor.evidenceRef.trim().length > 0),
          detail: 'every anchor names the evidence it was placed against',
        },
      ],
      sessionTimebase: input.sessionTimebase,
    })
  }

  /**
   * Confirmed Apollo markers, paired across the two tracks.
   *
   * A marker seen on one track is a timestamp, not a correspondence. Only the
   * same marker confirmed on both tracks says anything about the offset, which
   * is why the pairing is by `markerId` and both sides must be `confirmed`.
   *
   * These observations are admissible only in principle today. The cascade
   * requires ambiguity evidence from any method that locates by searching
   * (`SYNC_METHODS_REQUIRING_AMBIGUITY_EVIDENCE['apollo-marker']`), and
   * `MarkerDetection` keeps only `visualObservationId`/`audioObservationId` —
   * the fusion measured the correlation peak and its runner-up
   * (`sync-marker-detection.ts:72-73`) and the aggregate did not keep them. So
   * the cascade will discard these with `ambiguity-evidence-missing`, which is
   * recorded in the evidence record and is the honest answer: fabricating the
   * peaks to make the strongest method pass would be the worst possible lie
   * this file could tell.
   */
  private markerObservation(input: {
    detections: readonly Readonly<MarkerDetection>[]
    trackId: string
    referenceTrackId: string
    sessionTimebase: Readonly<Timebase>
  }): Readonly<SyncSignalObservation> | null {
    const confirmed = input.detections.filter((entry) => entry.outcome === 'confirmed' && entry.atMs !== null)
    const onReference = new Map(
      confirmed.filter((entry) => entry.trackId === input.referenceTrackId).map((entry) => [entry.markerId, entry]),
    )
    const paired = confirmed
      .filter((entry) => entry.trackId === input.trackId)
      .flatMap((entry) => {
        const reference = onReference.get(entry.markerId)
        return reference
          ? [{
            anchorId: `marker-${entry.markerId}`,
            sourceMs: entry.atMs!,
            sessionMs: reference.atMs!,
            confidence: Math.min(entry.confidence, reference.confidence),
            evidenceRef: `detection:${entry.detectionHash.slice(0, 16)}`,
          }]
          : []
      })
    if (paired.length === 0) return null
    return this.anchorObservation({
      signalId: 'apollo-markers',
      method: 'apollo-marker',
      independenceGroup: 'apollo-marker',
      anchors: paired,
      preconditions: [
        {
          id: 'marker-sequence-matched',
          satisfied: true,
          detail: `${paired.length} markers confirmed on both tracks and matched by identity`,
        },
        { id: 'marker-observed-in-both-tracks', satisfied: true, detail: 'every pair names one marker seen twice' },
      ],
      sessionTimebase: input.sessionTimebase,
    })
  }

  /** The shared shape of an observation built from instants rather than audio. */
  private anchorObservation(input: {
    signalId: string
    method: 'manual-anchor' | 'apollo-marker'
    independenceGroup: string
    anchors: readonly Readonly<{
      anchorId: string
      sourceMs: number
      sessionMs: number
      confidence: number
      evidenceRef: string
    }>[]
    preconditions: readonly Readonly<{ id: string; satisfied: boolean; detail: string }>[]
    sessionTimebase: Readonly<Timebase>
  }): Readonly<SyncSignalObservation> | null {
    const usable = input.anchors.filter((anchor) =>
      Number.isFinite(anchor.sourceMs) && Number.isFinite(anchor.sessionMs))
    if (usable.length === 0) return null

    const offsets = usable.map((anchor) => BigInt(Math.round(anchor.sessionMs) - Math.round(anchor.sourceMs)))
    const chosen = medianBigInt(offsets)
    const residualTicks = offsets.reduce((worst, offset) => {
      const deviation = offset - chosen
      const magnitude = deviation < BigInt(0) ? -deviation : deviation
      return magnitude > worst ? magnitude : worst
    }, BigInt(0))

    const sessionMs = usable.map((anchor) => Math.round(anchor.sessionMs))
    const support = AUDIO_SYNC_SIGNAL_DEFAULTS.anchorSupportMs
    const coverage = createTickInterval(
      convertTick({
        tick: BigInt(Math.min(...sessionMs) - support),
        from: MILLISECOND_TIMEBASE,
        to: input.sessionTimebase,
        rounding: 'floor',
      }),
      convertTick({
        tick: BigInt(Math.max(...sessionMs) + support),
        from: MILLISECOND_TIMEBASE,
        to: input.sessionTimebase,
        rounding: 'ceil',
      }),
    )

    return Object.freeze({
      signalId: input.signalId,
      method: input.method,
      timebase: MILLISECOND_TIMEBASE,
      offsetTicks: chosen,
      anchors: Object.freeze(usable.map((anchor) => Object.freeze({
        anchorId: anchor.anchorId,
        sourceTick: BigInt(Math.round(anchor.sourceMs)),
        sessionTick: BigInt(Math.round(anchor.sessionMs)),
        evidenceRef: anchor.evidenceRef,
      }))),
      preconditions: Object.freeze(input.preconditions.map((entry) => Object.freeze({ ...entry }))),
      coverage: Object.freeze([coverage]),
      residualTicks,
      // The weakest anchor in the set, not the average: a set is only as
      // trustworthy as the anchor an operator was least sure about.
      confidence: Math.min(...usable.map((anchor) => anchor.confidence)),
      independenceGroup: input.independenceGroup,
      evidenceRefs: Object.freeze(usable.map((anchor) => anchor.evidenceRef)),
    })
  }

  /**
   * One part's audio as samples, with the media released in `finally`.
   *
   * The S3 driver materializes by downloading the whole recording, so a caller
   * that forgets leaves a complete copy per file it measured. The local driver
   * copies nothing, which is exactly why forgetting is invisible in
   * development.
   */
  private async decode(input: {
    workspaceId: string
    part: Readonly<CaptureTrackPart>
  }): Promise<DecodedAudio> {
    const materialized = await this.media.resolve(input)
    const scratch = await mkdtemp(join(tmpdir(), 'apollo-audio-sync-'))
    try {
      return await this.extractPcm(materialized.path, join(scratch, 'audio.pcm'))
    } finally {
      await materialized.release()
      await rm(scratch, { recursive: true, force: true }).catch((error: unknown) => {
        // Reported, never rethrown: losing the scratch directory must not turn
        // a completed measurement into a failed run.
        process.emitWarning(`audio sync scratch ${scratch} could not be removed: ${String(error)}`)
      })
    }
  }

  private async extractPcm(mediaPath: string, pcmPath: string): Promise<DecodedAudio> {
    try {
      await execFileAsync(this.ffmpegPath, [
        '-hide_banner', '-nostdin', '-y',
        '-t', String(this.maximumAnalysisSeconds),
        '-i', mediaPath,
        '-vn', '-ac', '1', '-ar', String(this.sampleRate),
        '-f', 's16le', pcmPath,
      ], { maxBuffer: 64 * 1024 * 1024, timeout: AUDIO_SYNC_SIGNAL_DEFAULTS.decodeTimeoutMs })
    } catch (error) {
      // A file with no audio stream and a broken decode both make FFmpeg exit
      // non-zero, and they are opposite facts: the first is something to
      // report about the session, the second is something wrong with the run.
      // Collapsing them would turn a failing codec into "no evidence found".
      const stderr = String((error as { stderr?: unknown }).stderr ?? '')
      if (/does not contain any stream|matches no streams|Output file is empty/i.test(stderr)) {
        return Object.freeze({ samples: new Int16Array(0), hasAudio: false })
      }
      throw new DomainError(
        'INVALID_MEDIA_ARTIFACT',
        `audio could not be decoded from ${mediaPath} for synchronization: ${stderr.split('\n').slice(-3).join(' ').trim() || String(error)}`,
      )
    }
    const bytes = await readFile(pcmPath)
    const samples = new Int16Array(Math.floor(bytes.length / 2))
    for (let index = 0; index < samples.length; index += 1) samples[index] = bytes.readInt16LE(index * 2)
    return Object.freeze({ samples, hasAudio: samples.length > 0 })
  }
}
