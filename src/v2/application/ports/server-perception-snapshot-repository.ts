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

/**
 * What the read-only side finds for a ProjectVersion (W64). Nothing here is assembled or written: a snapshot exists because a Director
 * commit (or an explicit materialization) wrote it.
 */
export type LatestServerPerceptionSnapshot =
  | Readonly<{ status: 'found'; record: Readonly<PersistedServerPerceptionSnapshot> }>
  /** The Version exists and plays something, and no snapshot of it has been written. */
  | Readonly<{ status: 'not-materialized'; projectVersionId: string }>
  /** The Version exists and plays nothing: there is no clock to put perception on. */
  | Readonly<{ status: 'plays-nothing'; projectVersionId: string }>
  /** No such project or Version in this workspace. */
  | Readonly<{ status: 'not-found' }>

export interface ServerPerceptionSnapshotRepository {
  /**
   * The newest stored snapshot of the Version (`projectVersionId: null` is the project's current Version), re-verified against its own
   * bytes, hash, columns and coverage rows. Reads only; a Version with no stored snapshot is `not-materialized`, never assembled here.
   */
  findLatestForVersion(input: {
    workspaceId: string
    projectId: string
    projectVersionId: string | null
  }): Promise<LatestServerPerceptionSnapshot>
  /**
   * A stored snapshot is a record of what the server saw when it was written. Two things are not history and are checked again on
   * every read: every source it played still has certain rights (revoked or unknown rights refuse the read with
   * ASSET_RIGHTS_BLOCKED), and still has the bytes the snapshot sealed (otherwise PERSISTENCE_CONFLICT).
   */
  assertSourcesStillHold(input: {
    workspaceId: string
    snapshot: Readonly<ServerPerceptionSnapshot>
    now: Date
  }): Promise<void>
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
