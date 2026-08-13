import {
  parseDirectorBudgetCandidateResult,
  validateDirectorBudgetUsage,
  type DirectorBudgetCandidateResult,
  type DirectorBudgetReservation,
  type DirectorBudgetState,
  type DirectorBudgetUsage,
} from '../domain/director-budget.ts'
import type { DirectorBudgetMutationResult } from '../application/ports/director-budget-repository.ts'
import { DomainError, assertDomain } from '../domain/errors.ts'

function strict(value: unknown, allowed: readonly string[], field: string): Record<string, unknown> {
  assertDomain(value !== null && typeof value === 'object' && !Array.isArray(value), 'INVALID_ARGUMENT', `${field} must be an object`)
  const result = value as Record<string, unknown>
  assertDomain(Object.keys(result).every((key) => allowed.includes(key)), 'INVALID_ARGUMENT', `${field} contains unsupported properties`)
  return result
}

function usage(value: unknown, field: string): DirectorBudgetUsage {
  const input = strict(value, ['spendMinorUnits', 'elapsedMs', 'tokens', 'generations', 'candidates', 'criticRounds'], field)
  return validateDirectorBudgetUsage(input as unknown as DirectorBudgetUsage, field)
}

export function parseCreateDirectorBudgetBody(value: unknown): Readonly<{
  runId: string
  limits: DirectorBudgetUsage
}> {
  const input = strict(value, ['runId', 'limits'], 'Request body')
  assertDomain(typeof input.runId === 'string', 'INVALID_ARGUMENT', 'runId is required')
  return Object.freeze({ runId: input.runId, limits: usage(input.limits, 'limits') })
}

export type DirectorBudgetActionRequest = Readonly<
  | { action: 'reserve'; expectedRevision: number; operationKind: string; estimate: DirectorBudgetUsage }
  | { action: 'settle'; expectedRevision: number; reservationId: string; actual: DirectorBudgetUsage; outcome: 'completed' | 'cancelled'; candidateResult?: DirectorBudgetCandidateResult }
  | { action: 'cancel-run'; expectedRevision: number }
  | { action: 'conclude'; expectedRevision: number }
>

export function parseDirectorBudgetActionBody(value: unknown): DirectorBudgetActionRequest {
  const input = strict(value, ['action', 'baseRevision', 'operationKind', 'estimate', 'reservationId', 'actual', 'outcome', 'candidateResult'], 'Request body')
  assertDomain(typeof input.action === 'string' && Number.isSafeInteger(input.baseRevision) && (input.baseRevision as number) >= 1, 'INVALID_ARGUMENT', 'Director budget action and baseRevision are required')
  if (input.action === 'reserve') {
    assertDomain(typeof input.operationKind === 'string' && input.reservationId === undefined && input.actual === undefined && input.outcome === undefined && input.candidateResult === undefined, 'INVALID_ARGUMENT', 'Director budget reserve request is invalid')
    return Object.freeze({ action: 'reserve', expectedRevision: input.baseRevision as number, operationKind: input.operationKind, estimate: usage(input.estimate, 'estimate') })
  }
  if (input.action === 'settle') {
    assertDomain(typeof input.reservationId === 'string' && (input.outcome === 'completed' || input.outcome === 'cancelled') && input.operationKind === undefined && input.estimate === undefined, 'INVALID_ARGUMENT', 'Director budget settlement request is invalid')
    return Object.freeze({
      action: 'settle',
      expectedRevision: input.baseRevision as number,
      reservationId: input.reservationId,
      actual: usage(input.actual, 'actual'),
      outcome: input.outcome,
      ...(input.candidateResult ? { candidateResult: parseDirectorBudgetCandidateResult(input.candidateResult as DirectorBudgetCandidateResult) } : {}),
    })
  }
  assertDomain(
    (input.action === 'cancel-run' || input.action === 'conclude') &&
    input.operationKind === undefined && input.estimate === undefined && input.reservationId === undefined && input.actual === undefined && input.outcome === undefined && input.candidateResult === undefined,
    'INVALID_ARGUMENT',
    'Director budget action request is invalid',
  )
  return Object.freeze({ action: input.action, expectedRevision: input.baseRevision as number })
}

export function presentDirectorBudget(state: Readonly<DirectorBudgetState>) {
  return {
    schemaVersion: state.schemaVersion,
    id: state.id,
    projectId: state.projectId,
    runId: state.runId,
    revision: state.revision,
    status: state.status,
    estimated: state.reserved,
    realized: state.actual,
    limits: state.limits,
    bestResult: state.bestResult,
    exhaustedDimension: state.exhaustedDimension,
    createdAt: state.createdAt,
    updatedAt: state.updatedAt,
  }
}

export function presentDirectorBudgetReservation(reservation: Readonly<DirectorBudgetReservation> | null) {
  if (!reservation) return null
  return {
    schemaVersion: reservation.schemaVersion,
    id: reservation.id,
    operationKind: reservation.operationKind,
    status: reservation.status,
    estimated: reservation.estimate,
    realized: reservation.actual,
    overrun: reservation.overrun,
    candidateResult: reservation.candidateResult,
    createdAt: reservation.createdAt,
    settledAt: reservation.settledAt,
  }
}

export function presentDirectorBudgetMutation(result: Readonly<DirectorBudgetMutationResult>) {
  return {
    budget: presentDirectorBudget(result.state),
    reservation: presentDirectorBudgetReservation(result.reservation),
    outcome: result.outcome,
    replayed: result.replayed,
  }
}
