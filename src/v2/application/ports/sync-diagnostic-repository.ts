import type { MarkerDetection } from '../../domain/sync-marker-detection.ts'
import type { SyncMarker } from '../../domain/sync-marker.ts'
import type { SyncDiagnostic } from '../../domain/sync-diagnostic.ts'

/** Where a rendered marker artifact lives, once it has been produced. */
export interface MarkerArtifactRef {
  readonly artifactId: string
  readonly sha256: string
  readonly byteSize: number
}

/**
 * Persistence for markers, detections and diagnostics (F4.010, F4.011).
 *
 * The diagnostic half mirrors the capture session's shape: an immutable chain
 * plus a mutable head. `appendVersion` advances the head only where it still
 * names the version the caller edited, so two operators nudging anchors from
 * two machines cannot both write version N+1 — the loser is told which version
 * it lost to rather than overwriting a correction it never saw.
 */
export interface SyncDiagnosticRepository {
  persistMarker(input: {
    marker: Readonly<SyncMarker>
    artifact?: Readonly<MarkerArtifactRef>
    createdAt: string
  }): Promise<Readonly<{ marker: Readonly<SyncMarker>; replayed: boolean }>>

  readMarker(input: {
    workspaceId: string
    markerId: string
  }): Promise<Readonly<{ marker: Readonly<SyncMarker>; artifact: Readonly<MarkerArtifactRef> | null }> | null>

  listMarkers(input: {
    workspaceId: string
    sessionId: string
  }): Promise<readonly Readonly<{ marker: Readonly<SyncMarker>; artifact: Readonly<MarkerArtifactRef> | null }>[]>

  /**
   * Store one detection, replacing any earlier attempt on the same track.
   *
   * Re-detection after better evidence arrives is the normal case, and keeping
   * both would leave callers to decide which verdict stands.
   */
  persistDetection(input: {
    workspaceId: string
    detection: Readonly<MarkerDetection>
    detectedAt: string
  }): Promise<Readonly<{ detection: Readonly<MarkerDetection>; replayed: boolean }>>

  listDetections(input: {
    workspaceId: string
    sessionId: string
  }): Promise<readonly Readonly<MarkerDetection>[]>

  /**
   * Append a diagnostic version and advance the head.
   *
   * `expectedVersion` is omitted only for version 1. A mismatch is a conflict,
   * not a retry: the caller's edit was computed against a document that no
   * longer describes the session.
   */
  appendVersion(input: {
    diagnostic: Readonly<SyncDiagnostic>
    expectedVersion?: number
    occurredAt: string
  }): Promise<Readonly<{ diagnostic: Readonly<SyncDiagnostic>; replayed: boolean }>>

  readHead(input: {
    workspaceId: string
    sessionId: string
  }): Promise<Readonly<SyncDiagnostic> | null>

  readVersion(input: {
    workspaceId: string
    sessionId: string
    version: number
  }): Promise<Readonly<SyncDiagnostic> | null>

  /** The chain, newest first. Each entry names the hash it replaced. */
  listVersions(input: {
    workspaceId: string
    sessionId: string
    limit?: number
  }): Promise<readonly Readonly<SyncDiagnostic>[]>
}
