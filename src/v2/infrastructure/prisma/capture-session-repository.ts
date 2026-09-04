import type { PrismaClient } from '../../../../generated/prisma-v2/index.js'

import type { CaptureSessionRepository } from '../../application/ports/capture-session-repository.ts'
import { calculateCanonicalHash } from '../../domain/canonical-hash.ts'
import {
  assertCaptureSessionIntegrity,
  CAPTURE_SESSION_SCHEMA_VERSION,
  captureSessionHead,
  type CaptureSession,
  type CaptureSessionDerivation,
  type CaptureSessionHead,
  type CaptureSessionOperation,
  type CaptureSessionStatus,
  type CaptureTrack,
} from '../../domain/capture-session.ts'
import { DomainError } from '../../domain/errors.ts'
import {
  assertPiecewiseClockMapIntegrity,
  PIECEWISE_CLOCK_MAP_SCHEMA_VERSION,
  type ClockMapPiece,
  type PieceBoundary,
  type PieceBoundaryCause,
  type PiecewiseClockMap,
} from '../../domain/piecewise-clock-map.ts'
import {
  assertSessionClockIntegrity,
  SESSION_CLOCK_SCHEMA_VERSION,
  type ClockConfidence,
  type SessionClock,
} from '../../domain/session-clock.ts'
import {
  createTickInterval,
  createTimebase,
  rational,
  type RoundingPolicy,
  type TickInterval,
} from '../../domain/session-time.ts'
import {
  serializeSyncEvidenceRecord,
  SYNC_EVIDENCE_SCHEMA_VERSION,
  type SyncEvidenceRecord,
} from '../../domain/sync-evidence.ts'
import {
  assertTrackCoverageIntegrity,
  TRACK_COVERAGE_SCHEMA_VERSION,
  type CoverageInterval,
  type CoverageOverlapDecision,
  type RecorderSplit,
  type TrackCoverage,
} from '../../domain/track-coverage.ts'
import { getV2PostgresClient } from '../prisma-postgres/client.ts'
import { parseWithTicks, stringifyWithTicks } from './bigint-json.ts'

function isPrismaCode(error: unknown, code: string): boolean {
  return typeof error === 'object' && error !== null && 'code' in error && error.code === code
}

function conflict(message: string): never {
  throw new DomainError('PERSISTENCE_CONFLICT', message)
}

function decode<T>(json: string, what: string): T {
  try {
    return parseWithTicks(json) as T
  } catch {
    return conflict(`Stored ${what} is not valid tick-safe JSON`)
  }
}

/**
 * A `SyncEvidenceRecord` is the one Wave 18 aggregate that carries no hash of
 * its own: the cascade produces a verdict, not a content address.
 *
 * Storing it without one would leave the only mutable audit trail in the wave
 * unguarded — the assessments are what justify the offset that ends up in the
 * cut. So the repository hashes the module's own canonical serialization on the
 * way in and re-checks it on the way out. The hash belongs to persistence
 * rather than to the domain, and this is the only place that knows it exists.
 */
function evidenceHashOf(record: Readonly<SyncEvidenceRecord>): string {
  return calculateCanonicalHash(serializeSyncEvidenceRecord(record))
}

export class PrismaCaptureSessionRepository implements CaptureSessionRepository {
  constructor(private readonly client: PrismaClient = getV2PostgresClient()) {}

  // -------------------------------------------------------------------------
  // The immutable chain and its pointer
  // -------------------------------------------------------------------------

