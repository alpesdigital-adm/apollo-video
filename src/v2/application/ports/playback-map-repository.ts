import type { PlaybackMap } from '../../domain/playback-map.ts'

/**
 * A playback map whose reference recording is one of the ones asked about.
 *
 * Different reference bytes mean every reference tick means something else, so
 * a changed reference supersedes its dependants rather than amending them. The
 * asset id alone is not the identity — the same id re-uploaded is different
 * footage — which is why the sha travels with it.
 */
export interface PlaybackMapDependencyRef {
  readonly sessionId: string
  readonly reactionTrackId: string
  readonly mapId: string
  readonly version: number
  readonly mapHash: string
  readonly status: string
  readonly isHead: boolean
}

/**
 * React playback maps (F4.015 / FR-153).
 *
 * An append-only chain plus a head per session and reaction track. Unlike the
 * direction and the match plan, `PlaybackMap` carries its own `version` and
 * `previousVersionHash` — `applyPlaybackAnchor` produces the next version from
 * the one before it — so the repository fences on the pair the map already
 * names rather than on numbers the caller passes beside it.
 */
export interface PlaybackMapRepository {
  /**
   * Append the next version of a map and advance the head.
   *
   * The head moves only where it still names `expectedHash` at
   * `expectedVersion`, so two operators anchoring the same uncovered stretch
   * from two machines cannot both write version N+1. Both are omitted for
   * version 1, which creates the head instead.
   */
  appendVersion(input: {
    map: Readonly<PlaybackMap>
    expectedVersion?: number
    expectedHash?: string
    occurredAt: string
  }): Promise<Readonly<{ map: Readonly<PlaybackMap>; replayed: boolean }>>

  readHead(input: {
    workspaceId: string
    sessionId: string
    reactionTrackId: string
  }): Promise<Readonly<PlaybackMap> | null>

  readVersion(input: {
    workspaceId: string
    sessionId: string
    reactionTrackId: string
    version: number
  }): Promise<Readonly<PlaybackMap> | null>

  /** The chain, newest first. Each entry names the hash it replaced. */
  listVersions(input: {
    workspaceId: string
    sessionId: string
    reactionTrackId: string
    limit?: number
  }): Promise<readonly Readonly<PlaybackMap>[]>

  /** Maps built on one reference recording, identified by bytes and not by name. */
  findDependentsOfReference(input: {
    workspaceId: string
    referenceAssetId: string
    referenceSha256: string
  }): Promise<readonly Readonly<PlaybackMapDependencyRef>[]>
}
