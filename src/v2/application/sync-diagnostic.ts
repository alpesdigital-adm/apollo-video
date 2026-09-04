import { createHash } from 'node:crypto'

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
import type { CaptureSession, CaptureTrack, CaptureTrackPart } from '../domain/capture-session.ts'
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
  /**
   * Everything else that identifies who is asking.
   *
   * Present so an idempotency key can be bound to the whole credential rather
   * than to a workspace and a client id. Two credentials of the same client
   * are two callers; letting one replay the other's key would hand it a
   * marker it never generated and hide that a second one was wanted.
   */
  readonly credentialId?: string
  readonly authenticationKind?: string
  readonly delegatedUserId?: string
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

/**
 * The marker id a given caller's key maps to.
 *
 * Bound to the full credential, not just the workspace: two credentials of one
 * client are two callers, and letting one replay the other's key would hand it
 * a marker it never asked for. The session, position and kind are in the
 * digest too, so the same key used for a different request is a conflict the
 * caller is told about rather than a silent substitution.
 */
export function deriveMarkerIdempotentId(input: {
  actor: SyncActor
  sessionId: string
  position: MarkerPosition
  kind: MarkerKind
  idempotencyKey: string
}): string {
  const digest = createHash('sha256')
    .update(JSON.stringify([
      input.actor.workspaceId,
      input.actor.kind,
      input.actor.id,
      input.actor.credentialId ?? '',
      input.actor.authenticationKind ?? '',
      input.actor.delegatedUserId ?? '',
      input.sessionId,
      input.position,
      input.kind,
      input.idempotencyKey,
    ]))
    .digest('hex')
  return `sync-marker-${digest.slice(0, 32)}`
}

