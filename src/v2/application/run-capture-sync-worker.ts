import {
  createSessionClock,
  createSourceClock,
  createSourceToSessionMapping,
  type ClockConfidence,
  type SessionClock,
} from '../domain/session-clock.ts'
import {
  convertTick,
  createTickInterval,
  rational,
  type Rational,
  type Timebase,
  type TickInterval,
} from '../domain/session-time.ts'
import {
  createPiecewiseClockMap,
  type PiecewiseClockMapPieceInput,
} from '../domain/piecewise-clock-map.ts'
import {
  evaluateSyncEvidence,
  type SyncEvidenceRecord,
  type SyncSignalObservation,
} from '../domain/sync-evidence.ts'
import type { CaptureSession, CaptureTrack, CaptureTrackPart } from '../domain/capture-session.ts'
import { DomainError } from '../domain/errors.ts'
import { deriveTrackCoverage } from './derive-track-coverage.ts'
import type { CaptureSessionRepository } from './ports/capture-session-repository.ts'
import type { CaptureSyncRunRepository } from './ports/capture-sync-run-repository.ts'

/**
 * The durable synchronization worker (F4.004/F4.006/F4.007).
 *
 * The shape that matters is not the loop; it is what happens between claiming
 * a run and settling it. The worker heartbeats while it works and checks the
 * answer before writing: if the heartbeat has failed, the lease is gone and
 * this worker's result describes a claim that no longer exists. It stops rather
 * than writing, and the run it lost is already back in the queue for whoever
 * took it.
 *
 * Signals arrive through a port rather than being measured here. Fingerprinting
 * and probing belong to the media layer; what this module owns is the decision
 * — and keeping the decision separable from the measurement is what lets the
 * whole cascade be tested against known inputs without touching a codec.
 */

/**
 * Where a track's candidate sync signals come from. Never a paid provider.
 *
 * The session clock the worker resolved is handed in rather than re-derived by
 * the adapter. A signal's `coverage` is counted in session ticks while its
 * offset and anchors are counted in the signal's own timebase
 * (`sync-evidence.ts:218-242`), so an adapter that guessed the session clock
 * would emit coverage against a different clock than the cascade measures it
 * with — and the failure would look like a coverage shortfall, not a
 * disagreement about units.
 */
export interface SyncSignalSource {
  observe(input: {
    session: Readonly<CaptureSession>
    track: Readonly<CaptureTrack>
    referenceTrack: Readonly<CaptureTrack>
    sessionTimebase: Readonly<Timebase>
    sessionFrameRate: Rational
    sessionBounds: Readonly<TickInterval>
    /**
     * Called by the adapter between the pieces of work it can be interrupted
     * between, so a measurement longer than the lease keeps its claim.
     *
     * A heartbeat taken only around `observe` cannot help: one correlation of
     * an hour of audio against an hour of audio is a single synchronous call,
     * measured on this machine at 71 s (N=1) at the adapter's own 1800 s
     * analysis cap and 9.1 s (N=3, sd 1.6 s) at 300 s. Awaiting this between
     * pairs is what lets the event loop — and therefore the lease — run at all.
     *
     * It never throws and never reports. A worker that has lost its lease finds
     * out from the worker's own record of the answer, after the observation
     * returns, and stops there rather than inside the media layer.
     */
    heartbeat?: () => Promise<void>
  }): Promise<readonly Readonly<SyncSignalObservation>[]>
}

export interface CaptureSyncWorkerResult {
  readonly claimed: boolean
  readonly runId: string | null
  /**
   * The workspace the claimed run belongs to. A run id alone cannot be read
   * back: every capture table is keyed by workspace first, so a driver holding
   * only the id would have to be told the workspace by an environment
   * variable — which is how a worker ends up reading the wrong tenant's row.
   */
  readonly workspaceId: string | null
  readonly settled: boolean
  readonly resolved: number
  readonly review: number
  readonly insufficient: number
  /** Tracks whose coverage was derived and persisted this pass. */
  readonly coverageDerived: number
  /**
   * Tracks whose coverage the domain refused — overlapping parts with no
   * operator decision, in practice. Counted rather than thrown: one track
   * awaiting a human must not stop the other five from being synchronized.
   */
  readonly coverageRefused: number
  /**
   * Tracks the cascade resolved but whose parts could not be assembled into a
   * legal piecewise map — overlapping parts, in practice. Counted rather than
   * thrown for the same reason coverage is: one unmappable track must not
   * orphan the lease and fail the run for every other camera.
   */
  readonly mapRefused: number
  /**
   * Tracks whose media could not be opened because it is absent or no longer
   * the file the part was built from. A fact about the session, not a fault of
   * the run: the track reaches `insufficient-evidence` and the pass continues.
   */
  readonly mediaUnavailable: number
  readonly abandonedBecause?: 'lease-lost' | 'superseded' | 'session-moved'
}

