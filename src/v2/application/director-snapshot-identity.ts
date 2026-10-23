import { createHash } from 'node:crypto'

import { calculateCanonicalHash, stableSerialize } from '../domain/canonical-hash.ts'
import { assertDomain, DomainError } from '../domain/errors.ts'
import { createProjectSnapshot, type ProjectSnapshot } from '../domain/project-snapshot.ts'

/** Validate historical snapshot bytes without changing their hash algorithm. */
export function assertDirectorSnapshotAuthority(snapshot: Readonly<ProjectSnapshot>): void {
  try {
    const fresh = createProjectSnapshot(snapshot)
    const parsed: unknown = JSON.parse(fresh.contentJson)
    assertDomain(fresh.schemaVersion === snapshot.schemaVersion &&
      fresh.contentJson === stableSerialize(parsed) &&
      fresh.contentHash === calculateCanonicalHash(parsed) &&
      fresh.contentHash === createHash('sha256').update(fresh.contentJson, 'utf8').digest('hex'),
    'PERSISTENCE_CONFLICT', 'Director snapshot historical authority is inconsistent')
  } catch (error) {
    if (error instanceof DomainError && error.code === 'PERSISTENCE_CONFLICT') throw error
    throw new DomainError('PERSISTENCE_CONFLICT', 'Director snapshot historical authority is invalid')
  }
}

/** The tuple chooses the identity; identical content never grants another scope. */
export function assertDirectorSnapshotContent(
  candidate: Readonly<ProjectSnapshot>,
  stored: Readonly<ProjectSnapshot>,
): void {
  assertDirectorSnapshotAuthority(candidate)
  assertDirectorSnapshotAuthority(stored)
  assertDomain(stored.workspaceId === candidate.workspaceId &&
    stored.projectId === candidate.projectId && stored.kind === candidate.kind &&
    stored.contentSchemaVersion === candidate.contentSchemaVersion &&
    stored.contentHash === candidate.contentHash && stored.contentJson === candidate.contentJson,
  'PERSISTENCE_CONFLICT', 'Canonical Director snapshot has incompatible scope, schema or JSON')
}

/** A resolver must return every candidate once; only identity and row time may
 * come from an existing immutable row. No missing-method/candidate fallback. */
export function bindDirectorSnapshotIdentities(
  candidates: readonly Readonly<ProjectSnapshot>[],
  resolved: readonly Readonly<ProjectSnapshot>[],
): readonly Readonly<ProjectSnapshot>[] {
  assertDomain(candidates.length > 0 && candidates.length <= 7 &&
    resolved.length === candidates.length &&
    new Set(candidates.map((item) => item.kind)).size === candidates.length &&
    new Set(resolved.map((item) => item.kind)).size === resolved.length &&
    new Set(resolved.map((item) => item.id)).size === resolved.length,
  'PERSISTENCE_CONFLICT', 'Director snapshot resolver omitted, repeated or added identities')
  const byKind = new Map(resolved.map((item) => [item.kind, item]))
  return Object.freeze(candidates.map((candidate) => {
    const stored = byKind.get(candidate.kind)
    assertDomain(stored !== undefined, 'PERSISTENCE_CONFLICT', 'Director snapshot resolver changed kind')
    assertDirectorSnapshotContent(candidate, stored)
    return createProjectSnapshot(stored)
  }))
}
