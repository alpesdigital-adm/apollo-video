import type { WorkspaceMember, WorkspaceMemberRole } from '../../domain/workspace-member.ts'

export interface WorkspaceMemberRepository {
  provisionBootstrapMembership(input: Readonly<{
    identityId: string
    memberId: string
    issuer: string
    subjectHash: string
    workspaceId: string
    role: WorkspaceMemberRole
    now: string
  }>): Promise<Readonly<WorkspaceMember>>
  findActiveById(input: Readonly<{
    memberId: string
    workspaceId: string
  }>): Promise<Readonly<WorkspaceMember> | null>
}
