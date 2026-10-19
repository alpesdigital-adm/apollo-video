import type { ServerPerceptionAssemblyInput, ServerPerceptionSnapshot } from '../../domain/server-perception-snapshot.ts'

/** A snapshot as the store hands it back: re-verified against its own bytes, its hash, its columns and its coverage rows. */
export interface PersistedServerPerceptionSnapshot {
  id: string
  workspaceId: string
  projectId: string
  projectVersionId: string
  snapshot: Readonly<ServerPerceptionSnapshot>
  createdAt: string
}

export interface ServerPerceptionSnapshotRepository {
  /**
   * Writes the snapshot once. The same content (the same hash) for the same ProjectVersion is the same row: a second call, from
   * anywhere, returns it and writes nothing. A stored row that does not verify is refused, never returned.
   */
  persistIfAbsent(input: {
    snapshot: Readonly<ServerPerceptionSnapshot>
    createdAt: string
  }): Promise<Readonly<{ record: Readonly<PersistedServerPerceptionSnapshot>; created: boolean }>>
  findByHash(input: {
    workspaceId: string
    projectId: string
    projectVersionId: string
    snapshotHash: string
  }): Promise<Readonly<PersistedServerPerceptionSnapshot> | null>
}

/**
 * Reads, for one ProjectVersion, the sealed server evidence a snapshot is made of. Every envelope has already been rebuilt through its
 * domain constructor, its columns and publishing operation checked, its source bytes and the consuming project's attachment
 * verified and the source's rights re-evaluated at `now`. Evidence of another project, workspace or version is never returned.
 */
export interface ServerPerceptionEvidenceReader {
  /**
   * `projectVersionId: null` means the project's current version. `null` is returned when the project, or the version in it, does
   * not exist; `'no-timeline'` when the version plays nothing (there is no clock to put perception on).
   */
  readForVersion(input: {
    workspaceId: string
    projectId: string
    projectVersionId: string | null
    now: Date
  }): Promise<Readonly<ServerPerceptionAssemblyInput> | 'no-timeline' | null>
}
