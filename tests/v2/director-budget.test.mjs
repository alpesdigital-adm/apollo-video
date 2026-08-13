import assert from 'node:assert/strict'
import { readFile } from 'node:fs/promises'
import test from 'node:test'

import { createExternalAuditContext } from '../../src/v2/application/authenticate-api-client.ts'
import { directorBudgetService } from '../../src/v2/application/director-budgets.ts'
import {
  cancelDirectorBudget,
  concludeDirectorBudget,
  createDirectorBudget,
  reserveDirectorBudget,
  settleDirectorBudget,
} from '../../src/v2/domain/director-budget.ts'
import { DomainError } from '../../src/v2/domain/errors.ts'
import {
  parseDirectorBudgetActionBody,
  presentDirectorBudget,
} from '../../src/v2/public-api/director-budget-contract.ts'

const at = (second) => `2026-08-13T17:00:${String(second).padStart(2, '0')}.000Z`
const usage = (value = 0) => ({
  spendMinorUnits: value,
  elapsedMs: value,
  tokens: value,
  generations: value,
  candidates: value,
  criticRounds: value,
})

function initial(limits = usage(10)) {
  return createDirectorBudget({
    id: 'director-budget-1',
    workspaceId: 'workspace-budget',
    projectId: 'project-budget',
    runId: 'director-run-1',
    limits,
    createdAt: at(0),
  })
}

function actor() {
  const auditContext = createExternalAuditContext({
    clientId: 'client-budget',
    credentialId: 'credential-budget',
    workspaceId: 'workspace-budget',
    environment: 'sandbox',
  })
  return Object.freeze({
    clientId: 'client-budget',
    credentialId: 'credential-budget',
    workspaceId: 'workspace-budget',
    environment: 'sandbox',
    scopes: new Set(['projects:write']),
    authenticationKind: 'bearer',
    clientKillSwitchEngaged: false,
    workspaceKillSwitchEngaged: false,
    clientAccessStatus: 'active',
    workspaceAccessStatus: 'active',
    auditContext,
  })
}

test('F1.026 rejects an unaffordable estimate before creating a paid reservation', () => {
  const result = reserveDirectorBudget({
    state: initial(),
    reservationId: 'reservation-too-large',
    operationKind: 'generate-candidate',
    estimate: usage(11),
    occurredAt: at(1),
  })
  assert.equal(result.decision, 'budget_exhausted')
  assert.equal(result.reservation, null)
  assert.equal(result.state.status, 'budget_exhausted')
  assert.equal(result.state.exhaustedDimension, 'spendMinorUnits')
  assert.deepEqual(result.state.reserved, usage(0))
})

test('F1.026 settles real overrun, releases the estimate and preserves the best valid result', () => {
  const first = reserveDirectorBudget({
    state: initial(), reservationId: 'reservation-overrun',
    operationKind: 'critic-round', estimate: usage(3), occurredAt: at(1),
  })
  const settled = settleDirectorBudget({
    state: first.state,
    reservation: first.reservation,
    actual: usage(11),
    outcome: 'completed',
    candidateResult: { id: 'candidate-valid', valid: true, score: 0.91, payloadHash: 'a'.repeat(64) },
    occurredAt: at(2),
  })
  assert.equal(settled.state.status, 'budget_exhausted')
  assert.deepEqual(settled.state.reserved, usage(0))
  assert.deepEqual(settled.state.actual, usage(11))
  assert.deepEqual(settled.reservation.overrun, usage(8))
  const conclusion = concludeDirectorBudget(settled.state, at(3))
  assert.equal(conclusion.outcome, 'completed-with-best-valid')
  assert.equal(conclusion.state.status, 'completed')
  assert.equal(conclusion.result.id, 'candidate-valid')
  assert.equal(conclusion.recoverable, false)
})