/**
 * How long a claim is held, and why it is not a minute.
 *
 * The lease has to outlast the longest stretch this worker cannot be
 * interrupted in. That stretch is one audio correlation, which is synchronous:
 * measured on this machine calling `correlateAudioWindows` exactly as the
 * adapter does (2 kHz, 2 s windows, exhaustive), one candidate part against one
 * reference part costs 160 ms (N=3, sd 12 ms) for 40 s of material, 9.1 s
 * (N=3, sd 1.6 s) for 300 s, and 71 s (N=1, 345 MB RSS) at the adapter's own
 * 1800 s analysis cap. With a 60 s lease — the value this worker shipped with —
 * any session past roughly a minute of audio was reclaimed mid-correlation,
 * `settle` returned `lease-lost`, and three attempts later the run was failed
 * permanently. Five minutes is four times the measured worst case and the same
 * order as the adapter's decode timeout.
 *
 * `createCaptureSyncWorker` overrides it from `APOLLO_V2_CAPTURE_SYNC_LEASE_MS`
 * or `APOLLO_V2_WORKER_LEASE_MS`, the way the sibling worker factories do.
 */
export const DEFAULT_LEASE_MS = 300_000

/** Where the session's frame rate came from. Ordered strongest first. */
export const SESSION_FRAME_RATE_SOURCES = Object.freeze([
  'persisted-session-clock',
  'reference-track-timebase',
  'reference-part-timebase',
] as const)
export type SessionFrameRateSource = (typeof SESSION_FRAME_RATE_SOURCES)[number]

/**
 * The window in which the inverse of a timebase is a shutter rather than a
 * clock.
 *
 * A recorder writes video in one of two kinds of timebase: the frame duration
 * itself (1/25, 1001/30000) or a media clock the frames are counted against
 * (600, 1000, 48000, 90000 ticks per second). Inverting the second kind
 * produces "90000 fps", which is not a slow answer — it is a wrong one, and it
 * would be carried into every residual threshold in the cascade. Three hundred
 * is above the fastest camera anyone points at a talking head and below every
 * media clock in use.
 */
export const MINIMUM_PLAUSIBLE_FRAME_RATE = 1
export const MAXIMUM_PLAUSIBLE_FRAME_RATE = 300

function frameRateFromTimebase(timebase: Readonly<Timebase>): Rational | null {
  const candidate = rational(timebase.secondsPerTick.den, timebase.secondsPerTick.num)
  const asNumber = Number(candidate.num) / Number(candidate.den)
  if (!Number.isFinite(asNumber)) return null
  if (asNumber < MINIMUM_PLAUSIBLE_FRAME_RATE || asNumber > MAXIMUM_PLAUSIBLE_FRAME_RATE) return null
  return candidate
}

/**
 * The session's frame rate, or nothing.
 *
 * Every threshold the cascade compares against is stated in frames — residual
 * limits, contradiction bands, the two-frame ceiling on a high-confidence map —
 * so the frame rate is not a display detail. Until this slice the worker
 * defaulted to 30000/1001 when the session clock had never been persisted,
 * which is always: nothing writes `capture_session_clocks` in production
 * (map §19.3). Every 25 fps session was therefore measured against 29.97, and a
 * residual of one 25 fps frame read as 1.2 frames — quietly stricter, and
 * quietly wrong.
 *
 * Returning `null` is the honest third answer. A caller that cannot name the
 * frame rate has no business naming a residual in frames.
 */
