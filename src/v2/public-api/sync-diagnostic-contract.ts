import type { MarkerArtifactRef } from '../application/ports/sync-diagnostic-repository.ts'
import { DomainError } from '../domain/errors.ts'
import type { TickInterval } from '../domain/session-time.ts'
import type {
  DiagnosticAnchor,
  SyncDiagnostic,
  TrackDiagnostic,
} from '../domain/sync-diagnostic.ts'
import type { AnchorEdit } from '../domain/sync-diagnostic-anchors.ts'
import type { MarkerDetection } from '../domain/sync-marker-detection.ts'
import { FUSION_MODES, type FusionMode } from '../domain/sync-marker-detection.ts'
import type { SyncMarker } from '../domain/sync-marker.ts'
import { MARKER_KINDS, MARKER_POSITIONS, type MarkerKind, type MarkerPosition } from '../domain/sync-marker.ts'

/**
 * The public boundary for markers and diagnostics (F4.010, F4.011).
 *
 * Three rules shape it.
 *
 * **Ticks cross as strings.** Coverage gaps are tick intervals, and a 64-bit
 * tick handed to a JSON parser as a number comes back rounded with nothing
 * raised. Milliseconds are different: they are measurements with error bars,
 * already far inside the double's exact range, and they cross as numbers.
 *
 * **A caller asks for work; it never supplies the result.** There is no way to
 * post an offset, a confidence, a status or a detection outcome. Those are
 * derived from media the server read itself, because a client that could
 * assert them could assert a session was in sync when it was not, and every
 * downstream cut would inherit the lie.
 *
 * **A marker's sequence is not a request parameter.** Two callers choosing
 * their own sequences could collide, and "which marker did the camera see"
 * would stop having an answer.
 */

function record(value: unknown, field: string): Record<string, unknown> {
  if (typeof value !== 'object' || value === null || Array.isArray(value)) {
    throw new DomainError('INVALID_ARGUMENT', `${field} must be an object`)
  }
  return value as Record<string, unknown>
}

function exactFields(value: Record<string, unknown>, allowed: readonly string[], field: string): void {
  const unknown = Object.keys(value).filter((key) => !allowed.includes(key))
  if (unknown.length > 0) {
    throw new DomainError('INVALID_ARGUMENT', `${field} contains unknown fields`, { fields: unknown })
  }
}

function identifier(value: unknown, field: string): string {
  if (typeof value !== 'string' || value.trim().length === 0 || value.trim().length > 200) {
    throw new DomainError('INVALID_ARGUMENT', `${field} is invalid`)
  }
  return value.trim()
}

function member<T extends string>(value: unknown, allowed: readonly T[], field: string): T {
  if (typeof value !== 'string' || !(allowed as readonly string[]).includes(value)) {
    throw new DomainError('INVALID_ARGUMENT', `${field} must be one of ${allowed.join(', ')}`)
  }
  return value as T
}

/**
 * A millisecond position inside a recording.
 *
 * Finite and bounded to a day. `Number.isFinite` alone would accept 1e308,
 * which is not a moment in a video; it is a number that survived a bug
 * upstream and would sit in an anchor forever.
 */
function milliseconds(value: unknown, field: string): number {
  if (typeof value !== 'number' || !Number.isFinite(value) || Math.abs(value) > 86_400_000) {
    throw new DomainError('INVALID_ARGUMENT', `${field} must be a finite millisecond position`)
  }
  return value
}

function sha256(value: unknown, field: string): string {
  if (typeof value !== 'string' || !/^[a-f0-9]{64}$/.test(value)) {
    throw new DomainError('INVALID_ARGUMENT', `${field} must be a sha256 digest`)
  }
  return value
}

/** How a diagnostic version is named on the wire. */
export function diagnosticVersionId(sessionId: string, version: number): string {
  return `${sessionId}:diagnostic:v${version}`
}

