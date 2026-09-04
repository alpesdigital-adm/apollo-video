import {
  createSessionClock,
  createSourceClock,
  createSourceToSessionMapping,
  type ClockConfidence,
} from '../domain/session-clock.ts'
import {
  createTickInterval,
  rational,
  type Rational,
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

/** Where a track's candidate sync signals come from. Never a paid provider. */
export interface SyncSignalSource {
  observe(input: {
    session: Readonly<CaptureSession>
    track: Readonly<CaptureTrack>
    referenceTrack: Readonly<CaptureTrack>
  }): Promise<readonly Readonly<SyncSignalObservation>[]>
}

export interface CaptureSyncWorkerResult {
  readonly claimed: boolean
  readonly runId: string | null
  readonly settled: boolean
  readonly resolved: number
  readonly review: number
  readonly insufficient: number
  readonly abandonedBecause?: 'lease-lost' | 'superseded' | 'session-moved'
}

const DEFAULT_LEASE_MS = 60_000

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
      })
    }

    const { run, leaseToken } = claim
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
    const sessionFrameRate: Rational = clockRecord?.frameRate ?? rational(BigInt(30_000), BigInt(1_001))
    const sessionBounds = trackBounds(referenceTrack)
    const now = () => dependencies.clock().toISOString()

    let resolved = 0
    let review = 0
    let insufficient = 0

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
          abandonedBecause: 'lease-lost' as const,
        })
      }

      const signals = await dependencies.signals.observe({ session, track, referenceTrack })
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
      ...(settlement.settled ? {} : { abandonedBecause: settlement.reason === 'superseded' ? 'superseded' as const : 'lease-lost' as const }),
    })
  }
}
