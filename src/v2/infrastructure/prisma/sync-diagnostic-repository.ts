import type { PrismaClient } from '../../../../generated/prisma-v2/index.js'

import type {
  MarkerArtifactRef,
  SyncDiagnosticRepository,
} from '../../application/ports/sync-diagnostic-repository.ts'
import { DomainError } from '../../domain/errors.ts'
import {
  assertMarkerDetectionIntegrity,
  MARKER_DETECTION_SCHEMA_VERSION,
  type FusionMode,
  type FusionOutcome,
  type FusionRejection,
  type MarkerDetection,
} from '../../domain/sync-marker-detection.ts'
import {
  assertSyncMarkerIntegrity,
  SYNC_MARKER_SCHEMA_VERSION,
  type MarkerAudioSpec,
  type MarkerKind,
  type MarkerPosition,
  type MarkerVisualSpec,
  type SyncMarker,
} from '../../domain/sync-marker.ts'
import {
  assertSyncDiagnosticIntegrity,
  SYNC_DIAGNOSTIC_SCHEMA_VERSION,
  type DiagnosticStatus,
  type DiagnosticWarning,
  type RecommendedAction,
  type SyncDiagnostic,
  type TrackDiagnostic,
} from '../../domain/sync-diagnostic.ts'
import type { SyncCeiling } from '../../domain/capture-protocol.ts'
import { getV2PostgresClient } from '../prisma-postgres/client.ts'

function isPrismaCode(error: unknown, code: string): boolean {
  return typeof error === 'object' && error !== null && 'code' in error && error.code === code
}

function parse<T>(json: string, what: string): T {
  try {
    return JSON.parse(json) as T
  } catch {
    throw new DomainError('PERSISTENCE_CONFLICT', `Stored ${what} is not valid JSON`)
  }
}

function hydrateMarker(row: {
  id: string
  workspaceId: string
  sessionId: string
  schemaVersion: string
  kind: string
  position: string
  sequence: number
  sessionCode: string
  emittedAt: Date
  payload: string
  checksum: string
  visualJson: string
  audioJson: string
  markerHash: string
}): Readonly<SyncMarker> {
  if (row.schemaVersion !== SYNC_MARKER_SCHEMA_VERSION) {
    throw new DomainError('PERSISTENCE_CONFLICT', `Stored marker ${row.id} carries an unknown schema version`)
  }
  const marker: SyncMarker = {
    schemaVersion: SYNC_MARKER_SCHEMA_VERSION,
    markerId: row.id,
    workspaceId: row.workspaceId,
    sessionId: row.sessionId,
    kind: row.kind as MarkerKind,
    position: row.position as MarkerPosition,
    sequence: row.sequence,
    sessionCode: row.sessionCode,
    emittedAt: row.emittedAt.toISOString(),
    visual: Object.freeze(parse<MarkerVisualSpec>(row.visualJson, `marker ${row.id} visual spec`)),
    audio: Object.freeze(parse<MarkerAudioSpec>(row.audioJson, `marker ${row.id} audio spec`)),
    payload: row.payload,
    checksum: row.checksum,
    markerHash: row.markerHash,
  }
  // Checks the checksum and the hash separately, so a rejection can say which
  // one was tampered with — the payload or the record around it.
  return assertSyncMarkerIntegrity(Object.freeze(marker))
}

function artifactOf(row: {
  artifactId: string | null
  artifactSha256: string | null
  artifactBytes: number | null
}): Readonly<MarkerArtifactRef> | null {
  if (!row.artifactId || !row.artifactSha256 || row.artifactBytes === null) return null
  return Object.freeze({
    artifactId: row.artifactId,
    sha256: row.artifactSha256,
    byteSize: row.artifactBytes,
  })
}

