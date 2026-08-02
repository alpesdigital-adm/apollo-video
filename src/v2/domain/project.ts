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

const projectStatuses = (...values: ProjectStatus[]): readonly ProjectStatus[] =>
  Object.freeze(values)

export const PROJECT_STATUS_TRANSITIONS: Readonly<Record<ProjectStatus, readonly ProjectStatus[]>> =
  Object.freeze({
    draft: projectStatuses('ingesting', 'perceiving', 'reviewing-proxy', 'revising', 'canceled', 'archived'),
    ingesting: projectStatuses('draft', 'failed', 'canceled'),
    perceiving: projectStatuses('planning', 'failed', 'canceled'),
    planning: projectStatuses('generating', 'failed', 'canceled'),
    generating: projectStatuses('reviewing-assets', 'rendering-proxy', 'failed', 'canceled'),
    'reviewing-assets': projectStatuses('generating', 'rendering-proxy', 'failed', 'canceled'),
    'rendering-proxy': projectStatuses('reviewing-proxy', 'revising', 'failed', 'canceled'),
    'reviewing-proxy': projectStatuses('revising', 'rendering-final', 'failed', 'canceled'),
    revising: projectStatuses('rendering-proxy', 'reviewing-proxy', 'failed', 'canceled'),
    'rendering-final': projectStatuses('completed', 'failed', 'canceled'),
    completed: projectStatuses('archived'),
    failed: projectStatuses('ingesting', 'canceled', 'archived'),
    canceled: projectStatuses('archived'),
    archived: projectStatuses(),
  })

export function canTransitionProjectStatus(from: ProjectStatus, to: ProjectStatus): boolean {
  return from === to || PROJECT_STATUS_TRANSITIONS[from].includes(to)
}

export function projectStatusTransitionSources(
  to: ProjectStatus,
  options: { includeSame?: boolean } = {},
): ProjectStatus[] {
  return PROJECT_STATUSES.filter((from) =>
    (options.includeSame === true && from === to) || PROJECT_STATUS_TRANSITIONS[from].includes(to))
}

export function projectStatusTransitionPath(
  from: ProjectStatus,
  to: ProjectStatus,
  options: { includeSame?: boolean } = {},
): ProjectStatus[] {
  assertProjectStatusTransition(from, to)
  return from === to || options.includeSame !== true ? [from] : [from, to]
}

export function assertProjectStatusTransition(from: ProjectStatus, to: ProjectStatus): void {
  assertDomain(
    canTransitionProjectStatus(from, to),
    'PROJECT_TRANSITION_REJECTED',
    'Project status transition is not allowed',
    { from, to },
  )
}

export interface Project {
  schemaVersion: 1
  id: string
  workspaceId: string
  name: string
  status: ProjectStatus
  objective?: string
  format?: string
  locale?: string
  ownerId?: string
  currentVersionId?: string
  duplicatedFromProjectId?: string
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
  for (const [field, value] of Object.entries({
    objective: input.objective,
    format: input.format,
    locale: input.locale,
    ownerId: input.ownerId,
    duplicatedFromProjectId: input.duplicatedFromProjectId,
  })) {
    assertDomain(value === undefined || value.trim().length > 0, 'INVALID_PROJECT', `Project ${field} cannot be blank`)
  }
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