  async appendVersion(input: {
    session: Readonly<CaptureSession>
    expectedVersion?: number
    occurredAt: string
  }): Promise<Readonly<{ head: Readonly<CaptureSessionHead>; replayed: boolean }>> {
    const { session } = input
    const head = captureSessionHead(session)
    const versionRow = {
      id: `${session.sessionId}:v${session.version}`,
      workspaceId: session.workspaceId,
      projectId: session.projectId,
      sessionId: session.sessionId,
      schemaVersion: session.schemaVersion,
      version: session.version,
      previousVersionHash: session.previousVersionHash,
      status: session.status,
      clockTimebaseNum: session.clock.timebase.secondsPerTick.num,
      clockTimebaseDen: session.clock.timebase.secondsPerTick.den,
      clockRounding: session.clock.rounding,
      referenceTrackId: session.referenceTrackId,
      referenceEpoch: session.referenceEpoch,
      tracksJson: stringifyWithTicks(session.tracks),
      trackCount: session.tracks.length,
      staleDerivationsJson: JSON.stringify([...session.staleDerivations]),
      commandId: session.lineage.commandId,
      operation: session.lineage.operation,
      actorKind: session.lineage.actorKind,
      actorId: session.lineage.actorId,
      occurredAt: new Date(session.lineage.occurredAt),
      note: session.lineage.note,
      sessionHash: session.sessionHash,
      createdAt: new Date(session.createdAt),
    }

    try {
      await this.client.$transaction(async (transaction) => {
        await transaction.v2CaptureSessionVersion.create({ data: versionRow })
        if (session.version === 1) {
          await transaction.v2CaptureSessionHead.create({
            data: {
              id: session.sessionId,
              workspaceId: session.workspaceId,
              projectId: session.projectId,
              sessionId: session.sessionId,
              version: session.version,
              sessionHash: session.sessionHash,
              status: session.status,
              createdAt: new Date(input.occurredAt),
              updatedAt: new Date(input.occurredAt),
            },
          })
          return
        }
        // Advance the pointer only if it still points where the caller thought.
        // `updateMany` with the expected version in the predicate makes this one
        // statement rather than a read followed by a write, so two operations
        // racing on the same session cannot both observe version N and both
        // write N+1.
        const expected = input.expectedVersion ?? session.version - 1
        const advanced = await transaction.v2CaptureSessionHead.updateMany({
          where: {
            workspaceId: session.workspaceId,
            sessionId: session.sessionId,
            version: expected,
          },
          data: {
            version: session.version,
            sessionHash: session.sessionHash,
            status: session.status,
            updatedAt: new Date(input.occurredAt),
          },
        })
        if (advanced.count !== 1) {
          conflict(
            `Capture session ${session.sessionId} moved on: expected version ${expected} to be current`,
          )
        }
      })
      return Object.freeze({ head, replayed: false })
    } catch (error) {
      if (!isPrismaCode(error, 'P2002')) throw error
      // The same version number is already stored. Identical bytes are a
      // replay of a command that already landed; different bytes mean two
      // different operations claimed the same link in the chain, and picking
      // one would silently discard the other.
      const stored = await this.readVersion({
        workspaceId: session.workspaceId,
        sessionId: session.sessionId,
        version: session.version,
      })
      if (stored && stored.sessionHash === session.sessionHash) {
        return Object.freeze({ head: captureSessionHead(stored), replayed: true })
      }
      return conflict(
        `Capture session ${session.sessionId} already has a different version ${session.version}`,
      )
    }
  }

  async readHead(input: {
    workspaceId: string
    sessionId: string
  }): Promise<Readonly<CaptureSession> | null> {
    const head = await this.client.v2CaptureSessionHead.findFirst({
      where: { workspaceId: input.workspaceId, sessionId: input.sessionId },
      select: { version: true },
    })
    if (!head) return null
    return this.readVersion({ ...input, version: head.version })
  }

  async readVersion(input: {
    workspaceId: string
    sessionId: string
    version: number
  }): Promise<Readonly<CaptureSession> | null> {
    const row = await this.client.v2CaptureSessionVersion.findFirst({
      where: {
        workspaceId: input.workspaceId,
        sessionId: input.sessionId,
        version: input.version,
      },
    })
    return row ? this.hydrateSession(row) : null
  }

  async listVersions(input: {
    workspaceId: string
    sessionId: string
    limit?: number
  }): Promise<readonly Readonly<CaptureSession>[]> {
    const rows = await this.client.v2CaptureSessionVersion.findMany({
      where: { workspaceId: input.workspaceId, sessionId: input.sessionId },
      orderBy: { version: 'desc' },
      take: Math.min(Math.max(input.limit ?? 25, 1), 200),
    })
    return Object.freeze(rows.map((row) => this.hydrateSession(row)))
  }

  async listHeads(input: {
    workspaceId: string
    projectId: string
    limit?: number
  }): Promise<readonly Readonly<CaptureSessionHead & { status: string; projectId: string }>[]> {
    const rows = await this.client.v2CaptureSessionHead.findMany({
      where: { workspaceId: input.workspaceId, projectId: input.projectId },
      orderBy: { updatedAt: 'desc' },
      take: Math.min(Math.max(input.limit ?? 25, 1), 100),
    })
    return Object.freeze(rows.map((row) => Object.freeze({
      workspaceId: row.workspaceId,
      sessionId: row.sessionId,
      version: row.version,
      sessionHash: row.sessionHash,
      status: row.status,
      projectId: row.projectId,
    })))
  }