export function resolveSessionFrameRate(input: {
  clock: Readonly<SessionClock> | null
  referenceTrack: Readonly<CaptureTrack>
}): Readonly<{ frameRate: Rational; source: SessionFrameRateSource }> | null {
  if (input.clock) {
    return Object.freeze({ frameRate: input.clock.frameRate, source: 'persisted-session-clock' as const })
  }
  const fromTrack = frameRateFromTimebase(input.referenceTrack.timebase)
  if (fromTrack) {
    return Object.freeze({ frameRate: fromTrack, source: 'reference-track-timebase' as const })
  }
  // A recorder that restarted in a different timebase leaves the track carrying
  // the first part's; the parts are asked in the recorder's own order so the
  // answer is the earliest one that names a rate, not whichever sorted first.
  for (const part of [...input.referenceTrack.parts].sort((left, right) => left.ordinal - right.ordinal)) {
    const fromPart = frameRateFromTimebase(part.timebase)
    if (fromPart) {
      return Object.freeze({ frameRate: fromPart, source: 'reference-part-timebase' as const })
    }
  }
  return null
}

/**
 * The errors that mean "there is no file to listen to", as opposed to "the
 * file will not open".
 *
 * `MEDIA_ARTIFACT_NOT_FOUND` is the artifact row being gone
 * (`capture-media-resolver.ts:68-73`); `MEDIA_ARTIFACT_IDENTITY_MISMATCH` and
 * the materializer's `PERSISTENCE_CONFLICT`
 * (`local-media-upload-storage.ts:263-266`) are the bytes on disk no longer
 * being the bytes the part was built from — absent, renamed, re-encoded. All
 * three describe the session, not the run.
 */
export const ABSENT_CAPTURE_MEDIA_ERROR_CODES: ReadonlySet<string> = new Set([
  'MEDIA_ARTIFACT_NOT_FOUND',
  'MEDIA_ARTIFACT_IDENTITY_MISMATCH',
  'MEDIA_ARTIFACT_SOURCE_NOT_FOUND',
  'PERSISTENCE_CONFLICT',
])

function isAbsentMediaError(error: unknown): boolean {
  return error instanceof DomainError && ABSENT_CAPTURE_MEDIA_ERROR_CODES.has(error.code)
}

/**
 * The hull of a track, in its own ticks.
 *
 * Taken from the parts rather than from a declared duration: a declared
 * duration is a wish, and the parts are what the recorder actually wrote.
 */
function trackBounds(track: Readonly<CaptureTrack>): Readonly<TickInterval> {
  const starts = track.parts.map((part) => part.coverage.start)
  const ends = track.parts.map((part) => part.coverage.end)
  return createTickInterval(
    starts.reduce((least, value) => (value < least ? value : least)),
    ends.reduce((most, value) => (value > most ? value : most)),
  )
}

/**
 * Which discontinuous cause a recorder's split reason names.
 *
 * Only consulted when the parts really do leave a hole. `single-file` reaching
 * here at all means a track was assembled wrong, and `file-split` is the honest
 * description of what the ticks show either way.
 */
function discontinuousCauseFor(splitReason: string): 'file-split' | 'recorder-restart' {
  return splitReason === 'recorder-restart' || splitReason === 'card-change'
    ? 'recorder-restart'
    : 'file-split'
}

/** What one part's own audio said, and whether anything actually said it. */
interface PartAlignment {
  readonly offsetTicks: bigint
  readonly residualBoundTicks: bigint
  /** False when no admissible signal named this part and it inherited the elected law. */
  readonly measured: boolean
  readonly signalIds: readonly string[]
}

/**
 * The offset measured for one part, not the offset measured for the track.
 *
 * The adapter emits one observation per (candidate part x reference part) pair
 * and the cascade elects exactly one of them, so stamping the elected offset
 * onto every piece hands a recorder's second file the first file's alignment —
 * silently, because both observations share an independence group and the
 * cascade does not look for contradictions inside a group
 * (`sync-evidence.ts:689`). Measured before this was fixed: a two-part phone
 * track whose parts genuinely differed by 90000 ticks published both pieces at
 * the first part's 4500.
 *
 * The pairing is by `evidenceRef`, which every observation states as
 * `part:<partId>`, rather than by parsing a signal id: an adapter is free to
 * name its signals whatever it likes, and the worker has no business knowing
 * the format.
 */
