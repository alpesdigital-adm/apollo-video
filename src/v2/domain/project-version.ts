import { assertDomain } from './errors.ts'

export interface ProjectSnapshotRefs {
  brief?: string
  treatment?: string
  story?: string
  editPlan: string
  policies: string
}
export interface ProjectVersion {
  schemaVersion: 1
  id: string
  workspaceId: string
  projectId: string
  sequence: number
  parentVersionId?: string
  forkedFromProjectId?: string
  forkedFromVersionId?: string
  snapshotRefs: Readonly<ProjectSnapshotRefs>
  baseHash: string
  createdBy: string
  createdAt: string
  commandId?: string
}

export type ProjectVersionInput = Omit<ProjectVersion, 'schemaVersion'>

function requireIdentifier(value: string, field: string): void {
  assertDomain(
    value.trim().length > 0,
    'INVALID_PROJECT_VERSION',
    `${field} is required`,
    { field },
  )
}

export function createProjectVersion(input: ProjectVersionInput): Readonly<ProjectVersion> {
  requireIdentifier(input.id, 'id')
  requireIdentifier(input.workspaceId, 'workspaceId')
  requireIdentifier(input.projectId, 'projectId')
  requireIdentifier(input.snapshotRefs.editPlan, 'snapshotRefs.editPlan')
  requireIdentifier(input.snapshotRefs.policies, 'snapshotRefs.policies')
  requireIdentifier(input.baseHash, 'baseHash')
  requireIdentifier(input.createdBy, 'createdBy')
  assertDomain(
    Number.isInteger(input.sequence) && input.sequence >= 1,
    'INVALID_PROJECT_VERSION',
    'ProjectVersion sequence must be a positive integer',
    { sequence: input.sequence },
  )
  assertDomain(
    !Number.isNaN(Date.parse(input.createdAt)),
    'INVALID_PROJECT_VERSION',
    'ProjectVersion createdAt must be an ISO-compatible date',
    { createdAt: input.createdAt },
  )
  assertDomain(
    input.sequence === 1 ? !input.parentVersionId : Boolean(input.parentVersionId),
    'INVALID_PROJECT_VERSION',
    'Only the first version may omit parentVersionId',
    { sequence: input.sequence, parentVersionId: input.parentVersionId },
  )

  return Object.freeze({
    ...input,
    schemaVersion: 1 as const,
    snapshotRefs: Object.freeze({ ...input.snapshotRefs }),
  })
}
