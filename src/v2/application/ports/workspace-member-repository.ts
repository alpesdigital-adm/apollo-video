import type { SelectableWorkspaceMembership, WorkspaceMember, WorkspaceMemberRole } from '../../domain/workspace-member.ts'

export interface WorkspaceMemberRepository {
  provisionMembership(input: Readonly<{
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
  provisionBootstrapUiPrincipal(input: Readonly<{
    workspaceId: string
    clientId: string
    now: string
  }>): Promise<void>
  listSelectableForMember(input: Readonly<{
    memberId: string
  }>): Promise<readonly Readonly<SelectableWorkspaceMembership>[]>
  resolveSelectableForMember(input: Readonly<{
    memberId: string
    workspaceId: string
  }>): Promise<Readonly<SelectableWorkspaceMembership> | null>
  resolveActiveOidcMembership(input: Readonly<{
    issuer: string
    subjectHash: string
  }>): Promise<Readonly<SelectableWorkspaceMembership> | null>
}
