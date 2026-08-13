import type { AuthenticatedExternalActor } from './authenticate-api-client.ts'
import { materializeActorAuditContext } from './authenticate-api-client.ts'
import type {
  DirectorBudgetRepository,
  DirectorBudgetCommandContext,
} from './ports/director-budget-repository.ts'
import {
  calculateDirectorBudgetFingerprint,
  createDirectorBudget,
  parseDirectorBudgetCandidateResult,
  validateDirectorBudgetUsage,
  type DirectorBudgetCandidateResult,
  type DirectorBudgetUsage,
} from '../domain/director-budget.ts'
import { DomainError, assertDomain } from '../domain/errors.ts'

const IDEMPOTENCY_KEY = /^[A-Za-z0-9][A-Za-z0-9._:-]{0,127}$/
const ID = /^[A-Za-z0-9][A-Za-z0-9._:-]{2,127}$/

function id(value: string, field: string): string {
  assertDomain(ID.test(value), 'INVALID_ARGUMENT', `${field} is invalid`)
  return value
}

function revision(value: number): number {
  assertDomain(Number.isSafeInteger(value) && value >= 1, 'INVALID_ARGUMENT', 'Director budget expected revision is invalid')
  return value
}

function command(input: {
  action: string
  payload: unknown
  actor: AuthenticatedExternalActor
  idempotencyKey: string
  occurredAt: string
  createId: () => string
}): Readonly<DirectorBudgetCommandContext> {
  assertDomain(IDEMPOTENCY_KEY.test(input.idempotencyKey), 'INVALID_ARGUMENT', 'Idempotency key must contain 1 to 128 safe characters')
  const audit = materializeActorAuditContext(input.actor)
  return Object.freeze({
    eventId: id(input.createId(), 'Director budget event id'),
    idempotencyKey: input.idempotencyKey,
    requestFingerprint: calculateDirectorBudgetFingerprint({
      schemaVersion: 'director-budget-command/v1',
      action: input.action,
      payload: input.payload,
      actorContextHash: audit.contextHash,
    }),
    audit,
    occurredAt: input.occurredAt,
  })
}

