import { calculateCanonicalHash } from './canonical-hash.ts'
import { DomainError, assertDomain } from './errors.ts'

export const DIRECTOR_BUDGET_DIMENSIONS = [
  'spendMinorUnits',
  'elapsedMs',
  'tokens',
  'generations',
  'candidates',
  'criticRounds',
] as const

export type DirectorBudgetDimension = (typeof DIRECTOR_BUDGET_DIMENSIONS)[number]
export type DirectorBudgetStatus = 'active' | 'budget_exhausted' | 'cancelled' | 'completed'
export type DirectorBudgetReservationStatus = 'reserved' | 'settled' | 'cancelled'

export interface DirectorBudgetUsage {
  spendMinorUnits: number
  elapsedMs: number
  tokens: number
  generations: number
  candidates: number
  criticRounds: number
}

export interface DirectorBudgetCandidateResult {
  id: string
  valid: boolean
  score: number
  payloadHash: string
}

export interface DirectorBudgetState {
  schemaVersion: 1
  id: string
  workspaceId: string
  projectId: string
  runId: string
  revision: number
  status: DirectorBudgetStatus
  limits: Readonly<DirectorBudgetUsage>
  reserved: Readonly<DirectorBudgetUsage>
  actual: Readonly<DirectorBudgetUsage>
  bestResult: Readonly<DirectorBudgetCandidateResult> | null
  exhaustedDimension: DirectorBudgetDimension | null
  createdAt: string
  updatedAt: string
}

export interface DirectorBudgetReservation {
  schemaVersion: 1
  id: string
  budgetId: string
  operationKind: string
  status: DirectorBudgetReservationStatus
  estimate: Readonly<DirectorBudgetUsage>
  actual: Readonly<DirectorBudgetUsage> | null
  overrun: Readonly<DirectorBudgetUsage> | null
  candidateResult: Readonly<DirectorBudgetCandidateResult> | null
  createdAt: string
  settledAt: string | null
}

const ID = /^[A-Za-z0-9][A-Za-z0-9._:-]{2,127}$/
const HASH = /^[a-f0-9]{64}$/

export function zeroDirectorBudgetUsage(): Readonly<DirectorBudgetUsage> {
  return Object.freeze({
    spendMinorUnits: 0,
    elapsedMs: 0,
    tokens: 0,
    generations: 0,
    candidates: 0,
    criticRounds: 0,
  })
}

export function validateDirectorBudgetUsage(
  input: DirectorBudgetUsage,
  field = 'Director budget usage',
): Readonly<DirectorBudgetUsage> {
  for (const dimension of DIRECTOR_BUDGET_DIMENSIONS) {
    assertDomain(
      Number.isSafeInteger(input[dimension]) && input[dimension] >= 0,
      'INVALID_ARGUMENT',
      `${field}.${dimension} must be a non-negative safe integer`,
    )
  }
  return Object.freeze({ ...input })
}

function timestamp(value: string, field: string): string {
  assertDomain(
    typeof value === 'string' && !Number.isNaN(new Date(value).getTime()),
    'INVALID_ARGUMENT',
    `${field} must be an ISO timestamp`,
  )
  return value
}

function identity(value: string, field: string): string {
  assertDomain(ID.test(value), 'INVALID_ARGUMENT', `${field} is invalid`)
  return value
}

function sum(left: DirectorBudgetUsage, right: DirectorBudgetUsage): Readonly<DirectorBudgetUsage> {
  return validateDirectorBudgetUsage(Object.fromEntries(
    DIRECTOR_BUDGET_DIMENSIONS.map((dimension) => [dimension, left[dimension] + right[dimension]]),
  ) as unknown as DirectorBudgetUsage)
}

function subtract(left: DirectorBudgetUsage, right: DirectorBudgetUsage): Readonly<DirectorBudgetUsage> {
  return validateDirectorBudgetUsage(Object.fromEntries(
    DIRECTOR_BUDGET_DIMENSIONS.map((dimension) => [dimension, Math.max(0, left[dimension] - right[dimension])]),
  ) as unknown as DirectorBudgetUsage)
}

function overrun(actual: DirectorBudgetUsage, estimate: DirectorBudgetUsage): Readonly<DirectorBudgetUsage> {
  return validateDirectorBudgetUsage(Object.fromEntries(
    DIRECTOR_BUDGET_DIMENSIONS.map((dimension) => [dimension, Math.max(0, actual[dimension] - estimate[dimension])]),
  ) as unknown as DirectorBudgetUsage)
}

