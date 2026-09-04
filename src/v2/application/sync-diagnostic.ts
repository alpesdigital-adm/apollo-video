import { DomainError } from '../domain/errors.ts'
import {
  applyAnchorEdit,
  type AnchorEdit,
} from '../domain/sync-diagnostic-anchors.ts'
import {
  canAutoEdit,
  createSyncDiagnostic,
  deriveTrackStatus,
  type DiagnosticAnchor,
  type DiagnosticWarning,
  type SyncDiagnostic,
  type TrackDiagnostic,
} from '../domain/sync-diagnostic.ts'
import {
  createSyncMarker,
  type MarkerKind,
  type MarkerPosition,
  type SyncMarker,
} from '../domain/sync-marker.ts'
import {
  fuseMarkerDetections,
  offsetBetweenDetections,
  type FusionMode,
  type MarkerDetection,
} from '../domain/sync-marker-detection.ts'
import type { CaptureSessionRepository } from './ports/capture-session-repository.ts'
import type { CaptureProtocolRepository } from './ports/capture-protocol-repository.ts'
import type {
  MarkerArtifactRef,
  SyncDiagnosticRepository,
} from './ports/sync-diagnostic-repository.ts'
import type { ObservedMarkerFacts } from '../domain/capture-protocol-evaluation.ts'

/**
 * Marker and diagnostic commands (F4.010, F4.011).
 *
 * The rule running through all of them: a caller can ask for work to be done
 * and can read the result, but cannot supply the result. Detections come from
 * the detectors, the diagnostic is derived from the detections, and the
 * auto-edit gate is derived from the diagnostic. Nowhere in that chain does a
 * request body get to name an outcome.
 */

export interface SyncActor {
  readonly workspaceId: string
  readonly kind: 'human' | 'api-client' | 'director'
  readonly id: string
}

/** What the media layer does with a marker, kept behind a port. */
export interface MarkerMediaPort {
  render(marker: Readonly<SyncMarker>): Promise<Readonly<MarkerArtifactRef>>
  detect(input: {
    marker: Readonly<SyncMarker>
    trackId: string
    mediaPath: string
    mode: FusionMode
  }): Promise<Readonly<MarkerDetection>>
}

export function generateSyncMarkerService(dependencies: {
  repository: SyncDiagnosticRepository
  sessions: CaptureSessionRepository
  media: MarkerMediaPort
  createId: () => string
  clock: () => Date
}) {
  return async (input: {
    actor: SyncActor
    sessionId: string
    position: MarkerPosition
    kind?: MarkerKind
  }): Promise<Readonly<{ marker: Readonly<SyncMarker>; artifact: Readonly<MarkerArtifactRef>; replayed: boolean }>> => {
    const session = await dependencies.sessions.readHead({
      workspaceId: input.actor.workspaceId,
      sessionId: input.sessionId,
    })
    if (!session) {
      throw new DomainError('CAPTURE_SESSION_NOT_FOUND', `Capture session ${input.sessionId} does not exist`)
    }
    const existing = await dependencies.repository.listMarkers({
      workspaceId: input.actor.workspaceId,
      sessionId: input.sessionId,
    })
    // The sequence is assigned here, not requested. A caller choosing its own
    // could collide with an earlier marker and make "which marker was seen"
    // undecidable — the exact thing the sequence exists to answer.
    const sequence = existing.reduce((highest, entry) => Math.max(highest, entry.marker.sequence), 0) + 1

    const marker = createSyncMarker({
      markerId: dependencies.createId(),
      workspaceId: input.actor.workspaceId,
      sessionId: input.sessionId,
      kind: input.kind ?? 'audiovisual',
      position: input.position,
      sequence,
      emittedAt: dependencies.clock().toISOString(),
    })
    // Rendered before it is stored: a marker row whose artifact failed to
    // build would be offered to an operator who cannot show it to anything.
    const artifact = await dependencies.media.render(marker)
    const stored = await dependencies.repository.persistMarker({
      marker,
      artifact,
      createdAt: dependencies.clock().toISOString(),
    })
    return Object.freeze({ marker: stored.marker, artifact, replayed: stored.replayed })
  }
}