export function parseGenerateSyncMarkerBody(raw: unknown): Readonly<{
  position: MarkerPosition
  kind: MarkerKind
}> {
  const body = record(raw, 'body')
  exactFields(body, ['position', 'kind'], 'body')
  return Object.freeze({
    position: member(body.position, MARKER_POSITIONS, 'position'),
    kind: body.kind === undefined ? 'audiovisual' : member(body.kind, MARKER_KINDS, 'kind'),
  })
}

export function parseDetectSyncMarkerBody(raw: unknown): Readonly<{
  trackId: string
  mode: FusionMode | undefined
}> {
  const body = record(raw, 'body')
  exactFields(body, ['trackId', 'mode'], 'body')
  return Object.freeze({
    trackId: identifier(body.trackId, 'trackId'),
    // Omitted means "let the server decide from the track": a track whose
    // recorder captured no usable audio cannot be held to both channels, and
    // the server knows that from the session, while the caller only claims it.
    mode: body.mode === undefined ? undefined : member(body.mode, FUSION_MODES, 'mode'),
  })
}

export function parseAnchorEditBody(raw: unknown): Readonly<{
  baseVersionId: string
  baseHash: string
  edit: Omit<AnchorEdit, 'editedAt'>
}> {
  const body = record(raw, 'body')
  exactFields(body, ['baseVersionId', 'baseHash', 'trackId', 'action', 'anchorId', 'sourceMs', 'sessionMs', 'evidenceRef'], 'body')
  const action = member(body.action, ['add', 'move', 'remove'] as const, 'action')
  if (action === 'remove') {
    for (const field of ['sourceMs', 'sessionMs'] as const) {
      if (body[field] !== undefined) {
        throw new DomainError('INVALID_ARGUMENT', `${field} has no meaning when removing an anchor`)
      }
    }
  } else if (body.sourceMs === undefined || body.sessionMs === undefined) {
    throw new DomainError('INVALID_ARGUMENT', `${action} requires both sourceMs and sessionMs`)
  }
  return Object.freeze({
    // The fence is in the body, not a header, because it is part of what the
    // caller is asserting: "I computed this nudge against exactly this
    // diagnostic." The hash makes that unambiguous where a number would not.
    baseVersionId: identifier(body.baseVersionId, 'baseVersionId'),
    baseHash: sha256(body.baseHash, 'baseHash'),
    edit: Object.freeze({
      trackId: identifier(body.trackId, 'trackId'),
      action,
      anchorId: identifier(body.anchorId, 'anchorId'),
      sourceMs: body.sourceMs === undefined ? undefined : milliseconds(body.sourceMs, 'sourceMs'),
      sessionMs: body.sessionMs === undefined ? undefined : milliseconds(body.sessionMs, 'sessionMs'),
      evidenceRef: body.evidenceRef === undefined
        ? undefined
        : identifier(body.evidenceRef, 'evidenceRef'),
    }),
  })
}

function presentInterval(interval: Readonly<TickInterval>) {
  return Object.freeze({ start: interval.start.toString(), end: interval.end.toString() })
}

export function presentSyncMarker(input: {
  marker: Readonly<SyncMarker>
  artifact: Readonly<MarkerArtifactRef> | null
}) {
  return Object.freeze({
    markerId: input.marker.markerId,
    sessionId: input.marker.sessionId,
    kind: input.marker.kind,
    position: input.marker.position,
    sequence: input.marker.sequence,
    sessionCode: input.marker.sessionCode,
    emittedAt: input.marker.emittedAt,
    payload: input.marker.payload,
    checksum: input.marker.checksum,
    markerHash: input.marker.markerHash,
    visual: Object.freeze({
      patternFrames: input.marker.visual.patternFrames,
      frameRate: `${input.marker.visual.frameRateNum}/${input.marker.visual.frameRateDen}`,
      codeSizePx: input.marker.visual.codeSizePx,
    }),
    audio: Object.freeze({ ...input.marker.audio }),
    // The bytes live in object storage. A rendered marker is video and audio;
    // putting it in a JSON field would make every read of the row pay for it.
    artifact: input.artifact === null ? null : Object.freeze({ ...input.artifact }),
  })
}

