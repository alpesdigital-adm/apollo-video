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