function alignmentForPart(input: {
  part: Readonly<CaptureTrackPart>
  record: Readonly<SyncEvidenceRecord>
}): PartAlignment {
  const { part, record } = input
  const elected = record.assessments.find((assessment) => assessment.signalId === record.selectedSignalId)
  const electedOffset = record.clockMap?.offsetTicks ?? elected?.sessionOffsetTicks ?? BigInt(0)
  const names = `part:${part.partId}`
  if (elected && elected.evidenceRefs.includes(names)) {
    return {
      offsetTicks: electedOffset,
      residualBoundTicks: elected.residualSessionTicks,
      measured: true,
      signalIds: [elected.signalId],
    }
  }
  // The best admissible signal that looked at THIS file. Ranked by the
  // cascade's own within-tier score rather than by order, so the choice is the
  // cascade's and not the array's.
  const own = record.assessments
    .filter((assessment) => assessment.admissible && assessment.evidenceRefs.includes(names))
    .sort((left, right) => right.score - left.score)[0]
  if (own) {
    return {
      offsetTicks: own.sessionOffsetTicks,
      residualBoundTicks: own.residualSessionTicks,
      measured: true,
      signalIds: [own.signalId],
    }
  }
  return {
    offsetTicks: electedOffset,
    residualBoundTicks: elected?.residualSessionTicks ?? BigInt(0),
    measured: false,
    signalIds: elected ? [elected.signalId] : (record.selectedSignalId ? [record.selectedSignalId] : []),
  }
}

interface PieceGroup {
  parts: Readonly<CaptureTrackPart>[]
  alignment: PartAlignment
  openedBy?: 'file-split' | 'recorder-restart' | 'residual-exceeded'
  openedByDetail?: string
}

/**
 * Turn one cascade verdict into a piecewise map.
 *
 * A piece is not a file. A piece is a stretch of source ticks one affine law
 * describes, and a new one begins only where something happened that a law
 * cannot cross:
 *
 * **A hole between two files.** The gap between a recorder stopping and
 * restarting is time the source was not producing, and a single law spanning it
 * would resolve ticks inside it — the interpolation F4.007 exists to refuse.
 *
 * **Two files measuring different offsets.** One line cannot describe both, and
 * `residual-exceeded` is the cause that says exactly that.
 *
 * Two files that touch exactly and agree on the offset are ONE piece. Emitting
 * two and labelling the boundary `file-split` was a blocker, not a cosmetic
 * choice: `file-split` is a discontinuous cause and
 * `piecewise-clock-map.ts:244-250` refuses it without a gap, so the ordinary
 * 4 GB split threw a `DomainError` out of the worker and left the run claimed
 * and never settled. The suite's own coverage fixture calls that split the
 * healthy case (`capture-sync-worker-coverage.test.mjs:110`).
 */
