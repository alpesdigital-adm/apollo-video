import { Prisma, type PrismaClient } from '../../../../generated/prisma-v2/index.js'

import type {
  DirectorBudgetCommandContext,
  DirectorBudgetMutationResult,
  DirectorBudgetRepository,
} from '../../application/ports/director-budget-repository.ts'
import {
  calculateDirectorBudgetFingerprint,
  cancelDirectorBudget,
  concludeDirectorBudget,
  parseDirectorBudgetCandidateResult,
  reserveDirectorBudget,
  settleDirectorBudget,
  validateDirectorBudgetUsage,
  type DirectorBudgetReservation,
  type DirectorBudgetState,
  type DirectorBudgetUsage,
} from '../../domain/director-budget.ts'
import { DomainError } from '../../domain/errors.ts'
import { getV2PostgresClient } from '../prisma-postgres/client.ts'
import { externalActorAuditData, hydrateExternalActorAudit } from './external-actor-audit.ts'

type Transaction = Prisma.TransactionClient

function record(value: string, field: string): Record<string, unknown> {
  try {
    const parsed = JSON.parse(value) as unknown
    if (!parsed || typeof parsed !== 'object' || Array.isArray(parsed)) throw new Error('invalid')
    return parsed as Record<string, unknown>
  } catch {
    throw new DomainError('PERSISTENCE_CONFLICT', `Stored ${field} is invalid`)
  }
}

function usage(value: string, field: string): Readonly<DirectorBudgetUsage> {
  return validateDirectorBudgetUsage(record(value, field) as unknown as DirectorBudgetUsage, field)
}

function hydrateState(row: {
  id: string
  workspaceId: string
  projectId: string
  runId: string
  revision: number
  status: string
  limitsJson: string
  reservedJson: string
  actualJson: string
  bestResultJson: string | null
  exhaustedDimension: string | null
  createdAt: Date
  updatedAt: Date
}): Readonly<DirectorBudgetState> {
  if (
    !Number.isSafeInteger(row.revision) || row.revision < 1 ||
    !['active', 'budget_exhausted', 'cancelled', 'completed'].includes(row.status)
  ) throw new DomainError('PERSISTENCE_CONFLICT', 'Stored Director budget state is invalid')
  const bestResult = row.bestResultJson
    ? parseDirectorBudgetCandidateResult(record(row.bestResultJson, 'Director budget best result') as unknown as Parameters<typeof parseDirectorBudgetCandidateResult>[0])
    : null
  return Object.freeze({
    schemaVersion: 1 as const,
    id: row.id,
    workspaceId: row.workspaceId,
    projectId: row.projectId,
    runId: row.runId,
    revision: row.revision,
    status: row.status as DirectorBudgetState['status'],
    limits: usage(row.limitsJson, 'Director budget limits'),
    reserved: usage(row.reservedJson, 'Director budget reserved usage'),
    actual: usage(row.actualJson, 'Director budget actual usage'),
    bestResult,
    exhaustedDimension: row.exhaustedDimension as DirectorBudgetState['exhaustedDimension'],
    createdAt: row.createdAt.toISOString(),
    updatedAt: row.updatedAt.toISOString(),
  })
}

function hydrateReservation(row: {
  id: string
  budgetId: string
  operationKind: string
  status: string
  estimateJson: string
  actualJson: string | null
  overrunJson: string | null
  candidateJson: string | null
  createdAt: Date
  settledAt: Date | null
}): Readonly<DirectorBudgetReservation> {
  if (!['reserved', 'settled', 'cancelled'].includes(row.status)) {
    throw new DomainError('PERSISTENCE_CONFLICT', 'Stored Director budget reservation status is invalid')
  }
  return Object.freeze({
    schemaVersion: 1 as const,
    id: row.id,
    budgetId: row.budgetId,
    operationKind: row.operationKind,
    status: row.status as DirectorBudgetReservation['status'],
    estimate: usage(row.estimateJson, 'Director budget reservation estimate'),
    actual: row.actualJson ? usage(row.actualJson, 'Director budget reservation actual usage') : null,
    overrun: row.overrunJson ? usage(row.overrunJson, 'Director budget reservation overrun') : null,
    candidateResult: row.candidateJson
      ? parseDirectorBudgetCandidateResult(record(row.candidateJson, 'Director budget reservation candidate') as unknown as Parameters<typeof parseDirectorBudgetCandidateResult>[0])
      : null,
    createdAt: row.createdAt.toISOString(),
    settledAt: row.settledAt?.toISOString() ?? null,
  })
}

