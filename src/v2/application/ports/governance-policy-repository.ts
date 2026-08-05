import type { ApiAccessAuditContext } from '../../domain/api-access-control.ts'
import type { GovernancePolicy } from '../../domain/governance-limits.ts'
import type { GovernancePolicyCommand } from '../../domain/governance-policy-command.ts'

export interface GovernancePolicyMutationResult {
  readonly action: GovernancePolicyCommand['action']
  readonly policy?: Readonly<GovernancePolicy>
  readonly deletedPolicyId?: string
  readonly commandHash: string
  readonly replayed: boolean
}

export interface GovernancePolicyRepository {
  list(input: { workspaceId: string }): Promise<readonly Readonly<GovernancePolicy>[]>
  findByScope(input: {
    workspaceId: string
    scopeType: GovernancePolicy['scopeType']
    scopeId: string
    environment: GovernancePolicy['environment']
  }): Promise<Readonly<GovernancePolicy> | null>
  findById(input: {
    workspaceId: string
    policyId: string
  }): Promise<Readonly<GovernancePolicy> | null>
  findReplay(input: {
    workspaceId: string
    actorContextHash: string
    idempotencyKey: string
    requestFingerprint: string
  }): Promise<Readonly<GovernancePolicyMutationResult> | null>
  applySet(input: {
    policy: Readonly<GovernancePolicy>
    command: Readonly<GovernancePolicyCommand>
    audit: Readonly<ApiAccessAuditContext>
  }): Promise<Readonly<GovernancePolicyMutationResult>>
  applyDelete(input: {
    command: Readonly<GovernancePolicyCommand>
    audit: Readonly<ApiAccessAuditContext>
  }): Promise<Readonly<GovernancePolicyMutationResult>>
}
