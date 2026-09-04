import type { CaptureSession, CaptureSessionHead } from '../../domain/capture-session.ts'
import type { PiecewiseClockMap } from '../../domain/piecewise-clock-map.ts'
import type { SessionClock } from '../../domain/session-clock.ts'
import type { SyncEvidenceRecord } from '../../domain/sync-evidence.ts'
import type { TrackCoverage } from '../../domain/track-coverage.ts'

/**
 * Persistence for a capture session and everything derived from it (F4.002–
 * F4.007).
 *
 * A session is an immutable chain plus a mutable pointer, and that shape is
 * visible here on purpose. `appendVersion` writes one link and advances the
 * head in a single transaction, guarded by the version it expected to be
 * replacing; two operations racing on the same session cannot both win, and the
 * loser is told which version it lost to rather than being silently applied to
 * a session that has moved underneath it.
 *
 * Everything derived — clock, maps, coverage, evidence, drift — is written
 * against the exact session version and reference epoch it was derived from.
 * Reads refuse a derivation whose session has moved on rather than returning a
 * stale answer that looks current.
 */
export interface CaptureSessionRepository {
  /**
   * Append one version to the chain and advance the head.
   *
   * `expectedVersion` is the version the caller believed was current; omit it
   * only when creating the session. A mismatch is a conflict, not a retry: the
   * caller's operation was computed against a session that no longer exists.
   */
  appendVersion(input: {
    session: Readonly<CaptureSession>
    expectedVersion?: number
    occurredAt: string
  }): Promise<Readonly<{ head: Readonly<CaptureSessionHead>; replayed: boolean }>>

  /** The current version of a session, or null when there is none. */
  readHead(input: {
    workspaceId: string
    sessionId: string
  }): Promise<Readonly<CaptureSession> | null>

  /** One specific version of the chain, by number. */
  readVersion(input: {
    workspaceId: string
    sessionId: string
    version: number
  }): Promise<Readonly<CaptureSession> | null>

  /**
   * Walk the chain back from the head.
   *
   * Returned newest first, so the caller sees the same order an operator reads
   * a history in. Each entry carries `previousVersionHash`, so a gap in the
   * chain is detectable rather than merely improbable.
   */
  listVersions(input: {
    workspaceId: string
    sessionId: string
    limit?: number
  }): Promise<readonly Readonly<CaptureSession>[]>

  listHeads(input: {
    workspaceId: string
    projectId: string
    limit?: number
  }): Promise<readonly Readonly<CaptureSessionHead & { status: string; projectId: string }>[]>

  persistClock(input: {
    workspaceId: string
    clock: Readonly<SessionClock>
    createdAt: string
  }): Promise<Readonly<{ clock: Readonly<SessionClock>; replayed: boolean }>>

  readClock(input: {
    workspaceId: string
    sessionId: string
  }): Promise<Readonly<SessionClock> | null>

  /**
   * Store a piecewise map, replacing any earlier map for the same source.
   *
   * Replacement rather than accumulation: a map is the current answer for one
   * source, and keeping two would leave callers to decide which is true. The
   * superseded map's evidence survives in the sync record it came from.
   */
  persistClockMap(input: {
    map: Readonly<PiecewiseClockMap>
    createdAt: string
  }): Promise<Readonly<{ map: Readonly<PiecewiseClockMap>; replayed: boolean }>>

  readClockMap(input: {
    workspaceId: string
    sessionId: string
    sourceId: string
  }): Promise<Readonly<PiecewiseClockMap> | null>

  listClockMaps(input: {
    workspaceId: string
    sessionId: string
  }): Promise<readonly Readonly<PiecewiseClockMap>[]>

  persistCoverage(input: {
    coverage: Readonly<TrackCoverage>
    sessionId: string
    createdAt: string
  }): Promise<Readonly<{ coverage: Readonly<TrackCoverage>; replayed: boolean }>>

  readCoverage(input: {
    workspaceId: string
    trackId: string
  }): Promise<Readonly<TrackCoverage> | null>

  listCoverage(input: {
    workspaceId: string
    sessionId: string
  }): Promise<readonly Readonly<TrackCoverage>[]>

  persistSyncEvidence(input: {
    workspaceId: string
    record: Readonly<SyncEvidenceRecord>
    createdAt: string
  }): Promise<Readonly<{ record: Readonly<SyncEvidenceRecord>; replayed: boolean }>>

  readSyncEvidence(input: {
    workspaceId: string
    sessionId: string
    trackId: string
  }): Promise<Readonly<SyncEvidenceRecord> | null>

  listSyncEvidence(input: {
    workspaceId: string
    sessionId: string
  }): Promise<readonly Readonly<SyncEvidenceRecord>[]>
}