  private hydrateSession(row: {
    workspaceId: string
    projectId: string
    sessionId: string
    schemaVersion: string
    version: number
    previousVersionHash: string | null
    status: string
    clockTimebaseNum: bigint
    clockTimebaseDen: bigint
    clockRounding: string
    referenceTrackId: string
    referenceEpoch: number
    tracksJson: string
    staleDerivationsJson: string
    commandId: string
    operation: string
    actorKind: string
    actorId: string
    occurredAt: Date
    note: string | null
    sessionHash: string
    createdAt: Date
  }): Readonly<CaptureSession> {
    if (row.schemaVersion !== CAPTURE_SESSION_SCHEMA_VERSION) {
      conflict(`Stored capture session ${row.sessionId} carries an unknown schema version`)
    }
    const session: CaptureSession = {
      schemaVersion: CAPTURE_SESSION_SCHEMA_VERSION,
      workspaceId: row.workspaceId,
      projectId: row.projectId,
      sessionId: row.sessionId,
      version: row.version,
      previousVersionHash: row.previousVersionHash,
      status: row.status as CaptureSessionStatus,
      clock: Object.freeze({
        timebase: createTimebase(rational(row.clockTimebaseNum, row.clockTimebaseDen)),
        rounding: row.clockRounding as RoundingPolicy,
      }),
      referenceTrackId: row.referenceTrackId,
      referenceEpoch: row.referenceEpoch,
      tracks: Object.freeze(decode<CaptureTrack[]>(row.tracksJson, `capture session ${row.sessionId} tracks`)),
      lineage: Object.freeze({
        commandId: row.commandId,
        operation: row.operation as CaptureSessionOperation,
        actorKind: row.actorKind as CaptureSession['lineage']['actorKind'],
        actorId: row.actorId,
        occurredAt: row.occurredAt.toISOString(),
        note: row.note,
      }),
      staleDerivations: Object.freeze(
        JSON.parse(row.staleDerivationsJson) as CaptureSessionDerivation[],
      ),
      createdAt: row.createdAt.toISOString(),
      sessionHash: row.sessionHash,
    }
    // Rebuilding from columns and comparing the hash is what makes a column
    // edited behind the aggregate's back fail here rather than in an edit.
    return assertCaptureSessionIntegrity(Object.freeze(session))
  }

  // -------------------------------------------------------------------------
  // F4.003 — the session clock
  // -------------------------------------------------------------------------

  async persistClock(input: {
    workspaceId: string
    clock: Readonly<SessionClock>
    createdAt: string
  }): Promise<Readonly<{ clock: Readonly<SessionClock>; replayed: boolean }>> {
    const { clock } = input
    try {
      await this.client.v2CaptureSessionClock.create({
        data: {
          id: `${clock.sessionId}:clock`,
          workspaceId: input.workspaceId,
          sessionId: clock.sessionId,
          schemaVersion: clock.schemaVersion,
          timebaseNum: clock.timebase.secondsPerTick.num,
          timebaseDen: clock.timebase.secondsPerTick.den,
          frameRateNum: clock.frameRate.num,
          frameRateDen: clock.frameRate.den,
          authorityOrigin: clock.authority.origin,
          authoritySourceId: clock.authority.sourceId,
          authorityProvenance: clock.authority.provenance,
          authorityEvidence: clock.authority.evidenceRef,
          establishedAt: new Date(clock.establishedAt),
          clockHash: clock.clockHash,
          createdAt: new Date(input.createdAt),
        },
      })
      return Object.freeze({ clock, replayed: false })
    } catch (error) {
      if (!isPrismaCode(error, 'P2002')) throw error
      const stored = await this.readClock({ workspaceId: input.workspaceId, sessionId: clock.sessionId })
      if (stored && stored.clockHash === clock.clockHash) {
        return Object.freeze({ clock: stored, replayed: true })
      }
      // Re-establishing a session clock moves every timestamp in the session.
      // It is a decision, not an overwrite, and it does not happen here.
      return conflict(
        `Capture session ${clock.sessionId} already has a different session clock`,
      )
    }
  }

