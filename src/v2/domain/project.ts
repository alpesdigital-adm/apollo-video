import { assertDomain } from './errors.ts'
import type { CommandActor } from './edit-command.ts'

export const PROJECT_STATUSES = [
  'draft',
  'ingesting',
  'perceiving',
  'planning',
  'generating',
  'reviewing-assets',
  'rendering-proxy',
  'reviewing-proxy',
  'revising',
  'rendering-final',
  'completed',
  'failed',
  'canceled',
  'archived',
] as const

export type ProjectStatus = (typeof PROJECT_STATUSES)[number]

export interface Project {
  schemaVersion: 1
  id: string
  workspaceId: string
  name: string
  status: ProjectStatus
  currentVersionId?: string
  createdBy: Readonly<CommandActor>
  createdAt: string
}

export type ProjectInput = Omit<Project, 'schemaVersion'>

export function normalizeProjectName(value: string): string {
  return value.trim().replace(/\s+/g, ' ')
}

export function createProject(input: ProjectInput): Readonly<Project> {
  const name = normalizeProjectName(input.name)

  assertDomain(input.id.trim().length > 0, 'INVALID_PROJECT', 'Project id is required')
  assertDomain(
    input.workspaceId.trim().length > 0,
    'INVALID_PROJECT',
    'Project workspaceId is required',
  )
  assertDomain(
    name.length >= 1 && name.length <= 120,
    'INVALID_PROJECT',
    'Project name must contain 1-120 characters',
    { length: name.length },
  )
  assertDomain(
    PROJECT_STATUSES.includes(input.status),
    'INVALID_PROJECT',
    'Unsupported project status',
    { status: input.status },
  )
  assertDomain(
    input.createdBy.id.trim().length > 0,
    'INVALID_PROJECT',
    'Project creator id is required',
  )
  assertDomain(
    !Number.isNaN(Date.parse(input.createdAt)),
    'INVALID_PROJECT',
    'Project createdAt must be an ISO-compatible date',
  )

  return Object.freeze({
    ...input,
    schemaVersion: 1 as const,
    name,
    createdBy: Object.freeze({ ...input.createdBy }),
  })
}
