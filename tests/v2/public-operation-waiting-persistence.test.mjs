import assert from 'node:assert/strict'
import test from 'node:test'

import { PrismaPublicOperationRepository } from '../../src/v2/infrastructure/prisma/public-operation-repository.ts'

function createMemoryPrisma() {
  const at = (value) => new Date(value)
  const state = {
    row: {
      id: 'operation-waiting-1',
      workspaceId: 'workspace-waiting-1',
      projectId: 'project-waiting-1',
      clientId: 'client-waiting-1',
      type: 'media-ingest',
      status: 'running',
      phase: 'normalizing',
      targetType: 'media-artifact',
      targetId: 'artifact-waiting-1',
      progressCompleted: 2,
      progressTotal: 6,
      progressUnit: 'stage',
      cancelable: true,
      retryable: false,
      attempt: 1,
      maxAttempts: 3,
      resultJson: null,
      errorCode: null,
      errorMessage: null,
      errorRetryable: null,
      idempotencyKey: 'waiting-key-1',
      requestFingerprint: 'a'.repeat(64),
      createdAt: at('2026-08-02T15:00:00.000Z'),
      updatedAt: at('2026-08-02T15:00:02.000Z'),
      startedAt: at('2026-08-02T15:00:01.000Z'),
      completedAt: null,
      leaseOwner: 'worker-waiting-1',
      leaseExpiresAt: at('2026-08-02T15:01:00.000Z'),
      heartbeatAt: at('2026-08-02T15:00:02.000Z'),
      nextAttemptAt: null,
      deadLetteredAt: null,
      artifactRender: null,
      mediaIngest: {
        operationId: 'operation-waiting-1',
        workspaceId: 'workspace-waiting-1',
        uploadId: '123e4567-e89b-42d3-a456-426614174000',
        projectId: 'project-waiting-1',
        originalFileName: 'master.mp4',
        sourceArtifactId: 'artifact-waiting-1',
        sourceManifestId: 'manifest-waiting-1',
      },
      projectProxyRender: null,
      projectFinalExport: null,
      sourceCleanupPlan: null,
      longFormIndexWorkflow: null,
    },
  }
  const transaction = {
    v2PublicEventOutbox: {
      async createMany() { return { count: 1 } },
    },
    v2PublicOperation: {
      async findUnique({ where }) {
        return where.id === state.row.id ? { ...state.row } : null
      },
      async findFirst({ where }) {
        return where.id === state.row.id && where.workspaceId === state.row.workspaceId
          ? { ...state.row }
          : null
      },
      async updateMany({ where, data }) {
        const matches = where.id === state.row.id &&
          (!where.workspaceId || where.workspaceId === state.row.workspaceId) &&
          where.status === state.row.status &&
          where.phase === state.row.phase &&
          where.attempt === state.row.attempt &&
          (!where.updatedAt || where.updatedAt.getTime() === state.row.updatedAt.getTime()) &&
          (where.leaseOwner === undefined || where.leaseOwner === state.row.leaseOwner) &&
          (where.leaseExpiresAt === null
            ? state.row.leaseExpiresAt === null
            : !where.leaseExpiresAt?.gt || state.row.leaseExpiresAt?.getTime() > where.leaseExpiresAt.gt.getTime()) &&
          (where.heartbeatAt === undefined || where.heartbeatAt === state.row.heartbeatAt)
        if (!matches) return { count: 0 }
        state.row = { ...state.row, ...data }
        return { count: 1 }
      },
    },
  }
  return {
    state,
    client: {
      ...transaction,
      async $transaction(callback) { return callback(transaction) },
    },
  }
}

test('T-FR-236 waiting releases its lease and resumes atomically without a new attempt', async () => {
  const { client, state } = createMemoryPrisma()
  const repository = new PrismaPublicOperationRepository(client)
  const waiting = await repository.wait({
    operationId: state.row.id,
    leaseOwner: 'worker-waiting-1',
    attempt: 1,
    now: '2026-08-02T15:00:03.000Z',
  })
  assert.equal(waiting.operation.status, 'waiting')
  assert.equal(waiting.operation.phase, 'waiting')
  assert.equal(waiting.operation.attempt, 1)
  assert.equal(state.row.leaseOwner, null)
  assert.equal(state.row.leaseExpiresAt, null)
  assert.equal(state.row.heartbeatAt, null)

  const resumed = await repository.resumeWaiting({
    workspaceId: state.row.workspaceId,
    operationId: state.row.id,
    leaseOwner: 'worker-waiting-2',
    attempt: 1,
    phase: 'verifying',
    now: '2026-08-02T15:00:04.000Z',
    leaseUntil: '2026-08-02T15:01:04.000Z',
  })
  assert.equal(resumed.operation.status, 'running')
  assert.equal(resumed.operation.phase, 'verifying')
  assert.equal(resumed.operation.attempt, 1)
  assert.equal(resumed.operation.startedAt, '2026-08-02T15:00:01.000Z')
  assert.deepEqual(resumed.lease, {
    owner: 'worker-waiting-2',
    attempt: 1,
    heartbeatAt: '2026-08-02T15:00:04.000Z',
    expiresAt: '2026-08-02T15:01:04.000Z',
  })
  assert.equal(await repository.resumeWaiting({
    workspaceId: state.row.workspaceId,
    operationId: state.row.id,
    leaseOwner: 'worker-waiting-3',
    attempt: 1,
    phase: 'verifying',
    now: '2026-08-02T15:00:05.000Z',
    leaseUntil: '2026-08-02T15:01:05.000Z',
  }), null)
  assert.equal(await repository.wait({
    operationId: state.row.id,
    leaseOwner: 'worker-waiting-1',
    attempt: 1,
    now: '2026-08-02T15:00:05.000Z',
  }), null)
})