function hydrateDetection(row: {
  markerId: string
  sessionId: string
  trackId: string
  schemaVersion: string
  position: string
  mode: string
  outcome: string
  rejection: string | null
  atMs: number | null
  errorMs: number | null
  visualObservationId: string | null
  audioObservationId: string | null
  confidence: number
  reasonsJson: string
  detectionHash: string
}): Readonly<MarkerDetection> {
  if (row.schemaVersion !== MARKER_DETECTION_SCHEMA_VERSION) {
    throw new DomainError(
      'PERSISTENCE_CONFLICT',
      `Stored detection for ${row.trackId} carries an unknown schema version`,
    )
  }
  const detection: MarkerDetection = {
    schemaVersion: MARKER_DETECTION_SCHEMA_VERSION,
    markerId: row.markerId,
    sessionId: row.sessionId,
    trackId: row.trackId,
    position: row.position as MarkerPosition,
    mode: row.mode as FusionMode,
    outcome: row.outcome as FusionOutcome,
    rejection: row.rejection as FusionRejection | null,
    atMs: row.atMs,
    errorMs: row.errorMs,
    visualObservationId: row.visualObservationId,
    audioObservationId: row.audioObservationId,
    confidence: row.confidence,
    reasons: Object.freeze(parse<string[]>(row.reasonsJson, 'detection reasons')),
    detectionHash: row.detectionHash,
  }
  return assertMarkerDetectionIntegrity(Object.freeze(detection))
}

function hydrateDiagnostic(row: {
  workspaceId: string
  sessionId: string
  referenceTrackId: string
  version: number
  previousVersionHash: string | null
  sessionVersion: number
  referenceEpoch: number
  schemaVersion: string
  status: string
  globalConfidence: number
  tracksJson: string
  warningsJson: string
  recommendedActionsJson: string
  manualRequired: boolean
  protocolCeiling: string | null
  diagnosticHash: string
  generatedAt: Date
}): Readonly<SyncDiagnostic> {
  if (row.schemaVersion !== SYNC_DIAGNOSTIC_SCHEMA_VERSION) {
    throw new DomainError(
      'PERSISTENCE_CONFLICT',
      `Stored diagnostic for ${row.sessionId} carries an unknown schema version`,
    )
  }
  const diagnostic: SyncDiagnostic = {
    schemaVersion: SYNC_DIAGNOSTIC_SCHEMA_VERSION,
    workspaceId: row.workspaceId,
    sessionId: row.sessionId,
    referenceTrackId: row.referenceTrackId,
    version: row.version,
    previousVersionHash: row.previousVersionHash,
    sessionVersion: row.sessionVersion,
    referenceEpoch: row.referenceEpoch,
    status: row.status as DiagnosticStatus,
    globalConfidence: row.globalConfidence,
    tracks: Object.freeze(parse<TrackDiagnostic[]>(row.tracksJson, 'diagnostic tracks')),
    warnings: Object.freeze(parse<DiagnosticWarning[]>(row.warningsJson, 'diagnostic warnings')),
    recommendedActions: Object.freeze(
      parse<RecommendedAction[]>(row.recommendedActionsJson, 'recommended actions'),
    ),
    manualRequired: row.manualRequired,
    protocolCeiling: row.protocolCeiling as SyncCeiling | null,
    generatedAt: row.generatedAt.toISOString(),
    diagnosticHash: row.diagnosticHash,
  }
  // A status softened in the database — needs-input quietly becoming
  // synced-high — fails here rather than unblocking an unattended cut.
  return assertSyncDiagnosticIntegrity(Object.freeze(diagnostic))
}

export class PrismaSyncDiagnosticRepository implements SyncDiagnosticRepository {
  constructor(private readonly client: PrismaClient = getV2PostgresClient()) {}

  async persistMarker(input: {
    marker: Readonly<SyncMarker>
    artifact?: Readonly<MarkerArtifactRef>
    createdAt: string
  }): Promise<Readonly<{ marker: Readonly<SyncMarker>; replayed: boolean }>> {
    const { marker } = input
    const data = {
      id: marker.markerId,
      workspaceId: marker.workspaceId,
      sessionId: marker.sessionId,
      schemaVersion: marker.schemaVersion,
      kind: marker.kind,
      position: marker.position,
      sequence: marker.sequence,
      sessionCode: marker.sessionCode,
      emittedAt: new Date(marker.emittedAt),
      payload: marker.payload,
      checksum: marker.checksum,
      visualJson: JSON.stringify(marker.visual),
      audioJson: JSON.stringify(marker.audio),
      artifactId: input.artifact?.artifactId ?? null,
      artifactSha256: input.artifact?.sha256 ?? null,
      artifactBytes: input.artifact?.byteSize ?? null,
      markerHash: marker.markerHash,
      createdAt: new Date(input.createdAt),
    }
    try {
      await this.client.v2SyncMarker.create({ data })
      return Object.freeze({ marker, replayed: false })
    } catch (error) {
      if (!isPrismaCode(error, 'P2002')) throw error
      const stored = await this.readMarker({ workspaceId: marker.workspaceId, markerId: marker.markerId })
      if (stored && stored.marker.markerHash === marker.markerHash) {
        // Same marker, and now possibly with an artifact it did not have. The
        // identity is unchanged, so attaching the render is not a rewrite.
        if (input.artifact && !stored.artifact) {
          await this.client.v2SyncMarker.update({
            where: { id: marker.markerId },
            data: {
              artifactId: input.artifact.artifactId,
              artifactSha256: input.artifact.sha256,
              artifactBytes: input.artifact.byteSize,
            },
          })
        }
        return Object.freeze({ marker: stored.marker, replayed: true })
      }
      throw new DomainError(
        'PERSISTENCE_CONFLICT',
        `Sync marker ${marker.markerId} already exists with different content`,
      )
    }
  }