export function directorBudgetService(dependencies: {
  repository: DirectorBudgetRepository
  clock?: () => Date
  createId: (kind: 'budget' | 'reservation' | 'event') => string
}) {
  const clock = dependencies.clock ?? (() => new Date())
  const occurredAt = () => clock().toISOString()
  return Object.freeze({
    async create(input: {
      workspaceId: string
      projectId: string
      runId: string
      limits: DirectorBudgetUsage
      actor: AuthenticatedExternalActor
      idempotencyKey: string
    }) {
      const at = occurredAt()
      const state = createDirectorBudget({
        id: dependencies.createId('budget'),
        workspaceId: input.workspaceId,
        projectId: input.projectId,
        runId: input.runId,
        limits: input.limits,
        createdAt: at,
      })
      return dependencies.repository.createOrReplay({
        state,
        command: command({
          action: 'create',
          payload: { workspaceId: input.workspaceId, projectId: input.projectId, runId: input.runId, limits: state.limits },
          actor: input.actor,
          idempotencyKey: input.idempotencyKey,
          occurredAt: at,
          createId: () => dependencies.createId('event'),
        }),
      })
    },

    async reserve(input: {
      workspaceId: string
      projectId: string
      runId: string
      expectedRevision: number
      operationKind: string
      estimate: DirectorBudgetUsage
      actor: AuthenticatedExternalActor
      idempotencyKey: string
    }) {
      const at = occurredAt()
      const estimate = validateDirectorBudgetUsage(input.estimate, 'Director budget estimate')
      const expectedRevision = revision(input.expectedRevision)
      const operationKind = id(input.operationKind, 'Director budget operation kind')
      return dependencies.repository.reserveOrReplay({
        workspaceId: id(input.workspaceId, 'Workspace id'),
        projectId: id(input.projectId, 'Project id'),
        runId: id(input.runId, 'Director run id'),
        expectedRevision,
        reservationId: dependencies.createId('reservation'),
        operationKind,
        estimate,
        command: command({
          action: 'reserve',
          payload: { runId: input.runId, expectedRevision, operationKind, estimate },
          actor: input.actor,
          idempotencyKey: input.idempotencyKey,
          occurredAt: at,
          createId: () => dependencies.createId('event'),
        }),
      })
    },

    async settle(input: {
      workspaceId: string
      projectId: string
      runId: string
      expectedRevision: number
      reservationId: string
      actual: DirectorBudgetUsage
      outcome: 'completed' | 'cancelled'
      candidateResult?: DirectorBudgetCandidateResult
      actor: AuthenticatedExternalActor
      idempotencyKey: string
    }) {
      const at = occurredAt()
      const expectedRevision = revision(input.expectedRevision)
      const reservationId = id(input.reservationId, 'Director budget reservation id')
      const actual = validateDirectorBudgetUsage(input.actual, 'Director budget actual usage')
      assertDomain(input.outcome === 'completed' || input.outcome === 'cancelled', 'INVALID_ARGUMENT', 'Director budget settlement outcome is invalid')
      const candidateResult = input.candidateResult
        ? parseDirectorBudgetCandidateResult(input.candidateResult)
        : undefined
      return dependencies.repository.settleOrReplay({
        workspaceId: id(input.workspaceId, 'Workspace id'),
        projectId: id(input.projectId, 'Project id'),
        runId: id(input.runId, 'Director run id'),
        expectedRevision,
        reservationId,
        actual,
        outcome: input.outcome,
        ...(candidateResult ? { candidateResult } : {}),
        command: command({
          action: input.outcome === 'completed' ? 'settle' : 'cancel-reservation',
          payload: { runId: input.runId, expectedRevision, reservationId, actual, outcome: input.outcome, candidateResult: candidateResult ?? null },
          actor: input.actor,
          idempotencyKey: input.idempotencyKey,
          occurredAt: at,
          createId: () => dependencies.createId('event'),
        }),
      })
    },

    async cancel(input: {
      workspaceId: string
      projectId: string
      runId: string
      expectedRevision: number
      actor: AuthenticatedExternalActor
      idempotencyKey: string
    }) {
      const at = occurredAt()
      const expectedRevision = revision(input.expectedRevision)
      return dependencies.repository.cancelOrReplay({
        workspaceId: id(input.workspaceId, 'Workspace id'),
        projectId: id(input.projectId, 'Project id'),
        runId: id(input.runId, 'Director run id'),
        expectedRevision,
        command: command({
          action: 'cancel-run',
          payload: { runId: input.runId, expectedRevision },
          actor: input.actor,
          idempotencyKey: input.idempotencyKey,
          occurredAt: at,
          createId: () => dependencies.createId('event'),
        }),
      })
    },

    async conclude(input: {
      workspaceId: string
      projectId: string
      runId: string
      expectedRevision: number
      actor: AuthenticatedExternalActor
      idempotencyKey: string
    }) {
      const at = occurredAt()
      const expectedRevision = revision(input.expectedRevision)
      return dependencies.repository.concludeOrReplay({
        workspaceId: id(input.workspaceId, 'Workspace id'),
        projectId: id(input.projectId, 'Project id'),
        runId: id(input.runId, 'Director run id'),
        expectedRevision,
        command: command({
          action: 'conclude',
          payload: { runId: input.runId, expectedRevision },
          actor: input.actor,
          idempotencyKey: input.idempotencyKey,
          occurredAt: at,
          createId: () => dependencies.createId('event'),
        }),
      })
    },

    async get(input: { workspaceId: string; projectId: string; runId: string }) {
      const state = await dependencies.repository.get(input)
      if (!state) throw new DomainError('PROJECT_NOT_FOUND', 'Director budget was not found')
      return state
    },

    list(input: { workspaceId: string; projectId: string; limit?: number }) {
      const limit = input.limit ?? 50
      assertDomain(Number.isSafeInteger(limit) && limit >= 1 && limit <= 100, 'INVALID_ARGUMENT', 'Director budget list limit must be between 1 and 100')
      return dependencies.repository.list({ ...input, limit })
    },
  })
}
