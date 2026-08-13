import type { ApiAccessAuditContext } from '../../domain/api-access-control.ts'
import type {
  DirectorBudgetCandidateResult,
  DirectorBudgetReservation,
  DirectorBudgetState,
  DirectorBudgetUsage,
} from '../../domain/director-budget.ts'

export interface DirectorBudgetCommandContext {
  eventId: string
  idempotencyKey: string
  requestFingerprint: string
  audit: Readonly<ApiAccessAuditContext>
  occurredAt: string
}

export interface DirectorBudgetMutationResult {
  state: Readonly<DirectorBudgetState>
  reservation: Readonly<DirectorBudgetReservation> | null
  outcome: string
  replayed: boolean
}

export interface DirectorBudgetRepository {
  createOrReplay(input: {
    state: Readonly<DirectorBudgetState>
    command: Readonly<DirectorBudgetCommandContext>
  }): Promise<Readonly<DirectorBudgetMutationResult>>
  reserveOrReplay(input: {
    workspaceId: string
    projectId: string
    runId: string
    expectedRevision: number
    reservationId: string
    operationKind: string
    estimate: Readonly<DirectorBudgetUsage>
    command: Readonly<DirectorBudgetCommandContext>
  }): Promise<Readonly<DirectorBudgetMutationResult>>
  settleOrReplay(input: {
    workspaceId: string
    projectId: string
    runId: string
    expectedRevision: number
    reservationId: string
    actual: Readonly<DirectorBudgetUsage>
    outcome: 'completed' | 'cancelled'
    candidateResult?: Readonly<DirectorBudgetCandidateResult>
    command: Readonly<DirectorBudgetCommandContext>
  }): Promise<Readonly<DirectorBudgetMutationResult>>
  cancelOrReplay(input: {
    workspaceId: string
    projectId: string
    runId: string
    expectedRevision: number
    command: Readonly<DirectorBudgetCommandContext>
  }): Promise<Readonly<DirectorBudgetMutationResult>>
  concludeOrReplay(input: {
    workspaceId: string
    projectId: string
    runId: string
    expectedRevision: number
    command: Readonly<DirectorBudgetCommandContext>
  }): Promise<Readonly<DirectorBudgetMutationResult>>
  get(input: {
    workspaceId: string
    projectId: string
    runId: string
  }): Promise<Readonly<DirectorBudgetState> | null>
  list(input: {
    workspaceId: string
    projectId: string
    limit: number
  }): Promise<readonly Readonly<DirectorBudgetState>[]>
}