function stateData(state: Readonly<DirectorBudgetState>) {
  return {
    revision: state.revision,
    status: state.status,
    limitsJson: JSON.stringify(state.limits),
    reservedJson: JSON.stringify(state.reserved),
    actualJson: JSON.stringify(state.actual),
    bestResultJson: state.bestResult ? JSON.stringify(state.bestResult) : null,
    exhaustedDimension: state.exhaustedDimension,
    updatedAt: new Date(state.updatedAt),
  }
}

function resultJson(result: Omit<DirectorBudgetMutationResult, 'replayed'>): string {
  return JSON.stringify({ state: result.state, reservation: result.reservation, outcome: result.outcome })
}

function hydrateReplay(value: string, expectedHash: string): Readonly<DirectorBudgetMutationResult> {
  const result = record(value, 'Director budget event result')
  if (calculateDirectorBudgetFingerprint(result) !== expectedHash) {
    throw new DomainError('PERSISTENCE_CONFLICT', 'Stored Director budget event result hash is inconsistent')
  }
  const state = result.state as DirectorBudgetState
  const reservation = (result.reservation ?? null) as DirectorBudgetReservation | null
  if (
    !state || state.schemaVersion !== 1 || typeof result.outcome !== 'string' ||
    !Number.isSafeInteger(state.revision) || state.revision < 1 ||
    !['active', 'budget_exhausted', 'cancelled', 'completed'].includes(state.status) ||
    typeof state.id !== 'string' || typeof state.workspaceId !== 'string' ||
    typeof state.projectId !== 'string' || typeof state.runId !== 'string'
  ) {
    throw new DomainError('PERSISTENCE_CONFLICT', 'Stored Director budget event result is inconsistent')
  }
  validateDirectorBudgetUsage(state.limits, 'Director budget replay limits')
  validateDirectorBudgetUsage(state.reserved, 'Director budget replay reserved usage')
  validateDirectorBudgetUsage(state.actual, 'Director budget replay actual usage')
  if (reservation) {
    if (
      reservation.schemaVersion !== 1 || reservation.budgetId !== state.id ||
      !['reserved', 'settled', 'cancelled'].includes(reservation.status)
    ) throw new DomainError('PERSISTENCE_CONFLICT', 'Stored Director budget replay reservation is inconsistent')
    validateDirectorBudgetUsage(reservation.estimate, 'Director budget replay estimate')
    if (reservation.actual) validateDirectorBudgetUsage(reservation.actual, 'Director budget replay actual usage')
  }
  return Object.freeze({ state: Object.freeze(state), reservation: reservation ? Object.freeze(reservation) : null, outcome: result.outcome, replayed: true })
}

function eventData(input: {
  budgetId: string
  workspaceId: string
  projectId: string
  reservationId?: string
  action: string
  baseRevision: number
  result: Omit<DirectorBudgetMutationResult, 'replayed'>
  estimate?: Readonly<DirectorBudgetUsage>
  actual?: Readonly<DirectorBudgetUsage>
  command: Readonly<DirectorBudgetCommandContext>
}) {
  const serializedResult = resultJson(input.result)
  return {
    id: input.command.eventId,
    budgetId: input.budgetId,
    ...(input.reservationId ? { reservationId: input.reservationId } : {}),
    workspaceId: input.workspaceId,
    projectId: input.projectId,
    action: input.action,
    baseRevision: input.baseRevision,
    resultRevision: input.result.state.revision,
    idempotencyKey: input.command.idempotencyKey,
    requestFingerprint: input.command.requestFingerprint,
    actorClientId: input.command.audit.clientId,
    ...externalActorAuditData(input.command.audit, input.workspaceId, input.command.audit.clientId),
    ...(input.estimate ? { estimateJson: JSON.stringify(input.estimate) } : {}),
    ...(input.actual ? { actualJson: JSON.stringify(input.actual) } : {}),
    outcome: input.result.outcome,
    resultJson: serializedResult,
    resultHash: calculateDirectorBudgetFingerprint(JSON.parse(serializedResult)),
    occurredAt: new Date(input.command.occurredAt),
  }
}