test('F1.026 cancellation settlement accounts real usage and releases unused reservation', () => {
  const first = reserveDirectorBudget({
    state: initial(), reservationId: 'reservation-cancelled',
    operationKind: 'search-media', estimate: usage(6), occurredAt: at(1),
  })
  const settled = settleDirectorBudget({
    state: first.state,
    reservation: first.reservation,
    actual: usage(2),
    outcome: 'cancelled',
    occurredAt: at(2),
  })
  assert.equal(settled.reservation.status, 'cancelled')
  assert.deepEqual(settled.state.reserved, usage(0))
  assert.deepEqual(settled.state.actual, usage(2))
  assert.deepEqual(settled.reservation.overrun, usage(0))
  const cancelled = cancelDirectorBudget(settled.state, at(3))
  assert.equal(cancelled.status, 'cancelled')
})

test('F1.026 concurrent application reservations use one exact revision and only one wins', async () => {
  let state = initial()
  let created = 0
  const repository = {
    async reserveOrReplay(input) {
      await new Promise((resolve) => setImmediate(resolve))
      if (state.revision !== input.expectedRevision) throw new DomainError('VERSION_CONFLICT', 'stale')
      const transition = reserveDirectorBudget({
        state, reservationId: input.reservationId, operationKind: input.operationKind,
        estimate: input.estimate, occurredAt: input.command.occurredAt,
      })
      state = transition.state
      return { state, reservation: transition.reservation, outcome: transition.decision, replayed: false }
    },
  }
  const service = directorBudgetService({
    repository,
    clock: () => new Date(at(1)),
    createId: (kind) => `${kind}-concurrent-${++created}`,
  })
  const request = {
    workspaceId: 'workspace-budget', projectId: 'project-budget', runId: 'director-run-1',
    expectedRevision: 1, operationKind: 'paid-tool', estimate: usage(6), actor: actor(),
  }
  const results = await Promise.allSettled([
    service.reserve({ ...request, idempotencyKey: 'reserve-concurrent-a' }),
    service.reserve({ ...request, idempotencyKey: 'reserve-concurrent-b' }),
  ])
  assert.equal(results.filter((result) => result.status === 'fulfilled').length, 1)
  assert.equal(results.filter((result) => result.status === 'rejected' && result.reason.code === 'VERSION_CONFLICT').length, 1)
  assert.deepEqual(state.reserved, usage(6))
  assert.equal(state.revision, 2)
})

test('F1.026 action contract is closed and public view names estimated versus realized', () => {
  assert.deepEqual(parseDirectorBudgetActionBody({
    action: 'reserve', baseRevision: 1, operationKind: 'search-media', estimate: usage(1),
  }), {
    action: 'reserve', expectedRevision: 1, operationKind: 'search-media', estimate: usage(1),
  })
  assert.throws(() => parseDirectorBudgetActionBody({
    action: 'reserve', baseRevision: 1, operationKind: 'search-media', estimate: usage(1), hidden: true,
  }), /unsupported/)
  const visible = presentDirectorBudget(initial())
  assert.deepEqual(visible.estimated, usage(0))
  assert.deepEqual(visible.realized, usage(0))
  assert.equal('workspaceId' in visible, false)
})

test('F1.026 Prisma persistence declares serializable transaction, CAS revision and audit-bound idempotency', async () => {
  const [repository, migration, route] = await Promise.all([
    readFile(new URL('../../src/v2/infrastructure/prisma/director-budget-repository.ts', import.meta.url), 'utf8'),
    readFile(new URL('../../prisma/v2/migrations/20260813173000_director_budgets_v1/migration.sql', import.meta.url), 'utf8'),
    readFile(new URL('../../src/app/v1/projects/[projectId]/director-budgets/[runId]/actions/route.ts', import.meta.url), 'utf8'),
  ])
  assert.match(repository, /TransactionIsolationLevel\.Serializable/)
  assert.match(repository, /revision: current\.revision/)
  assert.match(repository, /IDEMPOTENCY_PAYLOAD_MISMATCH/)
  assert.match(repository, /externalActorAuditData/)
  assert.match(migration, /director_budget_events_workspaceId_budgetId_idempotencyKey_key/)
  assert.match(migration, /FOREIGN KEY \("actorClientId", "workspaceId"\)/)
  assert.match(route, /assertExternalMutationOrigin/)
  assert.match(route, /requireScope\(actor, 'projects:write'\)/)
})