  async readClock(input: {
    workspaceId: string
    sessionId: string
  }): Promise<Readonly<SessionClock> | null> {
    const row = await this.client.v2CaptureSessionClock.findFirst({
      where: { workspaceId: input.workspaceId, sessionId: input.sessionId },
    })
    if (!row) return null
    if (row.schemaVersion !== SESSION_CLOCK_SCHEMA_VERSION) {
      conflict(`Stored session clock for ${input.sessionId} carries an unknown schema version`)
    }
    const clock: SessionClock = {
      schemaVersion: SESSION_CLOCK_SCHEMA_VERSION,
      sessionId: row.sessionId,
      timebase: createTimebase(rational(row.timebaseNum, row.timebaseDen)),
      frameRate: rational(row.frameRateNum, row.frameRateDen),
      authority: Object.freeze({
        origin: row.authorityOrigin as SessionClock['authority']['origin'],
        sourceId: row.authoritySourceId,
        provenance: row.authorityProvenance as SessionClock['authority']['provenance'],
        evidenceRef: row.authorityEvidence,
      }),
      establishedAt: row.establishedAt.toISOString(),
      clockHash: row.clockHash,
    }
    return assertSessionClockIntegrity(Object.freeze(clock))
  }

  // -------------------------------------------------------------------------
  // F4.007 — piecewise source → session maps
  // -------------------------------------------------------------------------

  async persistClockMap(input: {
    map: Readonly<PiecewiseClockMap>
    createdAt: string
  }): Promise<Readonly<{ map: Readonly<PiecewiseClockMap>; replayed: boolean }>> {
    const { map } = input
    const existing = await this.readClockMap({
      workspaceId: map.workspaceId,
      sessionId: map.sessionId,
      sourceId: map.sourceId,
    })
    if (existing && existing.mapHash === map.mapHash) {
      return Object.freeze({ map: existing, replayed: true })
    }

    const mapId = `${map.sessionId}:${map.sourceId}`
    await this.client.$transaction(async (transaction) => {
      // A map is the current answer for one source. Two of them would leave
      // callers to decide which is true, so the old one goes; the evidence that
      // produced it survives in its sync record.
      await transaction.v2CaptureClockMap.deleteMany({
        where: { workspaceId: map.workspaceId, id: mapId },
      })
      await transaction.v2CaptureClockMap.create({
        data: {
          id: mapId,
          workspaceId: map.workspaceId,
          sessionId: map.sessionId,
          sourceId: map.sourceId,
          schemaVersion: map.schemaVersion,
          derivedSessionVersion: map.derivedFrom.sessionVersion,
          derivedReferenceEpoch: map.derivedFrom.referenceEpoch,
          sourceBoundsStart: map.sourceBounds.start,
          sourceBoundsEnd: map.sourceBounds.end,
          uncoveredJson: stringifyWithTicks(map.uncovered),
          boundariesJson: stringifyWithTicks(map.boundaries),
          pieceCount: map.pieces.length,
          mapHash: map.mapHash,
          createdAt: new Date(input.createdAt),
        },
      })
      await transaction.v2CaptureClockMapPiece.createMany({
        data: map.pieces.map((piece) => ({
          id: `${mapId}:${piece.pieceId}`,
          workspaceId: map.workspaceId,
          mapId,
          pieceId: piece.pieceId,
          ordinal: piece.ordinal,
          sourceStartTicks: piece.sourceCoverage.start,
          sourceEndTicks: piece.sourceCoverage.end,
          sessionStartTicks: piece.sessionCoverage.start,
          sessionEndTicks: piece.sessionCoverage.end,
          rateNum: piece.map.rate.num,
          rateDen: piece.map.rate.den,
          offsetTicks: piece.map.offsetTicks,
          rounding: piece.map.rounding,
          driftPpm: piece.driftPpm,
          confidence: piece.confidence,
          residualBoundTicks: piece.residualBoundTicks,
          openedBy: piece.openedBy,
          openedByDetail: piece.openedByDetail,
          anchorIdsJson: JSON.stringify([...piece.anchorIds]),
          evidenceRefsJson: JSON.stringify([...piece.evidenceRefs]),
          anchorCount: piece.anchorIds.length,
          evidenceCount: piece.evidenceRefs.length,
        })),
      })
    })
    return Object.freeze({ map, replayed: false })
  }