  async readMarker(input: { workspaceId: string; markerId: string }) {
    const row = await this.client.v2SyncMarker.findFirst({
      where: { id: input.markerId, workspaceId: input.workspaceId },
    })
    return row ? Object.freeze({ marker: hydrateMarker(row), artifact: artifactOf(row) }) : null
  }

  async listMarkers(input: { workspaceId: string; sessionId: string }) {
    const rows = await this.client.v2SyncMarker.findMany({
      where: { workspaceId: input.workspaceId, sessionId: input.sessionId },
      orderBy: { sequence: 'asc' },
    })
    return Object.freeze(rows.map((row) =>
      Object.freeze({ marker: hydrateMarker(row), artifact: artifactOf(row) })))
  }

  async persistDetection(input: {
    workspaceId: string
    detection: Readonly<MarkerDetection>
    detectedAt: string
  }): Promise<Readonly<{ detection: Readonly<MarkerDetection>; replayed: boolean }>> {
    const { detection } = input
    const data = {
      id: `${detection.markerId}:${detection.trackId}`,
      workspaceId: input.workspaceId,
      markerId: detection.markerId,
      sessionId: detection.sessionId,
      trackId: detection.trackId,
      schemaVersion: detection.schemaVersion,
      position: detection.position,
      mode: detection.mode,
      outcome: detection.outcome,
      rejection: detection.rejection,
      atMs: detection.atMs,
      errorMs: detection.errorMs,
      visualObservationId: detection.visualObservationId,
      audioObservationId: detection.audioObservationId,
      confidence: detection.confidence,
      reasonsJson: JSON.stringify(detection.reasons),
      detectionHash: detection.detectionHash,
      detectedAt: new Date(input.detectedAt),
    }
    // Re-detection after better evidence is the normal case; keeping both
    // verdicts would leave callers to decide which one stands.
    const stored = await this.client.v2SyncMarkerDetection.upsert({
      where: { id: data.id },
      create: data,
      update: data,
      select: { detectionHash: true },
    })
    return Object.freeze({ detection, replayed: stored.detectionHash === detection.detectionHash })
  }

  async listDetections(input: { workspaceId: string; sessionId: string }) {
    const rows = await this.client.v2SyncMarkerDetection.findMany({
      where: { workspaceId: input.workspaceId, sessionId: input.sessionId },
      orderBy: [{ trackId: 'asc' }, { position: 'asc' }],
    })
    return Object.freeze(rows.map(hydrateDetection))
  }