export function generateSyncMarkerService(dependencies: {
  repository: SyncDiagnosticRepository
  sessions: CaptureSessionRepository
  media: MarkerMediaPort
  clock: () => Date
}) {
  return async (input: {
    actor: SyncActor
    sessionId: string
    position: MarkerPosition
    kind?: MarkerKind
    idempotencyKey: string
  }): Promise<Readonly<{ marker: Readonly<SyncMarker>; artifact: Readonly<MarkerArtifactRef>; replayed: boolean }>> => {
    if (input.idempotencyKey.trim().length === 0) {
      throw new DomainError(
        'INVALID_ARGUMENT',
        'Generating a marker needs an idempotency key: a retry without one renders a second marker and burns a second sequence number',
      )
    }
    const markerId = deriveMarkerIdempotentId({
      actor: input.actor,
      sessionId: input.sessionId,
      position: input.position,
      kind: input.kind ?? 'audiovisual',
      idempotencyKey: input.idempotencyKey.trim(),
    })
    // Checked before anything is rendered. Recovering the first marker costs a
    // lookup; not checking costs a second render, a second artifact and a
    // sequence number that makes "which marker was filmed" ambiguous forever.
    const replayedMarker = await dependencies.repository.readMarker({
      workspaceId: input.actor.workspaceId,
      markerId,
    })
    if (replayedMarker) {
      if (replayedMarker.marker.sessionId !== input.sessionId) {
        throw new DomainError(
          'IDEMPOTENCY_PAYLOAD_MISMATCH',
          'This idempotency key was already used for a different capture session',
        )
      }
      if (!replayedMarker.artifact) {
        throw new DomainError(
          'SYNC_MARKER_NOT_FOUND',
          `Marker ${markerId} exists but its media was never stored; it cannot be filmed`,
        )
      }
      return Object.freeze({
        marker: replayedMarker.marker,
        artifact: replayedMarker.artifact,
        replayed: true,
      })
    }
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
      markerId,
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
 * The file a marker of this position would have been recorded into.
 *
 * A recorder that stopped and restarted leaves several files. A marker emitted
 * after the restart is in the restart file and nowhere else, so searching the
 * first file would report absence for something that was recorded, and
 * searching every file would let a start marker be credited to a restart.
 *
 * When the position names a file that does not exist, that is refused rather
 * than approximated: "no restart happened" is a fact about the session, not a
 * reason to guess.
 */
function partForPosition(
  track: Readonly<CaptureTrack>,
  position: MarkerPosition,
): Readonly<CaptureTrackPart> {
  const ordered = [...track.parts].sort((left, right) => left.ordinal - right.ordinal)
  if (position === 'after-restart') {
    // The file that FOLLOWS a restart, which is the ordinal and not the split
    // reason. Wave 18 re-stamps the first part as 'recorder-restart' the moment
    // a second file arrives — deliberately, because a first file that still
    // called itself 'single-file' would be lying — so the reason says the track
    // is split, never which file came after the break.
    const restart = ordered.find((entry) => entry.ordinal > 0)
    if (!restart) {
      throw new DomainError(
        'CAPTURE_TRACK_PART_NOT_FOUND',
        `Track ${track.trackId} is a single unbroken file, so an after-restart marker cannot be in it`,
      )
    }
    return restart
  }
  const chosen = position === 'end' ? ordered.at(-1) : ordered[0]
  if (!chosen) {
    throw new DomainError(
      'CAPTURE_TRACK_PART_NOT_FOUND',
      `Track ${track.trackId} has no files to search`,
    )
  }
  return chosen
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
  resolveMediaPath: (input: {
    workspaceId: string
    part: Readonly<CaptureTrackPart>
  }) => Promise<string>
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

    // Which file to search is decided from the marker's position, not from
    // the request. A track can be several files; searching the wrong one would
    // report "not found" for a marker that is plainly there, and searching all
    // of them would let a marker emitted at the start be credited to a restart.
    const part = partForPosition(track, stored.marker.position)
    const mediaPath = await dependencies.resolveMediaPath({
      workspaceId: input.actor.workspaceId,
      part,
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
    baseVersionId: string
    baseHash: string
  }): Promise<Readonly<{ diagnostic: Readonly<SyncDiagnostic>; replayed: boolean }>> => {
    const session = await dependencies.sessions.readHead({
      workspaceId: input.actor.workspaceId,
      sessionId: input.sessionId,
    })
    if (!session) {
      throw new DomainError('CAPTURE_SESSION_NOT_FOUND', `Capture session ${input.sessionId} does not exist`)
    }
    // A diagnostic describes one exact version of a session. Deriving it
    // against whatever happens to be current would silently produce a document
    // about a session the operator never saw.
    assertSessionUnmoved(session, input)

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
/**
 * The session version a derivation is allowed to be computed against.
 *
 * The pair, not the number: a version number alone can be reused after a
 * failed write, so a caller naming only "version 3" could be describing a
 * different version 3 than the one it read. The hash cannot be reused.
 *
 * The refusal carries the current version so a UI can offer a reload instead of
 * making the operator work out what changed.
 */
function assertSessionUnmoved(
  session: Readonly<CaptureSession>,
  base: Readonly<{ baseVersionId: string; baseHash: string }>,
): void {
  const expectedId = `${session.sessionId}:v${session.version}`
  if (base.baseVersionId !== expectedId || base.baseHash !== session.sessionHash) {
    throw new DomainError(
      'CAPTURE_SESSION_VERSION_STALE',
      `Capture session ${session.sessionId} has moved to version ${session.version}; re-read it and retry`,
      {
        currentVersionId: expectedId,
        currentVersion: session.version,
        currentHash: session.sessionHash,
      },
    )
  }
}

export function editSyncAnchorService(dependencies: {
  repository: SyncDiagnosticRepository
  clock: () => Date
}) {
  return async (input: {
    actor: SyncActor
    sessionId: string
    baseVersionId: string
    baseHash: string
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
    // The pair, not the number. Two edits can both name version 3 if the
    // first attempt failed and was retried, and the hash is what tells them
    // apart — the same reason the capture chain is addressed this way.
    const expectedId = `${current.sessionId}:diagnostic:v${current.version}`
    if (input.baseVersionId !== expectedId || input.baseHash !== current.diagnosticHash) {
      throw new DomainError(
        'SYNC_DIAGNOSTIC_VERSION_STALE',
        `The diagnostic for ${input.sessionId} has moved to version ${current.version}; re-read it and retry`,
        {
          currentVersionId: expectedId,
          currentVersion: current.version,
          currentHash: current.diagnosticHash,
        },
      )
    }
    const next = applyAnchorEdit({
      diagnostic: current,
      expectedVersion: current.version,
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
