import { assertDomain } from './errors.ts'

export const PROJECT_SNAPSHOT_KINDS = [
  'brief',
  'perception',
  'treatment',
  'story',
  'edit-plan',
  'quality-report',
  'policies',
] as const

export type ProjectSnapshotKind = (typeof PROJECT_SNAPSHOT_KINDS)[number]

export interface ProjectSnapshot {
  schemaVersion: 1
  id: string
  workspaceId: string
  projectId: string
  kind: ProjectSnapshotKind
  contentSchemaVersion: number
  contentJson: string
  contentHash: string
  createdAt: string
}

export type ProjectSnapshotInput = Omit<ProjectSnapshot, 'schemaVersion'>

export function createProjectSnapshot(
  input: ProjectSnapshotInput,
): Readonly<ProjectSnapshot> {
  assertDomain(input.id.trim().length > 0, 'INVALID_SNAPSHOT', 'Snapshot id is required')
  assertDomain(
    input.workspaceId.trim().length > 0 && input.projectId.trim().length > 0,
    'INVALID_SNAPSHOT',
    'Snapshot workspaceId and projectId are required',
  )
  assertDomain(
    PROJECT_SNAPSHOT_KINDS.includes(input.kind),
    'INVALID_SNAPSHOT',
    'Unsupported snapshot kind',
    { kind: input.kind },
  )
  assertDomain(
    Number.isInteger(input.contentSchemaVersion) && input.contentSchemaVersion >= 1,
    'INVALID_SNAPSHOT',
    'Snapshot contentSchemaVersion must be a positive integer',
  )
  assertDomain(
    /^[a-f0-9]{64}$/.test(input.contentHash),
    'INVALID_SNAPSHOT',
    'Snapshot contentHash must be a lowercase SHA-256 hash',
  )
  assertDomain(
    !Number.isNaN(Date.parse(input.createdAt)),
    'INVALID_SNAPSHOT',
    'Snapshot createdAt must be an ISO-compatible date',
  )

  try {
    JSON.parse(input.contentJson)
  } catch {
    assertDomain(false, 'INVALID_SNAPSHOT', 'Snapshot contentJson must contain valid JSON')
  }

  return Object.freeze({ ...input, schemaVersion: 1 as const })
}
