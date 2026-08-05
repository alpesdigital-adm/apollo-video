import assert from 'node:assert/strict'
import test from 'node:test'

import {
  createExternalAuditContext,
} from '../../src/v2/application/authenticate-api-client.ts'
import {
  listProductionBatchItemOperationsService,
} from '../../src/v2/application/production-batches.ts'
import {
  readPublicOperationService,
} from '../../src/v2/application/read-public-operation.ts'
import {
  retryPublicOperationService,
} from '../../src/v2/application/retry-public-operation.ts'
import {
  productionBatchItemOperationId,
} from '../../src/v2/domain/batch-item-result.ts'
import {
  createProductionBatch,
  hydrateProductionBatch,
  transitionBatchItem,
} from '../../src/v2/domain/production-batch.ts'

const at = (second) =>
  new Date(Date.UTC(2026, 7, 4, 18, 0, second)).toISOString()

function actor(scopes = [
  'operations:read',
  'operations:retry',
  'projects:write',
]) {
  const auditContext = createExternalAuditContext({
    clientId: 'batch-operation-client',
    credentialId: 'batch-operation-credential',
    workspaceId: 'batch-operation-workspace',
    environment: 'production',
  })
  return Object.freeze({
    ...auditContext,
    scopes: new Set(scopes),
    authenticationKind: 'bearer',
    clientKillSwitchEngaged: false,
    workspaceKillSwitchEngaged: false,
    clientAccessStatus: 'active',
    workspaceAccessStatus: 'active',
    auditContext,
  })
}

function fixture() {
  return createProductionBatch({
    id: 'batch-operation-fixture',
    workspaceId: 'batch-operation-workspace',
    projectId: 'batch-operation-project',
    name: 'Independent item operations',
    objective: 'content-distribution',
    sourceGroups: [{
      id: 'batch-operation-sources',
      name: 'Approved sources',
      sourceArtifactIds: ['batch-operation-source'],
    }],
    recipes: [{
      id: 'batch-operation-recipe',
      name: 'Canonical recipe',
      sourceGroupIds: ['batch-operation-sources'],
    }],
    variants: [
      {
        id: 'batch-operation-vertical',
        name: 'Vertical',
        outputSpecId: '9:16',
        locale: 'pt-BR',
      },
      {
        id: 'batch-operation-square',
        name: 'Square',
        outputSpecId: '1:1',
        locale: 'pt-BR',
      },
    ],
    budget: {
      currency: 'USD',
      maxCostMinorUnits: 10_000,
      reservedCostMinorUnits: 0,
    },
    itemDefinitions: [
      {
        id: 'batch-operation-completed',
        key: 'completed',
        sourceGroupId: 'batch-operation-sources',
        recipeId: 'batch-operation-recipe',
        variantId: 'batch-operation-vertical',
      },
      {
        id: 'batch-operation-failed',
        key: 'failed',
        sourceGroupId: 'batch-operation-sources',
        recipeId: 'batch-operation-recipe',
        variantId: 'batch-operation-square',
      },
    ],
    createdBy: { type: 'api-client', id: 'batch-operation-client' },
    createdAt: at(0),
  })
}

function act(batch, itemId, action, second, fields = {}) {
  const item = batch.items.find((candidate) => candidate.id === itemId)
  assert.ok(item)
  const changed = transitionBatchItem({
    item,
    action,
    now: at(second),
    ...fields,
  })
  return hydrateProductionBatch({
    ...batch,
    revision: batch.revision + 1,
    items: batch.items.map((candidate) =>
      candidate.id === itemId ? changed : candidate),
    updatedAt: at(second),
  })
}

function settledFixture() {
  let batch = fixture()
  let second = 1
  for (const step of [
    'planning',
    'materializing',
    'rendering',
    'reviewing',
  ]) {
    batch = act(batch, 'batch-operation-completed', 'start-step', second++, {
      step,
    })
    batch = act(batch, 'batch-operation-completed', 'complete-step', second++, {
      step,
      costMinorUnits: 25,
      artifactIds: [`artifact-${step}`],
    })
  }
  batch = act(batch, 'batch-operation-failed', 'start-step', second++, {
    step: 'planning',
  })
  return act(batch, 'batch-operation-failed', 'fail-step', second, {
    step: 'planning',
    costMinorUnits: 10,
    error: {
      code: 'PROVIDER_TIMEOUT',
      message: 'Provider timed out without exposing private diagnostics',
    },
  })
}

class MemoryProductionBatchRepository {
  constructor(batch) {
    this.batch = batch
    this.retries = []
  }

  async read({ workspaceId, batchId }) {
    return this.batch.workspaceId === workspaceId && this.batch.id === batchId
      ? this.batch
      : null
  }

  async findItemOperation({ workspaceId, operationId }) {
    if (workspaceId !== this.batch.workspaceId) return null
    const item = this.batch.items.find((candidate) =>
      productionBatchItemOperationId({
        workspaceId,
        batchId: this.batch.id,
        itemId: candidate.id,
      }) === operationId)
    return item ? { batch: this.batch, item } : null
  }

  async findPartialRetryReplay(input) {
    const replay = this.retries.find((candidate) =>
      candidate.actorClientId === input.actorClientId &&
      candidate.actorContextHash === input.actorContextHash &&
      candidate.idempotencyKey === input.idempotencyKey)
    return replay ?? null
  }

