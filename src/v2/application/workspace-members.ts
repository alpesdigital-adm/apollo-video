import { assertDomain, DomainError } from '../domain/errors.ts'
import { assertWorkspaceMemberRole, type WorkspaceMemberRole } from '../domain/workspace-member.ts'
import type { WorkspaceMemberRepository } from './ports/workspace-member-repository.ts'

const HASH = /^[a-f0-9]{64}$/

export function provisionBootstrapWorkspaceMemberService(dependencies: {
  members: WorkspaceMemberRepository
  id: () => string
  clock?: () => Date
}) {
  return async function provision(input: {
    issuer: string
    subjectHash: string
    workspaceId: string
    role: WorkspaceMemberRole
  }) {
    assertDomain(input.issuer === 'urn:apollo:bootstrap', 'AUTH_INVALID', 'Bootstrap identity issuer is invalid')
    assertDomain(HASH.test(input.subjectHash), 'INVALID_ARGUMENT', 'Identity subject hash is invalid')
    assertDomain(input.workspaceId.trim().length > 0, 'INVALID_ARGUMENT', 'Workspace is required')
    assertWorkspaceMemberRole(input.role)
    const now = (dependencies.clock?.() ?? new Date()).toISOString()
    const member = await dependencies.members.provisionBootstrapMembership({
      identityId: dependencies.id(), memberId: dependencies.id(), ...input, now,
    })
    if (member.status !== 'active') throw new DomainError('AUTH_INVALID', 'Workspace membership is not active')
    return member
  }
}

export function provisionBootstrapWorkspaceUiPrincipalService(dependencies: {
  members: WorkspaceMemberRepository
  clock?: () => Date
}) {
  return async function provision(input: { workspaceId: string; clientId: string }) {
    assertDomain(input.workspaceId.trim().length > 0, 'INVALID_ARGUMENT', 'Workspace is required')
    assertDomain(/^[A-Za-z0-9_-]{3,80}$/.test(input.clientId), 'INVALID_ARGUMENT', 'UI client is invalid')
    await dependencies.members.provisionBootstrapUiPrincipal({
      ...input,
      now: (dependencies.clock?.() ?? new Date()).toISOString(),
    })
  }
}

export function listSelectableWorkspacesService(dependencies: { members: WorkspaceMemberRepository }) {
  return async function list(memberId: string) {
    assertDomain(/^[0-9a-f-]{36}$/.test(memberId), 'AUTH_INVALID', 'Workspace member is invalid')
    return dependencies.members.listSelectableForMember({ memberId })
  }
}

export function resolveWorkspaceSwitchTargetService(dependencies: { members: WorkspaceMemberRepository }) {
  return async function resolve(input: { memberId: string; workspaceId: string }) {
    assertDomain(/^[0-9a-f-]{36}$/.test(input.memberId), 'AUTH_INVALID', 'Workspace member is invalid')
    assertDomain(input.workspaceId.trim().length > 0 && input.workspaceId.length <= 128, 'INVALID_ARGUMENT', 'Workspace is invalid')
    const target = await dependencies.members.resolveSelectableForMember(input)
    if (!target) throw new DomainError('AUTH_INVALID', 'Workspace is not available to this identity')
    return target
  }
}