  async readClockMap(input: {
    workspaceId: string
    sessionId: string
    sourceId: string
  }): Promise<Readonly<PiecewiseClockMap> | null> {
    const row = await this.client.v2CaptureClockMap.findFirst({
      where: {
        workspaceId: input.workspaceId,
        sessionId: input.sessionId,
        sourceId: input.sourceId,
      },
      include: { pieces: { orderBy: { ordinal: 'asc' } } },
    })
    return row ? this.hydrateClockMap(row) : null
  }

  async listClockMaps(input: {
    workspaceId: string
    sessionId: string
  }): Promise<readonly Readonly<PiecewiseClockMap>[]> {
    const rows = await this.client.v2CaptureClockMap.findMany({
      where: { workspaceId: input.workspaceId, sessionId: input.sessionId },
      orderBy: { sourceId: 'asc' },
      include: { pieces: { orderBy: { ordinal: 'asc' } } },
    })
    return Object.freeze(rows.map((row) => this.hydrateClockMap(row)))
  }

  private hydrateClockMap(row: {
    workspaceId: string
    sessionId: string
    sourceId: string
    schemaVersion: string
    derivedSessionVersion: number
    derivedReferenceEpoch: number
    sourceBoundsStart: bigint
    sourceBoundsEnd: bigint
    uncoveredJson: string
    boundariesJson: string
    mapHash: string
    pieces: readonly {
      pieceId: string
      ordinal: number
      sourceStartTicks: bigint
      sourceEndTicks: bigint
      sessionStartTicks: bigint
      sessionEndTicks: bigint
      rateNum: bigint
      rateDen: bigint
      offsetTicks: bigint
      rounding: string
      driftPpm: number
      confidence: string
      residualBoundTicks: bigint
      openedBy: string | null
      openedByDetail: string | null
      anchorIdsJson: string
      evidenceRefsJson: string
    }[]
  }): Readonly<PiecewiseClockMap> {
    if (row.schemaVersion !== PIECEWISE_CLOCK_MAP_SCHEMA_VERSION) {
      conflict(`Stored clock map for ${row.sourceId} carries an unknown schema version`)
    }
    const pieces: ClockMapPiece[] = row.pieces.map((piece) => Object.freeze({
      pieceId: piece.pieceId,
      ordinal: piece.ordinal,
      sourceCoverage: createTickInterval(piece.sourceStartTicks, piece.sourceEndTicks),
      sessionCoverage: createTickInterval(piece.sessionStartTicks, piece.sessionEndTicks),
      map: Object.freeze({
        rate: rational(piece.rateNum, piece.rateDen),
        offsetTicks: piece.offsetTicks,
        rounding: piece.rounding as RoundingPolicy,
      }),
      driftPpm: piece.driftPpm,
      confidence: piece.confidence as ClockConfidence,
      residualBoundTicks: piece.residualBoundTicks,
      openedBy: piece.openedBy as PieceBoundaryCause | null,
      openedByDetail: piece.openedByDetail,
      anchorIds: Object.freeze(JSON.parse(piece.anchorIdsJson) as string[]),
      evidenceRefs: Object.freeze(JSON.parse(piece.evidenceRefsJson) as string[]),
    }))
    const map: PiecewiseClockMap = {
      schemaVersion: PIECEWISE_CLOCK_MAP_SCHEMA_VERSION,
      workspaceId: row.workspaceId,
      sessionId: row.sessionId,
      sourceId: row.sourceId,
      derivedFrom: Object.freeze({
        sessionVersion: row.derivedSessionVersion,
        referenceEpoch: row.derivedReferenceEpoch,
      }),
      pieces: Object.freeze(pieces),
      boundaries: Object.freeze(
        decode<PieceBoundary[]>(row.boundariesJson, `clock map ${row.sourceId} boundaries`),
      ),
      sourceBounds: createTickInterval(row.sourceBoundsStart, row.sourceBoundsEnd),
      uncovered: Object.freeze(
        decode<TickInterval[]>(row.uncoveredJson, `clock map ${row.sourceId} uncovered ranges`),
      ),
      mapHash: row.mapHash,
    }
    return assertPiecewiseClockMapIntegrity(Object.freeze(map))
  }

