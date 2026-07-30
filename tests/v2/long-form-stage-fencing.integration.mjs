import assert from 'node:assert/strict'
import test from 'node:test'

const baseFence = Object.freeze({
  workspaceId: 'workspace-fencing',
  projectId: 'project-fencing',
  workflowId: 'workflow-fencing',
  operationId: 'operation-fencing',
  expectedStageInputHash: 'a'.repeat(64),
  expectedStageIdempotencyKey:
    'workflow-fencing:stage:aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa',
  leaseOwner: 'worker-fencing',
  operationAttempt: 1,
  now: '2026-07-30T13:00:00.000Z',
})

function clientWithoutLease(runModel) {
  let transactionCount = 0
  const transaction = {
    [runModel]: {
      async findUnique() {
        return null
      },
    },
    v2PublicOperation: {
      async findFirst() {
        return null
      },
    },
    v2LongFormIndexStageCheckpoint: {
      async findFirst() {
        return null
      },
    },
  }
  return {
    client: {
      async $transaction(callback) {
        transactionCount += 1
        return callback(transaction)
      },
    },
    transactions: () => transactionCount,
  }
}

test('T-FR-133 hierarchical repository fences tenant and missing operation lease before writing chunks', async () => {
  const {
    PrismaHierarchicalProcessingRepository,
  } = await import(
    '../../src/v2/infrastructure/prisma/hierarchical-processing-repository.ts'
  )
  const fixture = clientWithoutLease(
    'v2HierarchicalProcessingRun',
  )
  const repository =
    new PrismaHierarchicalProcessingRepository(fixture.client)
  const run = {
    workspaceId: baseFence.workspaceId,
    projectId: baseFence.projectId,
    idempotencyKey:
      baseFence.expectedStageIdempotencyKey,
  }
  await assert.rejects(
    repository.persistWithLongFormLease({
      run,
      fence: {
        ...baseFence,
        workspaceId: 'workspace-fencing-other',
        stage: 'chunks',
      },
    }),
    (error) => error.code === 'VERSION_CONFLICT',
  )
  assert.equal(fixture.transactions(), 0)
  assert.equal(
    await repository.persistWithLongFormLease({
      run,
      fence: { ...baseFence, stage: 'chunks' },
    }),
    null,
  )
  assert.equal(fixture.transactions(), 1)
})

test('T-FR-133 long-form repository fences tenant and missing operation lease before writing moments', async () => {
  const {
    PrismaLongFormIndexRepository,
  } = await import(
    '../../src/v2/infrastructure/prisma/long-form-index-repository.ts'
  )
  const fixture = clientWithoutLease('v2LongFormIndexRun')
  const repository =
    new PrismaLongFormIndexRepository(fixture.client)
  const run = {
    workspaceId: baseFence.workspaceId,
    projectId: baseFence.projectId,
    idempotencyKey:
      baseFence.expectedStageIdempotencyKey,
  }
  await assert.rejects(
    repository.persistWithLongFormLease({
      run,
      fence: {
        ...baseFence,
        projectId: 'project-fencing-other',
        stage: 'moments',
      },
    }),
    (error) => error.code === 'VERSION_CONFLICT',
  )
  assert.equal(fixture.transactions(), 0)
  assert.equal(
    await repository.persistWithLongFormLease({
      run,
      fence: { ...baseFence, stage: 'moments' },
    }),
    null,
  )
  assert.equal(fixture.transactions(), 1)
})
