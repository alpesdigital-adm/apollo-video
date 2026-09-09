import type { MulticamDirection } from '../../domain/multicam-direction.ts'
import type { MulticamEvidenceSet } from '../../domain/multicam-evidence.ts'

/**
 * A direction as it sits in storage (F4.012).
 *
 * `MulticamDirection` carries no version of its own: which link of the chain a
 * direction occupies is a fact about the store, not about the cut. Reads hand
 * back the pair so a caller can fence its next write on the version *and* the
 * hash — a version number alone can be reused after a write that failed
 * halfway, the hash cannot.
 */
export interface StoredMulticamDirection {
  readonly direction: Readonly<MulticamDirection>
  readonly version: number
  readonly previousVersionHash: string | null
}

/** The document a new version claims to have been computed against. */
export interface MulticamDirectionBase {
  readonly version: number
  readonly directionHash: string
}

/**
 * What a direction is derived from, as a row rather than a comment.
 *
 * A re-synced session or a re-analysed evidence set does not invalidate every
 * direction in the workspace — only the ones that named the old diagnostic or
 * the old evidence. This is the query that finds them, and the reason both
 * hashes are columns.
 */
export interface MulticamDirectionDependencyRef {
  readonly sessionId: string
  readonly version: number
  readonly directionHash: string
  readonly diagnosticVersion: number
  readonly diagnosticHash: string
  readonly evidenceHash: string
  readonly manualReviewRequired: boolean
  /** True when this version is the head: the others are already history. */
  readonly isHead: boolean
}

/**
 * Persistence for multicam evidence and multicam direction (F4.012).
 *
 * Evidence sets are content-addressed and immutable: the same observations for
 * the same session version *are* the same set, so a repeat write is a replay
 * rather than a second opinion. Directions are an append-only chain plus a
 * mutable head per session, in the shape Wave 18 and Wave 19 already use.
 */
export interface MulticamDirectionRepository {
  /**
   * Store one evidence set. A second write of the same content replays.
   *
   * A write of *different* content under a hash that already exists is a
   * conflict rather than an update: two producers disagreeing about what a
   * session contains is not resolved by whichever wrote last.
   */
  persistEvidenceSet(input: {
    set: Readonly<MulticamEvidenceSet>
    createdAt: string
  }): Promise<Readonly<{ set: Readonly<MulticamEvidenceSet>; replayed: boolean }>>

  readEvidenceSet(input: {
    workspaceId: string
    evidenceHash: string
  }): Promise<Readonly<MulticamEvidenceSet> | null>

  /** The most recently generated evidence set for a session, or null. */
  readLatestEvidenceSet(input: {
    workspaceId: string
    sessionId: string
  }): Promise<Readonly<MulticamEvidenceSet> | null>

  /**
   * Append a direction version and advance the head.
   *
   * `base` is null only for version 1. Otherwise the head is advanced by an
   * UPDATE whose predicate names both the version and the hash the caller
   * edited, so a second writer that computed its direction against the same
   * head loses in the predicate rather than in whoever read first. The loser
   * is told the current version and hash so it can offer a reload.
   */
  appendVersion(input: {
    direction: Readonly<MulticamDirection>
    base: Readonly<MulticamDirectionBase> | null
    occurredAt: string
  }): Promise<Readonly<{ stored: Readonly<StoredMulticamDirection>; replayed: boolean }>>

  readHead(input: {
    workspaceId: string
    sessionId: string
  }): Promise<Readonly<StoredMulticamDirection> | null>

  readVersion(input: {
    workspaceId: string
    sessionId: string
    version: number
  }): Promise<Readonly<StoredMulticamDirection> | null>

  /** The chain, newest first. */
  listVersions(input: {
    workspaceId: string
    sessionId: string
    limit?: number
  }): Promise<readonly Readonly<StoredMulticamDirection>[]>

  /**
   * Directions that named one of these derivations.
   *
   * Cheap on purpose: the caller is deciding what to mark superseded, not
   * reading cuts, so this projects columns instead of rehydrating aggregates.
   */
  findDependents(input: {
    workspaceId: string
    sessionId?: string
    diagnosticHash?: string
    evidenceHash?: string
  }): Promise<readonly Readonly<MulticamDirectionDependencyRef>[]>
}
