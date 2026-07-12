import { assertDomain } from './errors.ts'

export const WORKSPACE_STATUSES = ['active', 'suspended', 'archived'] as const

export type WorkspaceStatus = (typeof WORKSPACE_STATUSES)[number]

export interface Workspace {
  schemaVersion: 1
  id: string
  slug: string
  name: string
  status: WorkspaceStatus
  createdAt: string
}

export type WorkspaceInput = Omit<Workspace, 'schemaVersion'>

export function normalizeWorkspaceSlug(value: string): string {
  return value.trim().toLowerCase()
}

export function createWorkspace(input: WorkspaceInput): Readonly<Workspace> {
  const slug = normalizeWorkspaceSlug(input.slug)
  const name = input.name.trim().replace(/\s+/g, ' ')

  assertDomain(input.id.trim().length > 0, 'INVALID_WORKSPACE', 'Workspace id is required')
  assertDomain(
    /^[a-z0-9](?:[a-z0-9-]{1,61}[a-z0-9])?$/.test(slug),
    'INVALID_WORKSPACE',
    'Workspace slug must use 3-63 lowercase letters, numbers or internal hyphens',
    { slug },
  )
  assertDomain(
    name.length >= 2 && name.length <= 120,
    'INVALID_WORKSPACE',
    'Workspace name must contain 2-120 characters',
    { length: name.length },
  )
  assertDomain(
    WORKSPACE_STATUSES.includes(input.status),
    'INVALID_WORKSPACE',
    'Unsupported workspace status',
    { status: input.status },
  )
  assertDomain(
    !Number.isNaN(Date.parse(input.createdAt)),
    'INVALID_WORKSPACE',
    'Workspace createdAt must be an ISO-compatible date',
  )

  return Object.freeze({
    ...input,
    schemaVersion: 1 as const,
    slug,
    name,
  })
}