  // -------------------------------------------------------------------------
  // F4.005 — coverage
  // -------------------------------------------------------------------------

  async persistCoverage(input: {
    coverage: Readonly<TrackCoverage>
    sessionId: string
    createdAt: string
  }): Promise<Readonly<{ coverage: Readonly<TrackCoverage>; replayed: boolean }>> {
    const { coverage } = input
    const covered = coverage.available.reduce(
      (total, span) => total + (span.interval.end - span.interval.start),
      BigInt(0),
    )
    const gapTicks = coverage.gaps.reduce(
      (total, span) => total + (span.interval.end - span.interval.start),
      BigInt(0),
    )
    const minConfidenceBps = coverage.available.length === 0
      ? 0
      : Math.min(...coverage.available.map((span) => span.confidenceBps))
    const unresolvedOverlaps = coverage.overlaps.filter(
      (overlap) => overlap.resolution === 'manual-review',
    ).length

    const data = {
      id: `${coverage.trackId}:coverage`,
      workspaceId: coverage.workspaceId,
      sessionId: input.sessionId,
      trackId: coverage.trackId,
      schemaVersion: coverage.schemaVersion,
      derivedSessionVersion: coverage.derivedFrom.sessionVersion,
      derivedReferenceEpoch: coverage.derivedFrom.referenceEpoch,
      timebaseNum: coverage.timebase.secondsPerTick.num,
      timebaseDen: coverage.timebase.secondsPerTick.den,
      boundsStart: coverage.bounds.start,
      boundsEnd: coverage.bounds.end,
      availableJson: stringifyWithTicks(coverage.available),
      gapsJson: stringifyWithTicks(coverage.gaps),
      corruptJson: stringifyWithTicks(coverage.corrupt),
      unverifiedJson: stringifyWithTicks(coverage.unverified),
      overlapsJson: stringifyWithTicks(coverage.overlaps),
      recorderSplitsJson: stringifyWithTicks(coverage.recorderSplits),
      coveredTicks: covered,
      gapTicks,
      minConfidenceBps,
      // Derived once here rather than recomputed on read: the flag and the
      // numbers beside it must agree, and re-deriving one of them later is how
      // they stop agreeing.
      autoEditable: minConfidenceBps >= 7_000 && unresolvedOverlaps === 0,
      unresolvedOverlaps,
      coverageHash: coverage.coverageHash,
      createdAt: new Date(input.createdAt),
    }

    // Coverage is a derivation, not a fact about the world: recomputing it for
    // a newer session version legitimately replaces the older answer.
    const stored = await this.client.v2CaptureTrackCoverage.upsert({
      where: { workspaceId_trackId: { workspaceId: coverage.workspaceId, trackId: coverage.trackId } },
      create: data,
      update: data,
      select: { coverageHash: true },
    })
    return Object.freeze({ coverage, replayed: stored.coverageHash === coverage.coverageHash })
  }

  async readCoverage(input: {
    workspaceId: string
    trackId: string
  }): Promise<Readonly<TrackCoverage> | null> {
    const row = await this.client.v2CaptureTrackCoverage.findFirst({
      where: { workspaceId: input.workspaceId, trackId: input.trackId },
    })
    return row ? this.hydrateCoverage(row) : null
  }

  async listCoverage(input: {
    workspaceId: string
    sessionId: string
  }): Promise<readonly Readonly<TrackCoverage>[]> {
    const rows = await this.client.v2CaptureTrackCoverage.findMany({
      where: { workspaceId: input.workspaceId, sessionId: input.sessionId },
      orderBy: { trackId: 'asc' },
    })
    return Object.freeze(rows.map((row) => this.hydrateCoverage(row)))
  }