export function presentMarkerDetection(detection: Readonly<MarkerDetection>) {
  return Object.freeze({
    markerId: detection.markerId,
    sessionId: detection.sessionId,
    trackId: detection.trackId,
    position: detection.position,
    mode: detection.mode,
    outcome: detection.outcome,
    rejection: detection.rejection,
    // Null, not zero. A detection that found nothing has no instant, and a
    // zero here would read as "the marker was at the very first frame".
    atMs: detection.atMs,
    errorMs: detection.errorMs,
    visualObservationId: detection.visualObservationId,
    audioObservationId: detection.audioObservationId,
    confidence: detection.confidence,
    reasons: detection.reasons,
    detectionHash: detection.detectionHash,
  })
}

function presentAnchor(anchor: Readonly<DiagnosticAnchor>) {
  return Object.freeze({
    anchorId: anchor.anchorId,
    origin: anchor.origin,
    sourceMs: anchor.sourceMs,
    sessionMs: anchor.sessionMs,
    method: anchor.method,
    confidence: anchor.confidence,
    residualMs: anchor.residualMs,
    evidenceRef: anchor.evidenceRef,
    createdAt: anchor.createdAt,
  })
}

function presentTrackDiagnostic(track: Readonly<TrackDiagnostic>) {
  return Object.freeze({
    trackId: track.trackId,
    methods: track.methods,
    confidence: track.confidence,
    offsetMs: track.offsetMs,
    residualMs: track.residualMs,
    driftPpm: track.driftPpm,
    // Null means nobody measured coverage for this track. Zero would mean it
    // was measured and none of it is usable — a far stronger claim, and one
    // that would block editing on a measurement that never happened.
    coverageBps: track.coverageBps,
    gaps: track.gaps.map(presentInterval),
    automaticAnchors: track.automaticAnchors.map(presentAnchor),
    manualAnchors: track.manualAnchors.map(presentAnchor),
    pieceIds: track.pieceIds,
    status: track.status,
    warnings: track.warnings,
    previewSampleMs: track.previewSampleMs,
  })
}

export function presentSyncDiagnostic(input: {
  diagnostic: Readonly<SyncDiagnostic>
  autoEdit: Readonly<{ allowed: boolean; blockedBy: readonly string[] }>
}) {
  return Object.freeze({
    schemaVersion: input.diagnostic.schemaVersion,
    sessionId: input.diagnostic.sessionId,
    referenceTrackId: input.diagnostic.referenceTrackId,
    version: input.diagnostic.version,
    previousVersionHash: input.diagnostic.previousVersionHash,
    sessionVersion: input.diagnostic.sessionVersion,
    referenceEpoch: input.diagnostic.referenceEpoch,
    status: input.diagnostic.status,
    globalConfidence: input.diagnostic.globalConfidence,
    tracks: input.diagnostic.tracks.map(presentTrackDiagnostic),
    warnings: input.diagnostic.warnings,
    recommendedActions: input.diagnostic.recommendedActions,
    manualRequired: input.diagnostic.manualRequired,
    protocolCeiling: input.diagnostic.protocolCeiling,
    generatedAt: input.diagnostic.generatedAt,
    diagnosticHash: input.diagnostic.diagnosticHash,
    // The gate travels with the document. A client that had to recompute
    // "may I cut this?" from the fields above could compute a kinder answer.
    autoEdit: Object.freeze({ allowed: input.autoEdit.allowed, blockedBy: input.autoEdit.blockedBy }),
  })
}

export function presentSyncDiagnosticVersion(diagnostic: Readonly<SyncDiagnostic>) {
  return Object.freeze({
    version: diagnostic.version,
    previousVersionHash: diagnostic.previousVersionHash,
    sessionVersion: diagnostic.sessionVersion,
    status: diagnostic.status,
    globalConfidence: diagnostic.globalConfidence,
    manualAnchorCount: diagnostic.tracks.reduce((total, track) => total + track.manualAnchors.length, 0),
    generatedAt: diagnostic.generatedAt,
    diagnosticHash: diagnostic.diagnosticHash,
  })
}
