import { assertDomain } from './errors.ts'

export const WORKSPACE_MEMBER_ROLES = ['administrator', 'director', 'operator', 'reviewer'] as const
export const WORKSPACE_MEMBER_STATUSES = ['active', 'suspended', 'removed'] as const

export type WorkspaceMemberRole = (typeof WORKSPACE_MEMBER_ROLES)[number]
export type WorkspaceMemberStatus = (typeof WORKSPACE_MEMBER_STATUSES)[number]

export interface WorkspaceMember {
  id: string
  workspaceId: string
  identityId: string
  role: WorkspaceMemberRole
  status: WorkspaceMemberStatus
  createdAt: string
}

export function assertWorkspaceMemberRole(value: string): asserts value is WorkspaceMemberRole {
  assertDomain(
    WORKSPACE_MEMBER_ROLES.includes(value as WorkspaceMemberRole),
    'INVALID_ARGUMENT',
    'Workspace member role is invalid',
  )
}