/**
 * Run detection for one track against one marker.
 *
 * The media path comes from the track's own ingested part, never from the
 * request: a caller able to name the file could point the detector at a
 * recording that proves what they wanted proved.
 */
export function detectSyncMarkerService(dependencies: {
  repository: SyncDiagnosticRepository
  sessions: CaptureSessionRepository
  media: MarkerMediaPort
  resolveMediaPath: (input: { workspaceId: string; sourceAssetId: string }) => Promise<string>
  clock: () => Date
}) {
  return async (input: {
    actor: SyncActor
    sessionId: string
    markerId: string
    trackId: string
    mode?: FusionMode
  }): Promise<Readonly<{ detection: Readonly<MarkerDetection>; replayed: boolean }>> => {
    const session = await dependencies.sessions.readHead({
      workspaceId: input.actor.workspaceId,
      sessionId: input.sessionId,
    })
    if (!session) {
      throw new DomainError('CAPTURE_SESSION_NOT_FOUND', `Capture session ${input.sessionId} does not exist`)
    }
    const track = session.tracks.find((entry) => entry.trackId === input.trackId)
    if (!track) {
      throw new DomainError('CAPTURE_TRACK_NOT_FOUND', `Track ${input.trackId} is not in this session`)
    }
    const stored = await dependencies.repository.readMarker({
      workspaceId: input.actor.workspaceId,
      markerId: input.markerId,
    })
    if (!stored) {
      throw new DomainError('SYNC_MARKER_NOT_FOUND', `Sync marker ${input.markerId} does not exist`)
    }
    // A marker addressed to another session cannot align this one, whatever
    // the detectors find.
    if (stored.marker.sessionId !== input.sessionId) {
      throw new DomainError(
        'SYNC_MARKER_FOREIGN_SESSION',
        `Sync marker ${input.markerId} belongs to capture session ${stored.marker.sessionId}`,
      )
    }

    const mediaPath = await dependencies.resolveMediaPath({
      workspaceId: input.actor.workspaceId,
      sourceAssetId: track.sourceAssetId,
    })
    const detection = await dependencies.media.detect({
      marker: stored.marker,
      trackId: input.trackId,
      mediaPath,
      // A track whose recorder captured no usable audio can only ever produce
      // one channel; demanding both would refuse it for a reason that is not
      // its fault.
      mode: input.mode ?? (track.syncAudioPolicy === 'none' ? 'either-channel' : 'both-channels'),
    })
    return dependencies.repository.persistDetection({
      workspaceId: input.actor.workspaceId,
      detection,
      detectedAt: dependencies.clock().toISOString(),
    })
  }
}

/**
 * Build a diagnostic from what has been detected.
 *
 * Every number in the result is derived from stored detections and stored
 * coverage. The service assembles; it does not judge.
 */