function firstExceeded(
  limits: DirectorBudgetUsage,
  actual: DirectorBudgetUsage,
  reserved: DirectorBudgetUsage,
): DirectorBudgetDimension | null {
  return DIRECTOR_BUDGET_DIMENSIONS.find(
    (dimension) => actual[dimension] + reserved[dimension] > limits[dimension],
  ) ?? null
}

export function parseDirectorBudgetCandidateResult(value: DirectorBudgetCandidateResult): Readonly<DirectorBudgetCandidateResult> {
  assertDomain(ID.test(value.id), 'INVALID_ARGUMENT', 'Director budget candidate id is invalid')
  assertDomain(typeof value.valid === 'boolean', 'INVALID_ARGUMENT', 'Director budget candidate validity is invalid')
  assertDomain(Number.isFinite(value.score) && value.score >= 0 && value.score <= 1, 'INVALID_ARGUMENT', 'Director budget candidate score is invalid')
  assertDomain(HASH.test(value.payloadHash), 'INVALID_ARGUMENT', 'Director budget candidate hash is invalid')
  return Object.freeze({ ...value })
}

function betterCandidate(
  current: Readonly<DirectorBudgetCandidateResult> | null,
  candidate: Readonly<DirectorBudgetCandidateResult> | null,
): Readonly<DirectorBudgetCandidateResult> | null {
  if (!candidate?.valid) return current
  if (!current || candidate.score > current.score || (
    candidate.score === current.score && candidate.id.localeCompare(current.id) < 0
  )) return candidate
  return current
}

export function createDirectorBudget(input: {
  id: string
  workspaceId: string
  projectId: string
  runId: string
  limits: DirectorBudgetUsage
  createdAt: string
}): Readonly<DirectorBudgetState> {
  identity(input.id, 'Director budget id')
  identity(input.workspaceId, 'Director budget workspace id')
  identity(input.projectId, 'Director budget project id')
  identity(input.runId, 'Director budget run id')
  const createdAt = timestamp(input.createdAt, 'Director budget createdAt')
  return Object.freeze({
    schemaVersion: 1 as const,
    id: input.id,
    workspaceId: input.workspaceId,
    projectId: input.projectId,
    runId: input.runId,
    revision: 1,
    status: 'active' as const,
    limits: validateDirectorBudgetUsage(input.limits, 'Director budget limits'),
    reserved: zeroDirectorBudgetUsage(),
    actual: zeroDirectorBudgetUsage(),
    bestResult: null,
    exhaustedDimension: null,
    createdAt,
    updatedAt: createdAt,
  })
}

export function reserveDirectorBudget(input: {
  state: DirectorBudgetState
  reservationId: string
  operationKind: string
  estimate: DirectorBudgetUsage
  occurredAt: string
}): Readonly<{
  state: Readonly<DirectorBudgetState>
  reservation: Readonly<DirectorBudgetReservation> | null
  decision: 'reserved' | 'budget_exhausted'
}> {
  assertDomain(input.state.status === 'active', 'INVALID_ARGUMENT', 'Director budget is not active')
  identity(input.reservationId, 'Director budget reservation id')
  identity(input.operationKind, 'Director budget operation kind')
  const estimate = validateDirectorBudgetUsage(input.estimate, 'Director budget estimate')
  assertDomain(
    DIRECTOR_BUDGET_DIMENSIONS.some((dimension) => estimate[dimension] > 0),
    'INVALID_ARGUMENT',
    'Paid Director operation estimate must reserve at least one budget dimension',
  )
  const occurredAt = timestamp(input.occurredAt, 'Director budget reservation occurredAt')
  const reserved = sum(input.state.reserved, estimate)
  const exceeded = firstExceeded(input.state.limits, input.state.actual, reserved)
  if (exceeded) {
    return Object.freeze({
      state: Object.freeze({
        ...input.state,
        revision: input.state.revision + 1,
        status: 'budget_exhausted' as const,
        exhaustedDimension: exceeded,
        updatedAt: occurredAt,
      }),
      reservation: null,
      decision: 'budget_exhausted' as const,
    })
  }
  return Object.freeze({
    state: Object.freeze({
      ...input.state,
      revision: input.state.revision + 1,
      reserved,
      updatedAt: occurredAt,
    }),
    reservation: Object.freeze({
      schemaVersion: 1 as const,
      id: input.reservationId,
      budgetId: input.state.id,
      operationKind: input.operationKind,
      status: 'reserved' as const,
      estimate,
      actual: null,
      overrun: null,
      candidateResult: null,
      createdAt: occurredAt,
      settledAt: null,
    }),
    decision: 'reserved' as const,
  })
}

