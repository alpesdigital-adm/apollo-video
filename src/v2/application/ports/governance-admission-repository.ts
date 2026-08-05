import type {
  GovernanceAdmission,
  GovernanceCostClass,
  GovernanceOperationKind,
} from '../../domain/governance-admission.ts'
import type {
  GovernanceLimits,
  GovernanceRequestedUsage,
} from '../../domain/governance-limits.ts'

export interface GovernanceAdmissionDraft {
  id: string
  workspaceId: string
  clientId: string
  capabilityId: string
  environment: 'sandbox' | 'production'
  operationKind: GovernanceOperationKind
  costClass: GovernanceCostClass
  requested: Readonly<Required<GovernanceRequestedUsage>>
  createdAt: string
}

export interface GovernanceAdmissionListQuery {
  workspaceId: string
  limit: number
  after?: Readonly<{ createdAt: string; id: string }>
}

export interface GovernanceAdmissionRepository {
  admit(input: {
    draft: Readonly<GovernanceAdmissionDraft>
    defaultLimits: Readonly<GovernanceLimits>
  }): Promise<Readonly<GovernanceAdmission>>
  list(
    input: GovernanceAdmissionListQuery,
  ): Promise<readonly Readonly<GovernanceAdmission>[]>
}
