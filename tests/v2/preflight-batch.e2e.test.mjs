import assert from 'node:assert/strict'
import test from 'node:test'

import {
  createExternalAuditContext,
} from '../../src/v2/application/authenticate-api-client.ts'
import {
  commitBatchEditService,
  createBatchEditPreflightService,
} from '../../src/v2/application/batch-edits.ts'
import {
  createBatchEditItemState,
} from '../../src/v2/domain/batch-edit.ts'
import {
  HmacPreflightCommitTokenIssuer,
} from '../../src/v2/infrastructure/security/preflight-commit-token.ts'

const workspaceId = 'preflight-e2e-workspace'
const batchId = 'preflight-e2e-batch'
const clientId = 'preflight-e2e-client'
const definitionHash = 'a'.repeat(64)

function actor() {
  const auditContext = createExternalAuditContext({
    clientId,
    credentialId: 'preflight-e2e-credential',
    workspaceId,
    environment: 'production',
  })
  return Object.freeze({
    ...auditContext,
    scopes: new Set(['projects:write']),
    authenticationKind: 'bearer',
    clientKillSwitchEngaged: false,
    workspaceKillSwitchEngaged: false,
    clientAccessStatus: 'active',
    workspaceAccessStatus: 'active',
    auditContext,
  })
}

function context(itemId, outputSpecId) {
  return Object.freeze({
    itemId,
    recipeId: 'preflight-e2e-recipe',
    variantId: `${itemId}-variant`,
    outputSpecId,
    locale: 'pt-BR',
    state: createBatchEditItemState({
      workspaceId,
      batchId,
      itemId,
      createdByClientId: clientId,
      createdAt: '2026-07-17T00:00:00.000Z',
    }),
  })
}

function repositoryFixture(budgetRemainingMinorUnits) {
  const items = [
    context('preflight-e2e-item-vertical', '9:16'),
    context('preflight-e2e-item-square', '1:1'),
  ]
  const preflights = new Map()
  let policy
  let commitCalls = 0
  let commitStateReads = 0
  return {
    items,
    get commitCalls() { return commitCalls },
    get commitStateReads() { return commitStateReads },
    repository: {
      async loadPreflightContext(input) {
        assert.equal(input.expectedBatchRevision, 1)
        assert.equal(input.expectedBatchDefinitionHash, definitionHash)
        return {
          projectId: 'preflight-e2e-project',
          batchRevision: 1,
          batchDefinitionHash: definitionHash,
          availableRecipeIds: ['preflight-e2e-recipe'],
          availableOutputSpecIds: ['1:1', '9:16'],
          availableItemIds: items.map((item) => item.itemId),
          items: items.filter((item) => input.itemIds.includes(item.itemId)),
          budgetRemainingMinorUnits,
        }
      },
      async loadCommitStates({ itemIds }) {
        commitStateReads += 1
        return itemIds.map((itemId) =>
          items.find((item) => item.itemId === itemId).state)
      },
      async readPolicy() { return policy ?? null },
      async ensurePolicy(value) {
        policy = value
        return value
      },
      async findPreflightReplay() { return null },
      async createPreflight(record) {
        preflights.set(record.run.id, record)
        return { run: record.run, replayed: false }
      },
      async readPreflightRecord({ preflightId }) {
        return preflights.get(preflightId) ?? null
      },
      async findCommandReplay() { return null },
      async commit(record) {
        commitCalls += 1
        return { command: record.command, replayed: false }
      },
    },
  }
}

function preflightRequest(items, idempotencyKey) {
  return {
    workspaceId,
    batchId,
    expectedBatchRevision: 1,
    expectedBatchDefinitionHash: definitionHash,
    recipeIds: ['preflight-e2e-recipe'],
    outputSpecIds: ['1:1', '9:16'],
    itemIds: items.map((item) => item.itemId),
    operation: {
      type: 'brand-kit',
      valueRef: 'preflight-e2e-brand-kit',
    },
    actor: actor(),
    idempotencyKey,
  }
}

test('F0.097 real application preflight remains dry, expires closed and blocks budget before commit', async () => {
  const issuer = new HmacPreflightCommitTokenIssuer(
    'preflight-e2e-commit-secret-at-least-32-bytes',
  )
  const readyFixture = repositoryFixture(1_000)
  let now = new Date('2026-07-17T00:00:00.000Z')
  const createReady = createBatchEditPreflightService({
    repository: readyFixture.repository,
    tokenIssuer: issuer,
    clock: () => now,
    createPreflightId: () => 'preflight-e2e-ready',
  })
  const ready = await createReady(preflightRequest(
    readyFixture.items,
    'preflight-e2e-ready-key',
  ))
  assert.equal(ready.run.status, 'ready')
  assert.equal(ready.preflightResult.eligible, true)
  assert.equal(typeof ready.commitToken, 'string')
  assert.equal(readyFixture.commitCalls, 0)
  assert.equal(readyFixture.commitStateReads, 0)

  now = new Date(Date.parse(ready.run.confirmationExpiresAt) + 1)
  const commit = commitBatchEditService({
    repository: readyFixture.repository,
    tokenIssuer: issuer,
    clock: () => now,
    createCommandId: () => 'preflight-e2e-command',
  })
  await assert.rejects(
    commit({
      workspaceId,
      batchId,
      preflightId: ready.run.id,
      expectedPreflightHash: ready.run.preflightHash,
      expectedScopeHash: ready.run.scope.scopeHash,
      commitToken: ready.commitToken,
      actor: actor(),
      idempotencyKey: 'preflight-e2e-expired-commit',
    }),
    /expired/,
  )
  assert.equal(readyFixture.commitCalls, 0)
  assert.equal(readyFixture.commitStateReads, 0)

  const blockedFixture = repositoryFixture(50)
  const blocked = await createBatchEditPreflightService({
    repository: blockedFixture.repository,
    tokenIssuer: issuer,
    clock: () => new Date('2026-07-17T00:00:00.000Z'),
    createPreflightId: () => 'preflight-e2e-budget-blocked',
  })(preflightRequest(
    blockedFixture.items,
    'preflight-e2e-budget-key',
  ))
  assert.equal(blocked.run.status, 'blocked')
  assert.equal(blocked.run.budgetExceeded, true)
  assert.equal(blocked.preflightResult.eligible, false)
  assert.equal(blocked.preflightResult.quota.allowed, false)
  assert.equal(blocked.commitToken, undefined)
  assert.equal(blockedFixture.commitCalls, 0)
  assert.equal(blockedFixture.commitStateReads, 0)
})