export function generateSyncDiagnosticService(dependencies: {
  repository: SyncDiagnosticRepository
  sessions: CaptureSessionRepository
  protocols: CaptureProtocolRepository
  clock: () => Date
}) {
  return async (input: {
    actor: SyncActor
    sessionId: string
  }): Promise<Readonly<{ diagnostic: Readonly<SyncDiagnostic>; replayed: boolean }>> => {
    const session = await dependencies.sessions.readHead({
      workspaceId: input.actor.workspaceId,
      sessionId: input.sessionId,
    })
    if (!session) {
      throw new DomainError('CAPTURE_SESSION_NOT_FOUND', `Capture session ${input.sessionId} does not exist`)
    }

    const [detections, coverages, maps, evaluations] = await Promise.all([
      dependencies.repository.listDetections({
        workspaceId: input.actor.workspaceId,
        sessionId: input.sessionId,
      }),
      dependencies.sessions.listCoverage({
        workspaceId: input.actor.workspaceId,
        sessionId: input.sessionId,
      }),
      dependencies.sessions.listClockMaps({
        workspaceId: input.actor.workspaceId,
        sessionId: input.sessionId,
      }),
      dependencies.protocols.listEvaluations({
        workspaceId: input.actor.workspaceId,
        sessionId: input.sessionId,
        limit: 1,
      }),
    ])

    // Only an evaluation of the *current* session version constrains today's
    // diagnostic. An older one judged a different set of tracks.
    const evaluation = evaluations.find((entry) => entry.sessionVersion === session.version) ?? null

    const referenceDetections = detections.filter(
      (detection) => detection.trackId === session.referenceTrackId,
    )
    const previous = await dependencies.repository.readHead({
      workspaceId: input.actor.workspaceId,
      sessionId: input.sessionId,
    })

    const tracks: TrackDiagnostic[] = []
    for (const track of session.tracks) {
      if (track.trackId === session.referenceTrackId) continue

      const trackDetections = detections.filter((detection) => detection.trackId === track.trackId)
      const coverage = coverages.find((entry) => entry.trackId === track.trackId)
      const map = maps.find((entry) => entry.sourceId === track.sourceAssetId)
      const warnings = new Set<DiagnosticWarning>()

      // Anchors from confirmed markers only. A rejected detection has no
      // instant, and a single-channel one is an opinion rather than a fix.
      const automaticAnchors: DiagnosticAnchor[] = []
      for (const detection of trackDetections) {
        if (detection.outcome === 'rejected' || detection.atMs === null) continue
        const reference = referenceDetections.find(
          (entry) => entry.markerId === detection.markerId && entry.atMs !== null,
        )
        if (!reference) continue
        const offset = offsetBetweenDetections({ reference, target: detection })
        automaticAnchors.push(Object.freeze({
          anchorId: `${detection.markerId}:${track.trackId}`,
          origin: 'automatic' as const,
          sourceMs: detection.atMs,
          sessionMs: detection.atMs + offset.offsetMs,
          method: detection.mode === 'both-channels' ? 'apollo-marker' : 'apollo-marker-single-channel',
          confidence: detection.confidence,
          residualMs: null,
          evidenceRef: detection.detectionHash,
          createdAt: dependencies.clock().toISOString(),
        }))
        if (detection.outcome === 'single-channel-only') warnings.add('single-channel-marker-only')
      }

      // Manual anchors survive a regeneration: re-running detection must not
      // silently discard corrections a person made.
      const carriedManual = previous?.tracks.find((entry) => entry.trackId === track.trackId)?.manualAnchors ?? []

      if (automaticAnchors.length === 0 && carriedManual.length === 0) {
        warnings.add('insufficient-evidence')
      }
      // Null when coverage was never computed for this track. Reporting zero
      // would say every range is unusable, which is a measurement nobody made.
      const coverageBps = coverage
        ? Math.min(10_000, Math.max(0, Math.round(
          Number(coverage.available.reduce(
            (total, span) => total + (span.interval.end - span.interval.start), BigInt(0),
          ) * BigInt(10_000)
            / (coverage.bounds.end - coverage.bounds.start || BigInt(1))),
        )))
        : null
      if (coverageBps !== null && coverageBps < 9_000) warnings.add('coverage-below-floor')
      if (evaluation && evaluation.blocksAutoEdit) warnings.add('protocol-requirements-unmet')

      const all = [...automaticAnchors, ...carriedManual]
      const offsetMs = all.length > 0 ? all[0]!.sessionMs - all[0]!.sourceMs : null
      const residualMs = all.length > 0
        ? Math.max(0, ...trackDetections.map((detection) => detection.errorMs ?? 0))
        : null
      const confidence = all.length === 0
        ? 0
        : Math.min(...all.map((anchor) => anchor.confidence))

      tracks.push(Object.freeze({
        trackId: track.trackId,
        methods: Object.freeze([...new Set(all.map((anchor) => anchor.method))].sort()),
        confidence,
        offsetMs,
        residualMs,
        driftPpm: null,
        coverageBps,
        gaps: Object.freeze(coverage ? coverage.gaps.map((gap) => gap.interval) : []),
        automaticAnchors: Object.freeze(automaticAnchors),
        manualAnchors: Object.freeze([...carriedManual]),
        pieceIds: Object.freeze(map ? map.pieces.map((piece) => piece.pieceId) : []),
        status: deriveTrackStatus({
          offsetMs,
          residualMs,
          coverageBps,
          confidence,
          hasContradictoryAnchors: false,
        }),
        warnings: Object.freeze([...warnings].sort()),
        previewSampleMs: Object.freeze(all.slice(0, 3).map((anchor) => anchor.sessionMs)),
      }))
    }

    const diagnostic = createSyncDiagnostic({
      workspaceId: input.actor.workspaceId,
      sessionId: input.sessionId,
      referenceTrackId: session.referenceTrackId,
      version: (previous?.version ?? 0) + 1,
      previousVersionHash: previous?.diagnosticHash ?? null,
      sessionVersion: session.version,
      referenceEpoch: session.referenceEpoch,
      tracks,
      protocolCeiling: evaluation?.ceiling ?? null,
      generatedAt: dependencies.clock().toISOString(),
    })
    return dependencies.repository.appendVersion({
      diagnostic,
      expectedVersion: previous?.version,
      occurredAt: dependencies.clock().toISOString(),
    })
  }
}

