import type {
  GovernanceAdmission,
  GovernanceCostClass,
  GovernanceOperationKind,
} from '../../domain/governance-admission.ts'
import type {
  GovernanceLimits,
  GovernanceRequestedUsage,
} from '../../domain/governance-limits.ts'
import type {
  GovernanceAnomalyPolicy,
} from '../../domain/governance-anomaly.ts'
import type { GovernanceAlert } from '../../domain/governance-alert.ts'

export interface GovernanceAdmissionDraft {
  id: string
  workspaceId: string
  clientId: string
  capabilityId: string
  environment: 'sandbox' | 'production'
  operationKind: GovernanceOperationKind
  costClass: GovernanceCostClass
  requested: Readonly<Required<GovernanceRequestedUsage>>
  anomalyRecoveryAuthorized: boolean
  createdAt: string
}

export interface GovernanceAdmissionListQuery {
  workspaceId: string
  limit: number
  after?: Readonly<{ createdAt: string; id: string }>
}

export interface GovernanceAlertListQuery {
  workspaceId: string
  limit: number
  after?: Readonly<{ createdAt: string; alertHash: string }>
}

export interface GovernanceAdmissionRepository {
  admit(input: {
    draft: Readonly<GovernanceAdmissionDraft>
    defaultLimits: Readonly<GovernanceLimits>
    anomalyPolicy: Readonly<GovernanceAnomalyPolicy>
  }): Promise<Readonly<GovernanceAdmission>>
  list(
    input: GovernanceAdmissionListQuery,
  ): Promise<readonly Readonly<GovernanceAdmission>[]>
  listAlerts(
    input: GovernanceAlertListQuery,
  ): Promise<readonly Readonly<GovernanceAlert>[]>
}
