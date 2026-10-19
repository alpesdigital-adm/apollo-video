import type { SourceRightsRecord } from '../../domain/director-evidence-rubric.ts'

/** The columns of a rights snapshot row the Director's integral rights verdict reads. */
export type StoredRightsSnapshot = Readonly<{
  id: string
  snapshotHash: string
  status: string
  consentStatus: string
  expiresAt: Date | null
  consentExpiresAt: Date | null
}>

/**
 * The rights of one source as the Director judges them (W64). A source with no rights snapshot is `missing`: unknown, which is not
 * certain. Shared by the Director's claim, its commit, and the read of a persisted perception snapshot, so all three judge the same way.
 */
export function sourceRightsOf(snapshot: StoredRightsSnapshot | null | undefined): SourceRightsRecord {
  return snapshot
    ? Object.freeze({
        state: 'present' as const,
        snapshotId: snapshot.id,
        snapshotHash: snapshot.snapshotHash,
        status: snapshot.status,
        consentStatus: snapshot.consentStatus,
        ...(snapshot.expiresAt ? { expiresAt: snapshot.expiresAt.toISOString() } : {}),
        ...(snapshot.consentExpiresAt ? { consentExpiresAt: snapshot.consentExpiresAt.toISOString() } : {}),
      })
    : Object.freeze({ state: 'missing' as const })
}