  async appendVersion(input: {
    diagnostic: Readonly<SyncDiagnostic>
    expectedVersion?: number
    occurredAt: string
  }): Promise<Readonly<{ diagnostic: Readonly<SyncDiagnostic>; replayed: boolean }>> {
    const { diagnostic } = input
    const manualAnchors = diagnostic.tracks.reduce((total, track) => total + track.manualAnchors.length, 0)
    const automaticAnchors = diagnostic.tracks.reduce((total, track) => total + track.automaticAnchors.length, 0)
    const at = new Date(input.occurredAt)

    try {
      await this.client.$transaction(async (transaction) => {
        await transaction.v2SyncDiagnostic.create({
          data: {
            id: `${diagnostic.sessionId}:d${diagnostic.version}`,
            workspaceId: diagnostic.workspaceId,
            sessionId: diagnostic.sessionId,
            referenceTrackId: diagnostic.referenceTrackId,
            version: diagnostic.version,
            previousVersionHash: diagnostic.previousVersionHash,
            sessionVersion: diagnostic.sessionVersion,
            referenceEpoch: diagnostic.referenceEpoch,
            schemaVersion: diagnostic.schemaVersion,
            status: diagnostic.status,
            globalConfidence: diagnostic.globalConfidence,
            tracksJson: JSON.stringify(diagnostic.tracks),
            trackCount: diagnostic.tracks.length,
            warningsJson: JSON.stringify(diagnostic.warnings),
            recommendedActionsJson: JSON.stringify(diagnostic.recommendedActions),
            manualRequired: diagnostic.manualRequired,
            protocolCeiling: diagnostic.protocolCeiling,
            manualAnchorCount: manualAnchors,
            automaticAnchorCount: automaticAnchors,
            diagnosticHash: diagnostic.diagnosticHash,
            generatedAt: new Date(diagnostic.generatedAt),
            createdAt: at,
          },
        })

        if (diagnostic.version === 1) {
          await transaction.v2SyncDiagnosticHead.create({
            data: {
              id: diagnostic.sessionId,
              workspaceId: diagnostic.workspaceId,
              sessionId: diagnostic.sessionId,
              version: 1,
              diagnosticHash: diagnostic.diagnosticHash,
              status: diagnostic.status,
              manualRequired: diagnostic.manualRequired,
              createdAt: at,
              updatedAt: at,
            },
          })
          return
        }

        // The expected version sits in the predicate rather than in a
        // preceding read, so two operators editing anchors from two machines
        // cannot both observe version N and both write N+1.
        const expected = input.expectedVersion ?? diagnostic.version - 1
        const advanced = await transaction.v2SyncDiagnosticHead.updateMany({
          where: {
            workspaceId: diagnostic.workspaceId,
            sessionId: diagnostic.sessionId,
            version: expected,
          },
          data: {
            version: diagnostic.version,
            diagnosticHash: diagnostic.diagnosticHash,
            status: diagnostic.status,
            manualRequired: diagnostic.manualRequired,
            updatedAt: at,
          },
        })
        if (advanced.count !== 1) {
          throw new DomainError(
            'SYNC_DIAGNOSTIC_VERSION_STALE',
            `The diagnostic for ${diagnostic.sessionId} moved on: expected version ${expected} to be current`,
          )
        }
      })
      return Object.freeze({ diagnostic, replayed: false })
    } catch (error) {
      if (!isPrismaCode(error, 'P2002')) throw error
      const stored = await this.readVersion({
        workspaceId: diagnostic.workspaceId,
        sessionId: diagnostic.sessionId,
        version: diagnostic.version,
      })
      if (stored && stored.diagnosticHash === diagnostic.diagnosticHash) {
        return Object.freeze({ diagnostic: stored, replayed: true })
      }
      // Two different edits claiming the same link in the chain. Picking one
      // would silently discard a correction somebody made.
      throw new DomainError(
        'PERSISTENCE_CONFLICT',
        `The diagnostic for ${diagnostic.sessionId} already has a different version ${diagnostic.version}`,
      )
    }
  }

  async readHead(input: { workspaceId: string; sessionId: string }) {
    const head = await this.client.v2SyncDiagnosticHead.findFirst({
      where: { workspaceId: input.workspaceId, sessionId: input.sessionId },
      select: { version: true },
    })
    if (!head) return null
    return this.readVersion({ ...input, version: head.version })
  }

  async readVersion(input: { workspaceId: string; sessionId: string; version: number }) {
    const row = await this.client.v2SyncDiagnostic.findFirst({
      where: {
        workspaceId: input.workspaceId,
        sessionId: input.sessionId,
        version: input.version,
      },
    })
    return row ? hydrateDiagnostic(row) : null
  }

  async listVersions(input: { workspaceId: string; sessionId: string; limit?: number }) {
    const rows = await this.client.v2SyncDiagnostic.findMany({
      where: { workspaceId: input.workspaceId, sessionId: input.sessionId },
      orderBy: { version: 'desc' },
      take: Math.min(Math.max(input.limit ?? 25, 1), 200),
    })
    return Object.freeze(rows.map(hydrateDiagnostic))
  }
}
