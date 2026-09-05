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
import type { CaptureSession, CaptureTrack } from '../domain/capture-session.ts'
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
  }): Promise<readonly Readonly<SyncSignalObservation>[]>
}

export interface CaptureSyncWorkerResult {
  readonly claimed: boolean
  readonly runId: string | null
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
  readonly abandonedBecause?: 'lease-lost' | 'superseded' | 'session-moved'
}

const DEFAULT_LEASE_MS = 60_000

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
 * Turn one cascade verdict into a piecewise map.
 *
 * A track whose recorder restarted gets one piece per part, because the gap
 * between two files is time the recorder was not producing — and a single
 * affine law spanning that gap would resolve ticks inside it, which is exactly
 * the interpolation F4.007 exists to refuse.
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
  const confidence: ClockConfidence = record.outcome === 'auto-apply' ? 'high' : 'medium'
  const evidenceRefs = record.assessments
    .filter((assessment) => assessment.signalId === record.selectedSignalId)
    .map((assessment) => assessment.signalId)
  const anchorIds = evidenceRefs.length > 0 ? evidenceRefs : [record.selectedSignalId ?? '']

  const ordered = [...track.parts].sort((left, right) => left.ordinal - right.ordinal)
  return ordered.map((part, index) => ({
    pieceId: `${track.trackId}-piece-${part.ordinal}`,
    mapping: createSourceToSessionMapping({
      clock,
      source,
      sourceCoverage: part.coverage,
      driftRate: rational(record.clockMap!.rate.num, record.clockMap!.rate.den),
      offsetTicks: record.clockMap!.offsetTicks,
      residualBoundTicks: BigInt(0),
      confidence,
      anchorIds: anchorIds.filter((id) => id.length > 0),
      evidenceRefs: anchorIds.filter((id) => id.length > 0),
    }),
    ...(index === 0
      ? {}
      : {
        // The recorder said why it split, and that reason is carried through
        // rather than re-derived: a file-size limit and a card change look
        // identical in the timestamps and are different facts to an operator.
        openedBy: part.splitReason === 'single-file' ? 'file-split' as const
          : part.splitReason === 'recorder-restart' ? 'recorder-restart' as const
            : part.splitReason === 'card-change' ? 'recorder-restart' as const
              : 'file-split' as const,
        openedByDetail: `recorder wrote part ${part.ordinal} after a ${part.splitReason.replace(/-/g, ' ')}`,
      }),
  }))
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
        claimed: false, runId: null, settled: false, resolved: 0, review: 0, insufficient: 0,
        coverageDerived: 0, coverageRefused: 0,
      })
    }

    const { run, leaseToken } = claim
    // Declared before the failure path so a run that fails halfway still
    // reports the coverage it had already derived and written: those rows are
    // real, and saying zero would make the failure look total when it was not.
    let coverageDerived = 0
    let coverageRefused = 0
    const failWith = async (reason: string) => {
      await dependencies.runs.settle({
        workspaceId: run.workspaceId,
        runId: run.id,
        leaseToken,
        now: dependencies.clock().toISOString(),
        outcome: { status: 'failed', failureReason: reason },
      })
      return Object.freeze({
        claimed: true, runId: run.id, settled: true, resolved: 0, review: 0, insufficient: 0,
        coverageDerived, coverageRefused,
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
        claimed: true, runId: run.id, settled: true, resolved: 0, review: 0, insufficient: 0,
        coverageDerived: 0, coverageRefused: 0,
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

      // Heartbeat before each track rather than only at the end: a worker that
      // has lost its lease should stop as soon as it can find out, not after
      // finishing work nobody will accept.
      const alive = await dependencies.runs.heartbeat({
        workspaceId: run.workspaceId,
        runId: run.id,
        leaseToken,
        now: now(),
        leaseMs,
      })
      if (!alive) {
        return Object.freeze({
          claimed: true, runId: run.id, settled: false, resolved, review, insufficient,
          coverageDerived, coverageRefused,
          abandonedBecause: 'lease-lost' as const,
        })
      }

      // A signal source that throws is not a track with no evidence. A codec
      // that will not open, a materializer that cannot reach storage — those
      // are wrong with the run, and counting them as `insufficient-evidence`
      // would file "we listened and heard nothing" over "we never listened".
      // Settled failed rather than left to the lease: an exception escaping
      // here would leave the run claimed until the lease expired, be reclaimed,
      // and fail the same way until the attempts ran out.
      let signals: readonly Readonly<SyncSignalObservation>[]
      try {
        signals = await dependencies.signals.observe({
          session,
          track,
          referenceTrack,
          sessionTimebase,
          sessionFrameRate,
          sessionBounds,
        })
      } catch (error) {
        return failWith(
          `the sync signal source failed on track ${track.trackId}: ${error instanceof Error ? error.message : String(error)}`,
        )
      }
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
      settled: settlement.settled,
      resolved,
      review,
      insufficient,
      coverageDerived,
      coverageRefused,
      ...(settlement.settled ? {} : { abandonedBecause: settlement.reason === 'superseded' ? 'superseded' as const : 'lease-lost' as const }),
    })
  }
}