  private hydrateCoverage(row: {
    workspaceId: string
    trackId: string
    sessionId: string
    schemaVersion: string
    derivedSessionVersion: number
    derivedReferenceEpoch: number
    timebaseNum: bigint
    timebaseDen: bigint
    boundsStart: bigint
    boundsEnd: bigint
    availableJson: string
    gapsJson: string
    corruptJson: string
    unverifiedJson: string
    overlapsJson: string
    recorderSplitsJson: string
    coverageHash: string
  }): Readonly<TrackCoverage> {
    if (row.schemaVersion !== TRACK_COVERAGE_SCHEMA_VERSION) {
      conflict(`Stored coverage for track ${row.trackId} carries an unknown schema version`)
    }
    const coverage: TrackCoverage = {
      schemaVersion: TRACK_COVERAGE_SCHEMA_VERSION,
      workspaceId: row.workspaceId,
      trackId: row.trackId,
      derivedFrom: Object.freeze({
        sessionId: row.sessionId,
        sessionVersion: row.derivedSessionVersion,
        referenceEpoch: row.derivedReferenceEpoch,
      }),
      timebase: createTimebase(rational(row.timebaseNum, row.timebaseDen)),
      bounds: createTickInterval(row.boundsStart, row.boundsEnd),
      available: Object.freeze(decode<CoverageInterval[]>(row.availableJson, 'coverage available spans')),
      gaps: Object.freeze(decode<CoverageInterval[]>(row.gapsJson, 'coverage gaps')),
      corrupt: Object.freeze(decode<CoverageInterval[]>(row.corruptJson, 'coverage corrupt spans')),
      unverified: Object.freeze(decode<CoverageInterval[]>(row.unverifiedJson, 'coverage unverified spans')),
      overlaps: Object.freeze(decode<CoverageOverlapDecision[]>(row.overlapsJson, 'coverage overlaps')),
      recorderSplits: Object.freeze(decode<RecorderSplit[]>(row.recorderSplitsJson, 'coverage recorder splits')),
      coverageHash: row.coverageHash,
    }
    return assertTrackCoverageIntegrity(Object.freeze(coverage))
  }

  // -------------------------------------------------------------------------
  // F4.004 — the evidence cascade
  // -------------------------------------------------------------------------

  async persistSyncEvidence(input: {
    workspaceId: string
    record: Readonly<SyncEvidenceRecord>
    createdAt: string
  }): Promise<Readonly<{ record: Readonly<SyncEvidenceRecord>; replayed: boolean }>> {
    const { record } = input
    const hash = evidenceHashOf(record)
    const data = {
      id: `${record.sessionId}:${record.trackId}:sync`,
      workspaceId: input.workspaceId,
      sessionId: record.sessionId,
      trackId: record.trackId,
      referenceTrackId: record.referenceTrackId,
      schemaVersion: record.schemaVersion,
      outcome: record.outcome,
      manualRequired: record.manualRequired,
      selectedSignalId: record.selectedSignalId,
      selectedMethod: record.selectedMethod,
      mapRateNum: record.clockMap?.rate.num ?? null,
      mapRateDen: record.clockMap?.rate.den ?? null,
      mapOffsetTicks: record.clockMap?.offsetTicks ?? null,
      mapRounding: record.clockMap?.rounding ?? null,
      sessionTimebaseNum: record.sessionTimebase.secondsPerTick.num,
      sessionTimebaseDen: record.sessionTimebase.secondsPerTick.den,
      sessionFrameRateNum: record.sessionFrameRate.num,
      sessionFrameRateDen: record.sessionFrameRate.den,
      sessionBoundsStart: record.sessionBounds.start,
      sessionBoundsEnd: record.sessionBounds.end,
      assessmentsJson: stringifyWithTicks(record.assessments),
      discardedJson: stringifyWithTicks(record.discarded),
      contradictionsJson: stringifyWithTicks(record.contradictions),
      corroborationsJson: stringifyWithTicks(record.corroborations),
      outcomeReasonsJson: JSON.stringify([...record.outcomeReasons]),
      thresholdsJson: stringifyWithTicks(record.thresholds),
      evidenceHash: hash,
      createdAt: new Date(input.createdAt),
    }

    // Re-running the cascade against new evidence is the normal case, so a
    // second run replaces the first. The replaced record is not lost silently:
    // its offset only ever reached a cut through a clock map, and that map
    // carries the evidence refs that produced it.
    const stored = await this.client.v2CaptureSyncEvidence.upsert({
      where: {
        workspaceId_sessionId_trackId: {
          workspaceId: input.workspaceId,
          sessionId: record.sessionId,
          trackId: record.trackId,
        },
      },
      create: data,
      update: data,
      select: { evidenceHash: true },
    })
    return Object.freeze({ record, replayed: stored.evidenceHash === hash })
  }