  async persistAction(record) {
    const replay = this.retries.find((candidate) =>
      candidate.actorClientId === record.actorClientId &&
      candidate.actorContextHash === record.authenticationAudit.contextHash &&
      candidate.idempotencyKey === record.idempotencyKey)
    if (replay) {
      return {
        batch: replay.batch,
        partialRetry: replay.partialRetry,
        replayed: true,
      }
    }
    this.batch = record.resultingBatch
    this.retries.push({
      actorClientId: record.actorClientId,
      actorContextHash: record.authenticationAudit.contextHash,
      idempotencyKey: record.idempotencyKey,
      requestFingerprint: record.requestFingerprint,
      batch: record.resultingBatch,
      partialRetry: record.partialRetry,
    })
    return {
      batch: this.batch,
      partialRetry: record.partialRetry,
      replayed: false,
    }
  }
}

test('F0.096 pages item operations and binds cursors to one immutable batch definition', async () => {
  const repository = new MemoryProductionBatchRepository(settledFixture())
  const list = listProductionBatchItemOperationsService({ repository })
  const first = await list({
    workspaceId: repository.batch.workspaceId,
    batchId: repository.batch.id,
    actor: actor(),
    limit: 1,
  })
  assert.equal(first.items.length, 1)
  assert.equal(first.items[0].status, 'succeeded')
  assert.equal(first.items[0].resultRef, 'artifact-reviewing')
  assert.match(first.nextCursor, /^[A-Za-z0-9_-]+$/)

  const second = await list({
    workspaceId: repository.batch.workspaceId,
    batchId: repository.batch.id,
    actor: actor(),
    limit: 1,
    cursor: first.nextCursor,
  })
  assert.equal(second.items.length, 1)
  assert.equal(second.items[0].status, 'failed')
  assert.equal(second.items[0].retryable, true)
  assert.equal(
    second.items[0].error.message,
    'Production batch item failed during planning.',
  )
  assert.equal(
    second.items[0].error.message.includes('private diagnostics'),
    false,
  )
  assert.equal('nextCursor' in second, false)
  await assert.rejects(
    list({
      workspaceId: repository.batch.workspaceId,
      batchId: 'different-batch',
      actor: actor(),
      cursor: first.nextCursor,
    }),
    /not found|does not match/,
  )
})

test('F0.096 reads and retries one failed item through canonical operation APIs', async () => {
  const repository = new MemoryProductionBatchRepository(settledFixture())
  const failed = repository.batch.items.find((item) =>
    item.id === 'batch-operation-failed')
  const completedBefore = repository.batch.items.find((item) =>
    item.id === 'batch-operation-completed')
  const operationId = productionBatchItemOperationId({
    workspaceId: repository.batch.workspaceId,
    batchId: repository.batch.id,
    itemId: failed.id,
  })
  const operations = {
    async findById() { return null },
    async retry() { throw new Error('generic retry must not handle batch items') },
  }
  const read = readPublicOperationService({
    operations,
    productionBatches: repository,
  })
  const before = await read({
    workspaceId: repository.batch.workspaceId,
    operationId,
  })
  assert.equal(before.type, 'production-batch-item')
  assert.equal(before.status, 'failed')
  assert.deepEqual(before.target, {
    type: 'production-batch-item',
    id: failed.id,
    batchId: repository.batch.id,
  })

  const retry = retryPublicOperationService({
    operations,
    productionBatches: repository,
    clock: () => new Date(at(20)),
    createBatchRetryId: () => 'batch-operation-retry-1',
    createBatchRetryJobId: () => 'batch-operation-retry-job-1',
  })
  const after = await retry({
    workspaceId: repository.batch.workspaceId,
    operationId,
    actor: actor(),
  })
  assert.equal(after.id, operationId)
  assert.equal(after.status, 'queued')
  assert.equal(after.phase, 'queued')
  assert.equal(repository.retries.length, 1)
  assert.equal(repository.retries[0].partialRetry.jobs.length, 1)
  assert.equal(repository.retries[0].partialRetry.jobs[0].itemId, failed.id)
  assert.deepEqual(
    repository.batch.items.find((item) =>
      item.id === completedBefore.id),
    completedBefore,
  )

  const replay = await retry({
    workspaceId: repository.batch.workspaceId,
    operationId,
    actor: actor(),
  })
  assert.equal(replay.id, operationId)
  assert.equal(repository.retries.length, 1)
  await assert.rejects(
    retry({
      workspaceId: repository.batch.workspaceId,
      operationId: productionBatchItemOperationId({
        workspaceId: repository.batch.workspaceId,
        batchId: repository.batch.id,
        itemId: completedBefore.id,
      }),
      actor: actor(),
    }),
    /cannot be retried/,
  )
})

test('batch item retry requires both operation retry and project write authority', async () => {
  const repository = new MemoryProductionBatchRepository(settledFixture())
  const failed = repository.batch.items.find((item) =>
    item.id === 'batch-operation-failed')
  const operationId = productionBatchItemOperationId({
    workspaceId: repository.batch.workspaceId,
    batchId: repository.batch.id,
    itemId: failed.id,
  })
  const retry = retryPublicOperationService({
    operations: {
      async findById() { return null },
      async retry() { throw new Error('unexpected generic retry') },
    },
    productionBatches: repository,
    clock: () => new Date(at(20)),
  })
  await assert.rejects(
    retry({
      workspaceId: repository.batch.workspaceId,
      operationId,
      actor: actor(['operations:retry']),
    }),
    /required scope/,
  )
  assert.equal(repository.retries.length, 0)
})