export function settleDirectorBudget(input: {
  state: DirectorBudgetState
  reservation: DirectorBudgetReservation
  actual: DirectorBudgetUsage
  candidateResult?: DirectorBudgetCandidateResult
  outcome: 'completed' | 'cancelled'
  occurredAt: string
}): Readonly<{
  state: Readonly<DirectorBudgetState>
  reservation: Readonly<DirectorBudgetReservation>
}> {
  assertDomain(
    ['active', 'budget_exhausted'].includes(input.state.status),
    'INVALID_ARGUMENT',
    'Director budget cannot settle work in its current state',
  )
  assertDomain(
    input.reservation.budgetId === input.state.id && input.reservation.status === 'reserved',
    'INVALID_ARGUMENT',
    'Director budget reservation is not open for settlement',
  )
  const actual = validateDirectorBudgetUsage(input.actual, 'Director budget actual usage')
  const candidateResult = input.candidateResult
    ? parseDirectorBudgetCandidateResult(input.candidateResult)
    : null
  const occurredAt = timestamp(input.occurredAt, 'Director budget settlement occurredAt')
  const reserved = subtract(input.state.reserved, input.reservation.estimate)
  const totalActual = sum(input.state.actual, actual)
  const exceeded = firstExceeded(input.state.limits, totalActual, reserved)
  const bestResult = betterCandidate(input.state.bestResult, candidateResult)
  return Object.freeze({
    state: Object.freeze({
      ...input.state,
      revision: input.state.revision + 1,
      status: exceeded ? 'budget_exhausted' as const : input.state.status,
      reserved,
      actual: totalActual,
      bestResult,
      exhaustedDimension: exceeded ?? input.state.exhaustedDimension,
      updatedAt: occurredAt,
    }),
    reservation: Object.freeze({
      ...input.reservation,
      status: input.outcome === 'completed' ? 'settled' as const : 'cancelled' as const,
      actual,
      overrun: overrun(actual, input.reservation.estimate),
      candidateResult,
      settledAt: occurredAt,
    }),
  })
}

export function cancelDirectorBudget(
  state: DirectorBudgetState,
  occurredAt: string,
): Readonly<DirectorBudgetState> {
  assertDomain(
    state.status === 'active' || state.status === 'budget_exhausted',
    'INVALID_ARGUMENT',
    'Director budget cannot be cancelled in its current state',
  )
  return Object.freeze({
    ...state,
    revision: state.revision + 1,
    status: 'cancelled' as const,
    reserved: zeroDirectorBudgetUsage(),
    updatedAt: timestamp(occurredAt, 'Director budget cancellation occurredAt'),
  })
}

export function concludeDirectorBudget(
  state: DirectorBudgetState,
  occurredAt: string,
): Readonly<{
  state: Readonly<DirectorBudgetState>
  outcome: 'completed-with-best-valid' | 'budget_exhausted' | 'no-valid-result'
  result: Readonly<DirectorBudgetCandidateResult> | null
  recoverable: boolean
}> {
  assertDomain(state.reserved[DIRECTOR_BUDGET_DIMENSIONS[0]] === 0 && DIRECTOR_BUDGET_DIMENSIONS.every(
    (dimension) => state.reserved[dimension] === 0,
  ), 'INVALID_ARGUMENT', 'Director budget still has open reservations')
  assertDomain(state.status !== 'cancelled' && state.status !== 'completed', 'INVALID_ARGUMENT', 'Director budget cannot be concluded')
  const outcome = state.bestResult
    ? 'completed-with-best-valid' as const
    : state.status === 'budget_exhausted'
      ? 'budget_exhausted' as const
      : 'no-valid-result' as const
  const next = Object.freeze({
    ...state,
    revision: state.revision + 1,
    status: state.bestResult ? 'completed' as const : state.status,
    updatedAt: timestamp(occurredAt, 'Director budget conclusion occurredAt'),
  })
  return Object.freeze({
    state: next,
    outcome,
    result: state.bestResult,
    recoverable: !state.bestResult,
  })
}

export function calculateDirectorBudgetFingerprint(value: unknown): string {
  return calculateCanonicalHash(value)
}