function buildMapPieces(input: {
  track: Readonly<CaptureTrack>
  record: Readonly<SyncEvidenceRecord>
  session: Readonly<CaptureSession>
  sessionClockId: string
}): readonly PiecewiseClockMapPieceInput[] {
  const { record, track } = input
  if (!record.clockMap) return []
  const clock = createSessionClock({
    sessionId: input.session.sessionId,
    timebase: record.sessionTimebase,
    frameRate: record.sessionFrameRate,
    authority: {
      origin: 'primary-camera',
      sourceId: input.session.referenceTrackId,
      provenance: 'original-capture',
      evidenceRef: input.sessionClockId,
    },
    establishedAt: input.session.createdAt,
  })
  const source = createSourceClock({
    sourceId: track.sourceAssetId,
    timebase: track.timebase,
    provenance: 'original-capture',
  })
  const verdictConfidence: ClockConfidence = record.outcome === 'auto-apply' ? 'high' : 'medium'

  const ordered = [...track.parts].sort((left, right) => left.ordinal - right.ordinal)
  const groups: PieceGroup[] = []
  for (const part of ordered) {
    const alignment = alignmentForPart({ part, record })
    const previous = groups[groups.length - 1]
    if (!previous) {
      groups.push({ parts: [part], alignment })
      continue
    }
    const before = previous.parts[previous.parts.length - 1]!
    const hole = part.coverage.start > before.coverage.end
    const agrees = alignment.offsetTicks === previous.alignment.offsetTicks
    if (!hole && agrees) {
      // One law, two files. The bound is the worse of the two, because the law
      // now has to be true of both, and both signals are named as evidence.
      previous.parts.push(part)
      previous.alignment = {
        offsetTicks: previous.alignment.offsetTicks,
        residualBoundTicks: alignment.residualBoundTicks > previous.alignment.residualBoundTicks
          ? alignment.residualBoundTicks
          : previous.alignment.residualBoundTicks,
        measured: previous.alignment.measured || alignment.measured,
        signalIds: [...new Set([...previous.alignment.signalIds, ...alignment.signalIds])],
      }
      continue
    }
    groups.push({
      parts: [part],
      alignment,
      // The recorder said why it split, and that reason is carried through
      // rather than re-derived — but only when the ticks agree that something
      // was lost. A cause is a claim about the recording, and a claim the
      // measurement contradicts is refused by the map constructor, correctly.
      openedBy: hole ? discontinuousCauseFor(part.splitReason) : 'residual-exceeded',
      openedByDetail: hole
        ? `recorder wrote part ${part.ordinal} after a ${part.splitReason.replace(/-/g, ' ')}`
        : `part ${part.ordinal} measured its own offset of ${alignment.offsetTicks} session ticks ` +
          `where the parts before it measured ${previous.alignment.offsetTicks}; one line cannot describe both`,
    })
  }

  return groups.map((group) => {
    const first = group.parts[0]!
    const last = group.parts[group.parts.length - 1]!
    const refs = group.alignment.signalIds.filter((id) => id.length > 0)
    return {
      pieceId: `${track.trackId}-piece-${first.ordinal}`,
      mapping: createSourceToSessionMapping({
        clock,
        source,
        sourceCoverage: createTickInterval(first.coverage.start, last.coverage.end),
        driftRate: rational(record.clockMap!.rate.num, record.clockMap!.rate.den),
        offsetTicks: group.alignment.offsetTicks,
        // The bound the signal that measured THIS piece actually reported, not
        // zero. Zero says "exact to the tick", which no correlation supports and
        // which the cascade had already refuted in the same record. Drift is
        // still not fitted (F4.006 has no runtime caller and the drift-fit table
        // no writer), so this bounds the offset and not a rate.
        residualBoundTicks: group.alignment.residualBoundTicks,
        // A piece nobody measured inherits a neighbour's law, and an inherited
        // law is never high confidence however clean the measurement it came
        // from was.
        confidence: group.alignment.measured ? verdictConfidence : 'medium',
        anchorIds: refs,
        evidenceRefs: refs,
      }),
      ...(group.openedBy
        ? { openedBy: group.openedBy, openedByDetail: group.openedByDetail! }
        : {}),
    }
  })
}

