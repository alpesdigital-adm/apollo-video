import type {
  PersistedServerPerceptionSnapshot, ServerPerceptionEvidenceReader, ServerPerceptionSnapshotRepository,
} from './ports/server-perception-snapshot-repository.ts'
import { DomainError } from '../domain/errors.ts'
import type { PerceptionKind } from '../domain/perception-timeline.ts'
import { assembleServerPerceptionSnapshot, queryServerPerceptionSnapshot } from '../domain/server-perception-snapshot.ts'

const ID = /^[A-Za-z0-9][A-Za-z0-9._:-]{0,127}$/
function identity(value: string, field: string) {
  const normalized = value?.trim()
  if (!ID.test(normalized)) throw new DomainError('INVALID_ARGUMENT', `${field} is invalid`)
  return normalized
}

/**
 * Gathers the sealed server evidence of one ProjectVersion, assembles its perception snapshot and makes sure the one row that holds
 * those exact bytes exists. The same evidence is the same snapshot (same hash, same row), whoever asks and however often: this is a
 * content-addressed materialization of a deterministic function, not a write the caller chooses the content of.
 */
export function ensureServerPerceptionSnapshotService(dependencies: {
  evidence: ServerPerceptionEvidenceReader
  snapshots: ServerPerceptionSnapshotRepository
  clock: () => Date
}) {
  return async (request: { workspaceId: string; projectId: string; projectVersionId?: string | null }) => {
    const workspaceId = identity(request.workspaceId, 'workspaceId')
    const projectId = identity(request.projectId, 'projectId')
    const projectVersionId = request.projectVersionId == null ? null : identity(request.projectVersionId, 'projectVersionId')
    const now = dependencies.clock()
    if (Number.isNaN(now.getTime())) throw new DomainError('INVALID_ARGUMENT', 'Perception clock is invalid')
    const evidence = await dependencies.evidence.readForVersion({ workspaceId, projectId, projectVersionId, now })
    // A project, or a version of it, that is not in this workspace is the same answer: it does not exist for the caller.
    if (evidence === null) throw new DomainError('PROJECT_NOT_FOUND', 'Project version was not found')
    if (evidence === 'no-timeline') {
      throw new DomainError('PRECONDITION_REQUIRED', 'Project version plays nothing: there is no timeline to put perception on')
    }
    return dependencies.snapshots.persistIfAbsent({ snapshot: assembleServerPerceptionSnapshot(evidence), createdAt: now.toISOString() })
  }
}

type SnapshotQuery = {
  fromMs?: number
  toMs?: number
  kinds?: readonly PerceptionKind[]
}

function presentSnapshot(record: Readonly<PersistedServerPerceptionSnapshot>, request: SnapshotQuery) {
  const { snapshot } = record
  return Object.freeze({
    id: record.id,
    workspaceId: record.workspaceId,
    projectId: record.projectId,
    projectVersionId: record.projectVersionId,
    createdAt: record.createdAt,
    // The snapshot is the server's own: it never contains a caller's manual timeline (PUT /perception), which stays separate.
    origin: Object.freeze({ kind: 'server-assembled' as const, manualTimelinesIncluded: false as const }),
    snapshot: Object.freeze({
      schemaVersion: snapshot.schemaVersion,
      snapshotHash: snapshot.snapshotHash,
      timelineHash: snapshot.timeline.timelineHash,
      faceSafety: snapshot.faceSafety,
      editPlan: snapshot.editPlan,
      timeBase: snapshot.timeBase,
      sources: snapshot.sources,
      inputs: snapshot.inputs,
      rejected: snapshot.rejected,
      unexaminedSpans: snapshot.unexaminedSpans,
    }),
    result: queryServerPerceptionSnapshot(snapshot, { fromMs: request.fromMs, toMs: request.toMs, kinds: request.kinds }),
  })
}

/**
 * The WRITE side, kept apart from every read (W64): assembles the snapshot of a Version from its sealed evidence and writes the row that
 * holds exactly those bytes, once. A Director commit does this inside its transaction; this service is what a producer publication or an
 * operator calls to materialize a Version no Director has run on. It answers like the read does, from the row it found or wrote.
 */
export function materializeServerPerceptionSnapshotService(dependencies: {
  evidence: ServerPerceptionEvidenceReader
  snapshots: ServerPerceptionSnapshotRepository
  clock: () => Date
}) {
  const ensure = ensureServerPerceptionSnapshotService(dependencies)
  return async (request: {
    workspaceId: string
    projectId: string
    projectVersionId?: string | null
  } & SnapshotQuery) => {
    const { record } = await ensure(request)
    return presentSnapshot(record, request)
  }
}

/**
 * The READ side of `GET .../perception/snapshot` (W64): it serves the newest snapshot already stored for the Version and writes nothing,
 * ever - it never reads the producers' evidence and never assembles. A Version that plays something and has no stored snapshot is
 * `SNAPSHOT_NOT_MATERIALIZED` (404); one that plays nothing is `PRECONDITION_REQUIRED` (428), as before. Rights and source bytes are not
 * history: they are checked again on every read (revoked or unknown rights are ASSET_RIGHTS_BLOCKED, other bytes PERSISTENCE_CONFLICT).
 */
export function readServerPerceptionSnapshotService(dependencies: {
  snapshots: ServerPerceptionSnapshotRepository
  clock: () => Date
}) {
  return async (request: {
    workspaceId: string
    projectId: string
    projectVersionId?: string | null
  } & SnapshotQuery) => {
    const workspaceId = identity(request.workspaceId, 'workspaceId')
    const projectId = identity(request.projectId, 'projectId')
    const projectVersionId = request.projectVersionId == null ? null : identity(request.projectVersionId, 'projectVersionId')
    const now = dependencies.clock()
    if (Number.isNaN(now.getTime())) throw new DomainError('INVALID_ARGUMENT', 'Perception clock is invalid')
    const found = await dependencies.snapshots.findLatestForVersion({ workspaceId, projectId, projectVersionId })
    // A project, or a version of it, that is not in this workspace is the same answer: it does not exist for the caller.
    if (found.status === 'not-found') throw new DomainError('PROJECT_NOT_FOUND', 'Project version was not found')
    if (found.status === 'plays-nothing') {
      throw new DomainError('PRECONDITION_REQUIRED', 'Project version plays nothing: there is no timeline to put perception on')
    }
    if (found.status === 'not-materialized') {
      throw new DomainError('SNAPSHOT_NOT_MATERIALIZED', 'No perception snapshot has been written for this project version yet', {
        projectVersionId: found.projectVersionId,
        reason: 'A Director run on the version writes its snapshot in its commit; this read never assembles one.',
      })
    }
    await dependencies.snapshots.assertSourcesStillHold({ workspaceId, snapshot: found.record.snapshot, now })
    return presentSnapshot(found.record, request)
  }
}
