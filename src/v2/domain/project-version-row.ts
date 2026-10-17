import { assertDomain } from './errors.ts'
import { serializeOutputCanonicalJson } from './output-canonical-policy.ts'
import type { ProjectVersionV2, ProjectVersionV3 } from './project-version.ts'

/** The columns of a persisted ProjectVersion a reader needs to prove it read the sealed Version. */
export interface ProjectVersionRowFacts {
  id: string
  workspaceId: string
  projectId: string
  sequence: number
  parentVersionId: string | null
  forkedFromProjectId?: string | null
  forkedFromVersionId?: string | null
  briefSnapshotId: string
  treatmentSnapshotId: string | null
  storySnapshotId: string | null
  editPlanSnapshotId: string
  policiesSnapshotId: string
  baseHash: string
  createdBy: string
  commandId: string | null
  createdAt: Date
  outputContractVersion: number
  outputStateId: string | null
  outputStateHash: string | null
  outputVersionJson: string | null
}

/**
 * Hydration is reading the sealed document, never rebuilding a Version from loose columns. A row that is
 * not a contract-2 or contract-3 Version (historical audit or the retired contract 1) cannot enter an
 * operational reader; there is no fallback that fabricates an output state for it.
 */
export function hydrateProjectVersionRow(row: Readonly<ProjectVersionRowFacts>): Readonly<ProjectVersionV2 | ProjectVersionV3> {
  assertDomain(row.outputContractVersion === 2 || row.outputContractVersion === 3, 'PERSISTENCE_CONFLICT',
    'Stored ProjectVersion has no sealed output state for operational use', { id: row.id, outputContractVersion: row.outputContractVersion })
  assertDomain(typeof row.outputVersionJson === 'string' && row.outputStateId !== null && row.outputStateHash !== null,
    'PERSISTENCE_CONFLICT', 'Stored ProjectVersion lacks its sealed document', { id: row.id })
  let document: ProjectVersionV2 | ProjectVersionV3
  try { document = JSON.parse(row.outputVersionJson!) } catch { assertDomain(false, 'PERSISTENCE_CONFLICT', 'Stored ProjectVersion document is not JSON', { id: row.id }) }
  const refs = document!.snapshotRefs
  assertDomain(serializeOutputCanonicalJson(document!) === row.outputVersionJson &&
    document!.schemaVersion === 1 && document!.outputContractVersion === row.outputContractVersion &&
    document!.id === row.id && document!.workspaceId === row.workspaceId && document!.projectId === row.projectId &&
    document!.sequence === row.sequence && (document as { parentVersionId?: string }).parentVersionId === (row.parentVersionId ?? undefined) &&
    document!.baseHash === row.baseHash && document!.outputStateId === row.outputStateId && document!.outputStateHash === row.outputStateHash &&
    document!.createdBy === row.createdBy && document!.createdAt === row.createdAt.toISOString() &&
    (document as { commandId?: string }).commandId === (row.commandId ?? undefined) &&
    refs.brief === row.briefSnapshotId && refs.policies === row.policiesSnapshotId && refs.editPlan === row.editPlanSnapshotId &&
    (refs.treatment ?? null) === row.treatmentSnapshotId && (refs.story ?? null) === row.storySnapshotId &&
    (document!.forkedFromProjectId ?? null) === (row.forkedFromProjectId ?? null) &&
    (document!.forkedFromVersionId ?? null) === (row.forkedFromVersionId ?? null),
  'PERSISTENCE_CONFLICT', 'Stored ProjectVersion columns differ from its sealed document', { id: row.id })
  return Object.freeze(document!)
}