function assertReplay(event: {
  requestFingerprint: string
  actorClientId: string
  workspaceId: string
  actorCredentialId: string
  actorEnvironment: string
  actorAuthenticationKind: string
  actorContextHash: string
  delegatedUserId: string | null
  delegatedIdentityId: string | null
  workspaceRole: string | null
  resultJson: string
  resultHash: string
}, command: Readonly<DirectorBudgetCommandContext>) {
  const audit = hydrateExternalActorAudit(event, event.actorClientId)
  if (event.requestFingerprint !== command.requestFingerprint || audit.contextHash !== command.audit.contextHash) {
    throw new DomainError('IDEMPOTENCY_PAYLOAD_MISMATCH', 'Director budget idempotency key was used with another request')
  }
  return hydrateReplay(event.resultJson, event.resultHash)
}

async function replayFor(
  client: PrismaClient | Transaction,
  input: { workspaceId: string; projectId: string; runId: string; command: Readonly<DirectorBudgetCommandContext> },
) {
  const event = await client.v2DirectorBudgetEvent.findFirst({
    where: {
      workspaceId: input.workspaceId,
      projectId: input.projectId,
      budget: { runId: input.runId },
      idempotencyKey: input.command.idempotencyKey,
    },
  })
  return event ? assertReplay(event, input.command) : null
}

function prismaCode(error: unknown, code: string): boolean {
  return typeof error === 'object' && error !== null && 'code' in error && error.code === code
}

async function executeMutation<T extends DirectorBudgetMutationResult>(
  client: PrismaClient,
  replayInput: { workspaceId: string; projectId: string; runId: string; command: Readonly<DirectorBudgetCommandContext> },
  work: (tx: Transaction) => Promise<T>,
): Promise<T> {
  try {
    return await client.$transaction(work, { isolationLevel: Prisma.TransactionIsolationLevel.Serializable })
  } catch (error) {
    if (prismaCode(error, 'P2002') || prismaCode(error, 'P2034')) {
      const replay = await replayFor(client, replayInput)
      if (replay) return replay as T
      throw new DomainError('PERSISTENCE_CONFLICT', 'Director budget transaction conflicted and can be retried')
    }
    throw error
  }
}

export class PrismaDirectorBudgetRepository implements DirectorBudgetRepository {
  constructor(private readonly client: PrismaClient = getV2PostgresClient()) {}

  async createOrReplay(input: Parameters<DirectorBudgetRepository['createOrReplay']>[0]) {
    const replay = await replayFor(this.client, { ...input.state, command: input.command })
    if (replay) return replay
    try {
      return await this.client.$transaction(async (tx) => {
        const existing = await tx.v2DirectorBudget.findUnique({
          where: { workspaceId_projectId_runId: {
            workspaceId: input.state.workspaceId,
            projectId: input.state.projectId,
            runId: input.state.runId,
          } },
        })
        if (existing) throw new DomainError('PERSISTENCE_CONFLICT', 'Director budget already exists without matching idempotency')
        await tx.v2DirectorBudget.create({ data: {
          id: input.state.id,
          workspaceId: input.state.workspaceId,
          projectId: input.state.projectId,
          runId: input.state.runId,
          ...stateData(input.state),
          createdAt: new Date(input.state.createdAt),
        } })
        const result = Object.freeze({ state: input.state, reservation: null, outcome: 'created' })
        await tx.v2DirectorBudgetEvent.create({ data: eventData({
          budgetId: input.state.id,
          workspaceId: input.state.workspaceId,
          projectId: input.state.projectId,
          action: 'create',
          baseRevision: 0,
          result,
          command: input.command,
        }) })
        return Object.freeze({ ...result, replayed: false })
      }, { isolationLevel: Prisma.TransactionIsolationLevel.Serializable })
    } catch (error) {
      if (prismaCode(error, 'P2002') || prismaCode(error, 'P2034')) {
        const won = await replayFor(this.client, { ...input.state, command: input.command })
        if (won) return won
        throw new DomainError('PERSISTENCE_CONFLICT', 'Director budget creation conflicted and can be retried')
      }
      throw error
    }
  }