  async readSyncEvidence(input: {
    workspaceId: string
    sessionId: string
    trackId: string
  }): Promise<Readonly<SyncEvidenceRecord> | null> {
    const row = await this.client.v2CaptureSyncEvidence.findFirst({
      where: {
        workspaceId: input.workspaceId,
        sessionId: input.sessionId,
        trackId: input.trackId,
      },
    })
    return row ? this.hydrateEvidence(row) : null
  }

  async listSyncEvidence(input: {
    workspaceId: string
    sessionId: string
  }): Promise<readonly Readonly<SyncEvidenceRecord>[]> {
    const rows = await this.client.v2CaptureSyncEvidence.findMany({
      where: { workspaceId: input.workspaceId, sessionId: input.sessionId },
      orderBy: { trackId: 'asc' },
    })
    return Object.freeze(rows.map((row) => this.hydrateEvidence(row)))
  }

  private hydrateEvidence(row: {
    sessionId: string
    trackId: string
    referenceTrackId: string
    schemaVersion: string
    outcome: string
    manualRequired: boolean
    selectedSignalId: string | null
    selectedMethod: string | null
    mapRateNum: bigint | null
    mapRateDen: bigint | null
    mapOffsetTicks: bigint | null
    mapRounding: string | null
    sessionTimebaseNum: bigint
    sessionTimebaseDen: bigint
    sessionFrameRateNum: bigint
    sessionFrameRateDen: bigint
    sessionBoundsStart: bigint
    sessionBoundsEnd: bigint
    assessmentsJson: string
    discardedJson: string
    contradictionsJson: string
    corroborationsJson: string
    outcomeReasonsJson: string
    thresholdsJson: string
    evidenceHash: string
  }): Readonly<SyncEvidenceRecord> {
    if (row.schemaVersion !== SYNC_EVIDENCE_SCHEMA_VERSION) {
      conflict(`Stored sync evidence for track ${row.trackId} carries an unknown schema version`)
    }
    const record = {
      schemaVersion: SYNC_EVIDENCE_SCHEMA_VERSION,
      sessionId: row.sessionId,
      trackId: row.trackId,
      referenceTrackId: row.referenceTrackId,
      sessionTimebase: createTimebase(rational(row.sessionTimebaseNum, row.sessionTimebaseDen)),
      sessionFrameRate: rational(row.sessionFrameRateNum, row.sessionFrameRateDen),
      sessionBounds: createTickInterval(row.sessionBoundsStart, row.sessionBoundsEnd),
      outcome: row.outcome as SyncEvidenceRecord['outcome'],
      manualRequired: row.manualRequired,
      selectedSignalId: row.selectedSignalId,
      selectedMethod: row.selectedMethod as SyncEvidenceRecord['selectedMethod'],
      clockMap: row.mapRateNum === null || row.mapRateDen === null || row.mapOffsetTicks === null
        ? null
        : Object.freeze({
          rate: rational(row.mapRateNum, row.mapRateDen),
          offsetTicks: row.mapOffsetTicks,
          rounding: row.mapRounding as RoundingPolicy,
        }),
      assessments: Object.freeze(
        decode<SyncEvidenceRecord['assessments'][number][]>(row.assessmentsJson, 'sync assessments'),
      ),
      discarded: Object.freeze(
        decode<SyncEvidenceRecord['discarded'][number][]>(row.discardedJson, 'sync discarded alternatives'),
      ),
      contradictions: Object.freeze(
        decode<SyncEvidenceRecord['contradictions'][number][]>(row.contradictionsJson, 'sync contradictions'),
      ),
      corroborations: Object.freeze(
        decode<SyncEvidenceRecord['corroborations'][number][]>(row.corroborationsJson, 'sync corroborations'),
      ),
      outcomeReasons: Object.freeze(JSON.parse(row.outcomeReasonsJson) as string[]),
      thresholds: Object.freeze(
        decode<SyncEvidenceRecord['thresholds']>(row.thresholdsJson, 'sync thresholds'),
      ),
    } as SyncEvidenceRecord
    // The record has no hash of its own, so persistence supplies one and checks
    // it here. Without this the assessments — the justification for an offset
    // that reaches a cut — would be the only unguarded rows in the wave.
    if (evidenceHashOf(record) !== row.evidenceHash) {
      conflict(`Stored sync evidence for track ${row.trackId} does not match its hash`)
    }
    return Object.freeze(record)
  }
}
