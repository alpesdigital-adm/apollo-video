import assert from 'node:assert/strict'
import test from 'node:test'
import { PrismaProxyReviewRepository } from '../../src/v2/infrastructure/prisma/proxy-review-repository.ts'

const now = '2026-10-05T15:00:00.000Z'
const lease = { owner: 'worker-current', attempt: 2, now }
const operation = { id: 'operation-proxy', type: 'project-proxy-render', workspaceId: 'workspace-proxy', projectId: 'project-proxy',
  status: 'running', leaseOwner: lease.owner, attempt: lease.attempt, leaseExpiresAt: new Date('2026-10-05T15:01:00Z'),
  createdAt: new Date('2026-10-05T14:59:00Z'), projectProxyRender: { projectVersionId: 'version-proxy', reusedFromOperationId: null } }

for (const [name, overrides, supplied] of [
  ['stale owner', {}, { ...lease, owner: 'worker-old' }],
  ['stale attempt', {}, { ...lease, attempt: 1 }],
  ['expired matching lease', { leaseExpiresAt: new Date(now) }, lease],
  ['missing worker lease', {}, undefined],
  ['canceled operation', { status: 'canceled', leaseOwner: null }, lease],
  ['completed physical render without inline reuse', { status: 'succeeded', leaseOwner: null }, undefined],
]) {
  test(`proxy review publication rejects ${name} before writes`, async () => {
    let writes = 0; let locked = false
    const repository = new PrismaProxyReviewRepository({ async $transaction(callback) {
      return callback({
        async $queryRaw() { locked = true; return [] },
        v2PublicOperation: { async findUnique() { assert.equal(locked, true); return { ...operation, ...overrides } } },
        v2ProxyReview: { async findUnique() { return null }, async create() { writes += 1; throw new Error('Unexpected review write') } },
        v2Project: { async updateMany() { writes += 1; throw new Error('Unexpected project write') } },
      })
    } })
    await assert.rejects(repository.persistGenerated({ id: 'review-proxy', workspaceId: operation.workspaceId,
      projectId: operation.projectId, operationId: operation.id, review: { projectVersionId: 'version-proxy' },
      createdAt: now, ...(supplied ? { lease: supplied } : {}) }), (error) => error.code === 'PERSISTENCE_CONFLICT')
    assert.equal(writes, 0)
  })
}