  async reserveOrReplay(input: Parameters<DirectorBudgetRepository['reserveOrReplay']>[0]) {
    const replay = await replayFor(this.client, input)
    if (replay) return replay
    return executeMutation(this.client, input, async (tx) => {
      const row = await tx.v2DirectorBudget.findFirst({ where: { workspaceId: input.workspaceId, projectId: input.projectId, runId: input.runId } })
      if (!row) throw new DomainError('PROJECT_NOT_FOUND', 'Director budget was not found')
      const current = hydrateState(row)
      if (current.revision !== input.expectedRevision) throw new DomainError('VERSION_CONFLICT', 'Director budget revision is stale')
      const transition = reserveDirectorBudget({ state: current, reservationId: input.reservationId, operationKind: input.operationKind, estimate: input.estimate, occurredAt: input.command.occurredAt })
      const changed = await tx.v2DirectorBudget.updateMany({ where: { id: current.id, workspaceId: current.workspaceId, revision: current.revision }, data: stateData(transition.state) })
      if (changed.count !== 1) throw new DomainError('VERSION_CONFLICT', 'Director budget changed during reservation')
      if (transition.reservation) await tx.v2DirectorBudgetReservation.create({ data: {
        id: transition.reservation.id,
        budgetId: current.id,
        workspaceId: current.workspaceId,
        projectId: current.projectId,
        operationKind: transition.reservation.operationKind,
        status: transition.reservation.status,
        estimateJson: JSON.stringify(transition.reservation.estimate),
        createdAt: new Date(transition.reservation.createdAt),
      } })
      const result = Object.freeze({ state: transition.state, reservation: transition.reservation, outcome: transition.decision })
      await tx.v2DirectorBudgetEvent.create({ data: eventData({ budgetId: current.id, workspaceId: current.workspaceId, projectId: current.projectId, ...(transition.reservation ? { reservationId: transition.reservation.id } : {}), action: 'reserve', baseRevision: current.revision, result, estimate: input.estimate, command: input.command }) })
      return Object.freeze({ ...result, replayed: false })
    })
  }

  async settleOrReplay(input: Parameters<DirectorBudgetRepository['settleOrReplay']>[0]) {
    const replay = await replayFor(this.client, input)
    if (replay) return replay
    return executeMutation(this.client, input, async (tx) => {
      const row = await tx.v2DirectorBudget.findFirst({ where: { workspaceId: input.workspaceId, projectId: input.projectId, runId: input.runId } })
      if (!row) throw new DomainError('PROJECT_NOT_FOUND', 'Director budget was not found')
      const current = hydrateState(row)
      if (current.revision !== input.expectedRevision) throw new DomainError('VERSION_CONFLICT', 'Director budget revision is stale')
      const reservationRow = await tx.v2DirectorBudgetReservation.findFirst({ where: { id: input.reservationId, budgetId: current.id, workspaceId: current.workspaceId, projectId: current.projectId } })
      if (!reservationRow) throw new DomainError('INVALID_ARGUMENT', 'Director budget reservation was not found')
      const transition = settleDirectorBudget({ state: current, reservation: hydrateReservation(reservationRow), actual: input.actual, outcome: input.outcome, ...(input.candidateResult ? { candidateResult: input.candidateResult } : {}), occurredAt: input.command.occurredAt })
      const changed = await tx.v2DirectorBudget.updateMany({ where: { id: current.id, workspaceId: current.workspaceId, revision: current.revision }, data: stateData(transition.state) })
      if (changed.count !== 1) throw new DomainError('VERSION_CONFLICT', 'Director budget changed during settlement')
      const settled = await tx.v2DirectorBudgetReservation.updateMany({ where: { id: transition.reservation.id, workspaceId: current.workspaceId, status: 'reserved' }, data: {
        status: transition.reservation.status,
        actualJson: JSON.stringify(transition.reservation.actual),
        overrunJson: JSON.stringify(transition.reservation.overrun),
        candidateJson: transition.reservation.candidateResult ? JSON.stringify(transition.reservation.candidateResult) : null,
        settledAt: new Date(transition.reservation.settledAt as string),
      } })
      if (settled.count !== 1) throw new DomainError('VERSION_CONFLICT', 'Director budget reservation changed during settlement')
      const outcome = transition.state.status === 'budget_exhausted' ? 'budget_exhausted' : input.outcome
      const result = Object.freeze({ state: transition.state, reservation: transition.reservation, outcome })
      await tx.v2DirectorBudgetEvent.create({ data: eventData({ budgetId: current.id, reservationId: transition.reservation.id, workspaceId: current.workspaceId, projectId: current.projectId, action: input.outcome === 'completed' ? 'settle' : 'cancel-reservation', baseRevision: current.revision, result, estimate: transition.reservation.estimate, actual: input.actual, command: input.command }) })
      return Object.freeze({ ...result, replayed: false })
    })
  }