export function runCaptureSyncWorker(dependencies: {
  sessions: CaptureSessionRepository
  runs: CaptureSyncRunRepository
  signals: SyncSignalSource
  owner: string
  clock: () => Date
  leaseMs?: number
}) {
  const leaseMs = dependencies.leaseMs ?? DEFAULT_LEASE_MS

  return async (): Promise<Readonly<CaptureSyncWorkerResult>> => {
    const claim = await dependencies.runs.claim({
      owner: dependencies.owner,
      now: dependencies.clock().toISOString(),
      leaseMs,
    })
    if (!claim) {
      return Object.freeze({
        claimed: false, runId: null, workspaceId: null, settled: false, resolved: 0, review: 0, insufficient: 0,
        coverageDerived: 0, coverageRefused: 0, mapRefused: 0, mediaUnavailable: 0,
      })
    }

    const { run, leaseToken } = claim
    // Declared before the failure path so a run that fails halfway still
    // reports the coverage it had already derived and written: those rows are
    // real, and saying zero would make the failure look total when it was not.
    let coverageDerived = 0
    let coverageRefused = 0
    let mapRefused = 0
    let mediaUnavailable = 0
    const failWith = async (reason: string) => {
      await dependencies.runs.settle({
        workspaceId: run.workspaceId,
        runId: run.id,
        leaseToken,
        now: dependencies.clock().toISOString(),
        outcome: { status: 'failed', failureReason: reason },
      })
      return Object.freeze({
        claimed: true, runId: run.id, workspaceId: run.workspaceId, settled: true,
        resolved: 0, review: 0, insufficient: 0,
        coverageDerived, coverageRefused, mapRefused, mediaUnavailable,
      })
    }

    const session = await dependencies.sessions.readHead({
      workspaceId: run.workspaceId,
      sessionId: run.sessionId,
    })
    if (!session) return failWith('the capture session no longer exists')
    // The run names the exact version it was requested against. If the session
    // has moved, the tracks this run would measure are not the tracks in the
    // session, and filing the result would attribute a map to the wrong
    // version — worse than having no map.
    if (session.sessionHash !== run.baseSessionHash) {
      await dependencies.runs.settle({
        workspaceId: run.workspaceId,
        runId: run.id,
        leaseToken,
        now: dependencies.clock().toISOString(),
        outcome: {
          status: 'failed',
          failureReason: `the session moved to version ${session.version} while this run was queued`,
        },
      })
      return Object.freeze({
        claimed: true, runId: run.id, workspaceId: run.workspaceId, settled: true,
        resolved: 0, review: 0, insufficient: 0,
        coverageDerived, coverageRefused, mapRefused, mediaUnavailable,
        abandonedBecause: 'session-moved' as const,
      })
    }

    const referenceTrack = session.tracks.find((track) => track.trackId === session.referenceTrackId)
    if (!referenceTrack) return failWith('the session has no reference track to measure against')

    const clockRecord = await dependencies.sessions.readClock({
      workspaceId: run.workspaceId,
      sessionId: run.sessionId,
    })
    const sessionTimebase = clockRecord?.timebase ?? session.clock.timebase
    const resolvedRate = resolveSessionFrameRate({ clock: clockRecord, referenceTrack })
    if (!resolvedRate) {
      return failWith(
        'insufficient evidence to name the session frame rate: no session clock is persisted and neither the ' +
        `reference track ${referenceTrack.trackId} nor any of its parts carries a timebase that is a frame duration`,
      )
    }
    const sessionFrameRate: Rational = resolvedRate.frameRate
    // The reference track's hull is measured in the reference track's own
    // ticks, and the session may count in another timebase entirely — a 90 kHz
    // session clock over a 1/25 camera is the ordinary case. Comparing the two
    // without converting made every coverage ratio in the cascade wrong by the
    // ratio of the clocks; it survived because every fixture so far gave the
    // reference track and the session the same timebase.
    const referenceBounds = trackBounds(referenceTrack)
    const sessionBounds = createTickInterval(
      convertTick({
        tick: referenceBounds.start, from: referenceTrack.timebase, to: sessionTimebase, rounding: 'floor',
      }),
      convertTick({
        tick: referenceBounds.end, from: referenceTrack.timebase, to: sessionTimebase, rounding: 'ceil',
      }),
    )
    const now = () => dependencies.clock().toISOString()

    let resolved = 0
    let review = 0
    let insufficient = 0

    // Coverage first, and for every track including the reference: the
    // diagnostic reads it per track (`application/sync-diagnostic.ts:358-361`)
    // and a reference track with a hole in it is exactly the case an operator
    // needs to see. No heartbeat in this loop on purpose — it is one derivation
    // and one small write per track, while the cascade below is FFmpeg time,
    // which is where a lease actually expires.
    for (const track of session.tracks) {
      try {
        const coverage = deriveTrackCoverage({ session, track })
        await dependencies.sessions.persistCoverage({
          coverage,
          sessionId: session.sessionId,
          createdAt: now(),
        })
        coverageDerived += 1
      } catch (error) {
        // Two parts claiming the same ticks is a fact about the recording that
        // only a human can resolve (`track-coverage.ts:466-470`). Refusing the
        // whole run over it would make one ambiguous card change block the
        // synchronization of every other camera, so the refusal is counted and
        // the track simply has no coverage row — which reads downstream as
        // "nobody measured this", never as "this track is empty".
        if (!(error instanceof DomainError)) throw error
        coverageRefused += 1
      }
    }

    for (const track of session.tracks) {
      if (track.trackId === session.referenceTrackId) continue

      // Heartbeat before each track AND from inside the measurement. A beat
      // taken only at the track boundary keeps a lease that is shorter than one
      // track's work exactly as long as the work is shorter than the lease,
      // which is a tautology and not a mechanism: the adapter awaits `beat`
      // between the pieces of work it can be interrupted between, so the lease
      // is refreshed while FFmpeg and the correlator run.
      let leaseAlive = true
      const beat = async () => {
        if (!leaseAlive) return
        leaseAlive = await dependencies.runs.heartbeat({
          workspaceId: run.workspaceId,
          runId: run.id,
          leaseToken,
          now: now(),
          leaseMs,
        })
      }
      const abandonForLostLease = () => Object.freeze({
        claimed: true, runId: run.id, workspaceId: run.workspaceId, settled: false,
        resolved, review, insufficient,
        coverageDerived, coverageRefused, mapRefused, mediaUnavailable,
        abandonedBecause: 'lease-lost' as const,
      })
      await beat()
      if (!leaseAlive) return abandonForLostLease()

      // A signal source that throws is not always a track with no evidence, and
      // not always a broken run either. The two are told apart by the error:
      //
      // A file that is absent, or is no longer the file the part was built
      // from, is a FACT about the session. One phone whose card was never
      // copied must not block the synchronization of the other five cameras —
      // the same argument the coverage loop above already makes for an
      // ambiguous card change. The track goes through the path it would have
      // taken with no observation at all and lands on `insufficient-evidence`.
      //
      // A codec that will not open, a materializer that cannot reach storage:
      // those are wrong with the RUN, and counting them as
      // `insufficient-evidence` would file "we listened and heard nothing" over
      // "we never listened". Settled failed rather than left to the lease: an
      // exception escaping here would leave the run claimed until the lease
      // expired, be reclaimed, and fail the same way until the attempts ran out.
      let signals: readonly Readonly<SyncSignalObservation>[]
      try {
        signals = await dependencies.signals.observe({
          session,
          track,
          referenceTrack,
          sessionTimebase,
          sessionFrameRate,
          sessionBounds,
          heartbeat: beat,
        })
      } catch (error) {
        if (!isAbsentMediaError(error)) {
          return failWith(
            `the sync signal source failed on track ${track.trackId}: ${error instanceof Error ? error.message : String(error)}`,
          )
        }
        mediaUnavailable += 1
        signals = []
      }
      // The lease can only have been lost while the measurement ran, and a
      // measurement whose claim is gone must not be filed: another worker holds
      // the run and its answer is the one that counts.
      if (!leaseAlive) return abandonForLostLease()
      const record = evaluateSyncEvidence({
        sessionId: session.sessionId,
        trackId: track.trackId,
        referenceTrackId: session.referenceTrackId,
        sessionTimebase,
        sessionFrameRate,
        sessionBounds,
        signals,
      })
      await dependencies.sessions.persistSyncEvidence({
        workspaceId: run.workspaceId,
        record,
        createdAt: now(),
      })

      if (record.outcome === 'insufficient-evidence') {
        insufficient += 1
        // Deliberately no map. "We could not tell" and "we measured zero" are
        // different answers, and writing an identity map here would erase the
        // difference for everything downstream.
        continue
      }
      if (record.outcome === 'auto-apply') resolved += 1
      else review += 1

      // Refused rather than thrown, for the reason the coverage loop states:
      // parts the domain will not accept as a legal map are a fact about one
      // recording. Letting the DomainError escape left the run claimed and
      // NEVER settled — no status, no failure reason — and killed the `--once`
      // driver on an unhandled rejection.
      try {
        const pieces = buildMapPieces({
          track,
          record,
          session,
          sessionClockId: clockRecord?.clockHash ?? session.sessionHash,
        })
        if (pieces.length === 0) continue
        const map = createPiecewiseClockMap({
          workspaceId: run.workspaceId,
          sessionId: session.sessionId,
          sourceId: track.sourceAssetId,
          clock: createSessionClock({
            sessionId: session.sessionId,
            timebase: sessionTimebase,
            frameRate: sessionFrameRate,
            authority: {
              origin: 'primary-camera',
              sourceId: session.referenceTrackId,
              provenance: 'original-capture',
              evidenceRef: clockRecord?.clockHash ?? session.sessionHash,
            },
            establishedAt: session.createdAt,
          }),
          derivedFrom: {
            sessionVersion: session.version,
            referenceEpoch: session.referenceEpoch,
          },
          pieces,
        })
        await dependencies.sessions.persistClockMap({ map, createdAt: now() })
      } catch (error) {
        if (!(error instanceof DomainError)) throw error
        mapRefused += 1
      }
    }

    const settlement = await dependencies.runs.settle({
      workspaceId: run.workspaceId,
      runId: run.id,
      leaseToken,
      now: now(),
      outcome: {
        status: 'succeeded',
        resolvedCount: resolved,
        reviewCount: review,
        insufficientCount: insufficient,
      },
    })
    return Object.freeze({
      claimed: true,
      runId: run.id,
      workspaceId: run.workspaceId,
      settled: settlement.settled,
      resolved,
      review,
      insufficient,
      coverageDerived,
      coverageRefused,
      mapRefused,
      mediaUnavailable,
      ...(settlement.settled ? {} : { abandonedBecause: settlement.reason === 'superseded' ? 'superseded' as const : 'lease-lost' as const }),
    })
  }
}