/** Add, move or remove a manual anchor under a version fence. */
export function editSyncAnchorService(dependencies: {
  repository: SyncDiagnosticRepository
  clock: () => Date
}) {
  return async (input: {
    actor: SyncActor
    sessionId: string
    expectedVersion: number
    edit: Omit<AnchorEdit, 'editedAt'>
  }): Promise<Readonly<{ diagnostic: Readonly<SyncDiagnostic>; replayed: boolean }>> => {
    const current = await dependencies.repository.readHead({
      workspaceId: input.actor.workspaceId,
      sessionId: input.sessionId,
    })
    if (!current) {
      throw new DomainError(
        'SYNC_DIAGNOSTIC_NOT_FOUND',
        `Capture session ${input.sessionId} has no diagnostic to edit`,
      )
    }
    const next = applyAnchorEdit({
      diagnostic: current,
      expectedVersion: input.expectedVersion,
      edit: { ...input.edit, editedAt: dependencies.clock().toISOString() },
      actorId: input.actor.id,
    })
    return dependencies.repository.appendVersion({
      diagnostic: next,
      expectedVersion: current.version,
      occurredAt: dependencies.clock().toISOString(),
    })
  }
}

export function readSyncDiagnosticService(dependencies: { repository: SyncDiagnosticRepository }) {
  return async (input: { workspaceId: string; sessionId: string; version?: number }) => {
    const diagnostic = input.version === undefined
      ? await dependencies.repository.readHead(input)
      : await dependencies.repository.readVersion({ ...input, version: input.version })
    if (!diagnostic) {
      throw new DomainError(
        'SYNC_DIAGNOSTIC_NOT_FOUND',
        `Capture session ${input.sessionId} has no diagnostic`,
      )
    }
    // The gate travels with the document so a client cannot compute a more
    // permissive answer from the same fields.
    return Object.freeze({ diagnostic, autoEdit: canAutoEdit(diagnostic) })
  }
}

export function listSyncDiagnosticVersionsService(dependencies: { repository: SyncDiagnosticRepository }) {
  return async (input: { workspaceId: string; sessionId: string; limit?: number }) =>
    dependencies.repository.listVersions(input)
}

/**
 * The marker facts the protocol evaluation is allowed to see.
 *
 * Only confirmed detections count. A rejected one is not a marker that was
 * emitted badly, it is a marker nobody can prove was emitted at all.
 */
export function observeMarkerFactsService(dependencies: { repository: SyncDiagnosticRepository }) {
  return async (input: {
    workspaceId: string
    sessionId: string
  }): Promise<Readonly<ObservedMarkerFacts>> => {
    const detections = await dependencies.repository.listDetections(input)
    const positions = new Set<MarkerPosition>()
    for (const detection of detections) {
      if (detection.outcome === 'confirmed') positions.add(detection.position)
    }
    return Object.freeze({ confirmedPositions: Object.freeze([...positions]) })
  }
}