  async cancelOrReplay(input: Parameters<DirectorBudgetRepository['cancelOrReplay']>[0]) {
    const replay = await replayFor(this.client, input)
    if (replay) return replay
    return executeMutation(this.client, input, async (tx) => {
      const row = await tx.v2DirectorBudget.findFirst({ where: { workspaceId: input.workspaceId, projectId: input.projectId, runId: input.runId } })
      if (!row) throw new DomainError('PROJECT_NOT_FOUND', 'Director budget was not found')
      const current = hydrateState(row)
      if (current.revision !== input.expectedRevision) throw new DomainError('VERSION_CONFLICT', 'Director budget revision is stale')
      const next = cancelDirectorBudget(current, input.command.occurredAt)
      const changed = await tx.v2DirectorBudget.updateMany({ where: { id: current.id, workspaceId: current.workspaceId, revision: current.revision }, data: stateData(next) })
      if (changed.count !== 1) throw new DomainError('VERSION_CONFLICT', 'Director budget changed during cancellation')
      const zero = validateDirectorBudgetUsage({ spendMinorUnits: 0, elapsedMs: 0, tokens: 0, generations: 0, candidates: 0, criticRounds: 0 })
      await tx.v2DirectorBudgetReservation.updateMany({ where: { budgetId: current.id, workspaceId: current.workspaceId, status: 'reserved' }, data: { status: 'cancelled', actualJson: JSON.stringify(zero), overrunJson: JSON.stringify(zero), settledAt: new Date(input.command.occurredAt) } })
      const result = Object.freeze({ state: next, reservation: null, outcome: 'cancelled' })
      await tx.v2DirectorBudgetEvent.create({ data: eventData({ budgetId: current.id, workspaceId: current.workspaceId, projectId: current.projectId, action: 'cancel-run', baseRevision: current.revision, result, command: input.command }) })
      return Object.freeze({ ...result, replayed: false })
    })
  }

  async concludeOrReplay(input: Parameters<DirectorBudgetRepository['concludeOrReplay']>[0]) {
    const replay = await replayFor(this.client, input)
    if (replay) return replay
    return executeMutation(this.client, input, async (tx) => {
      const row = await tx.v2DirectorBudget.findFirst({ where: { workspaceId: input.workspaceId, projectId: input.projectId, runId: input.runId } })
      if (!row) throw new DomainError('PROJECT_NOT_FOUND', 'Director budget was not found')
      const current = hydrateState(row)
      if (current.revision !== input.expectedRevision) throw new DomainError('VERSION_CONFLICT', 'Director budget revision is stale')
      const transition = concludeDirectorBudget(current, input.command.occurredAt)
      const changed = await tx.v2DirectorBudget.updateMany({ where: { id: current.id, workspaceId: current.workspaceId, revision: current.revision }, data: stateData(transition.state) })
      if (changed.count !== 1) throw new DomainError('VERSION_CONFLICT', 'Director budget changed during conclusion')
      const result = Object.freeze({ state: transition.state, reservation: null, outcome: transition.outcome })
      await tx.v2DirectorBudgetEvent.create({ data: eventData({ budgetId: current.id, workspaceId: current.workspaceId, projectId: current.projectId, action: 'conclude', baseRevision: current.revision, result, command: input.command }) })
      return Object.freeze({ ...result, replayed: false })
    })
  }

  async get(input: Parameters<DirectorBudgetRepository['get']>[0]) {
    const row = await this.client.v2DirectorBudget.findFirst({ where: input })
    return row ? hydrateState(row) : null
  }

  async list(input: Parameters<DirectorBudgetRepository['list']>[0]) {
    const rows = await this.client.v2DirectorBudget.findMany({
      where: { workspaceId: input.workspaceId, projectId: input.projectId },
      orderBy: [{ updatedAt: 'desc' }, { id: 'desc' }],
      take: input.limit,
    })
    return Object.freeze(rows.map(hydrateState))
  }
}
