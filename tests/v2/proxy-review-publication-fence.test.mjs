import assert from 'node:assert/strict'
import test from 'node:test'
import { DomainError } from '../../src/v2/domain/errors.ts'
import { PrismaProxyReviewRepository, readCurrentProxyReview } from '../../src/v2/infrastructure/prisma/proxy-review-repository.ts'
import { fakeOutputWorld } from './helpers/output-consumption-fakes.mjs'

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

// ---------------------------------------------------------------------------
// Slice S3 multi-output - a review belongs to the output of the render that produced it.
// ---------------------------------------------------------------------------

const outputs = [{ variantId: 'variant-wide', aspectRatio: '16:9' }, { variantId: 'variant-tall', aspectRatio: '9:16' }]
const outputWorld = (entries = outputs) => fakeOutputWorld({ workspaceId: operation.workspaceId, projectId: operation.projectId, versionId: 'version-proxy', entries })
const refusal = (reason) => (error) => error instanceof DomainError && error.code === 'PRECONDITION_REQUIRED' && error.details.reason === reason

const completeReview = { projectVersionId: 'version-proxy', proxyArtifactId: 'artifact-proxy', proxyManifestId: 'manifest-proxy', inputHash: '0'.repeat(64),
  outputSpecId: 'output-spec-proxy', rangeCacheKey: '1'.repeat(64), spec: {}, status: 'ready-for-final', technicalIssues: [], criticIssues: [],
  warningsAcknowledged: false, finalAllowed: true, uploadReceivedAt: now, renderCompletedAt: now, timeToFirstProxyMs: 1, reviewHash: '2'.repeat(64) }

test('a render is superseded only by a NEWER render of the SAME output: the sibling output render of one Version never fences this review out', async () => {
  const fenceOf = async (outputVariantId) => {
    let fence
    const repository = new PrismaProxyReviewRepository({ async $transaction(callback) {
      return callback({
        async $queryRaw() { return [] },
        v2PublicOperation: { async findUnique() { return { ...operation, projectProxyRender: { projectVersionId: 'version-proxy', reusedFromOperationId: null, outputVariantId } } } },
        v2ProxyReview: { async findUnique() { return null }, async create() { return {} } },
        v2Project: { async updateMany(query) { fence = query.where.publicOperations.none; return { count: 0 } } },
      })
    } })
    await assert.rejects(repository.persistGenerated({ id: 'review-proxy', workspaceId: operation.workspaceId, projectId: operation.projectId, operationId: operation.id,
      review: completeReview, createdAt: now, lease }), (error) => error.code === 'VERSION_CONFLICT')
    return fence
  }
  assert.deepEqual((await fenceOf('variant-wide')).projectProxyRender, { is: { projectVersionId: 'version-proxy', outputVariantId: 'variant-wide' } },
    'only a newer render of THIS output supersedes it')
  assert.deepEqual((await fenceOf(null)).projectProxyRender, { is: { projectVersionId: 'version-proxy' } },
    'a legacy render, made for no stated output, is superseded by any newer render of its Version, as it always was')
})

test('the current review is the newest one of ONE output: none named in a Version with several outputs is refused, a stranger is refused, the review of another output is never returned', async () => {
  const lookups = []
  const clientOn = (world, row = null) => ({
    $queryRawUnsafe: (...args) => world.queryRawUnsafe(...args),
    v2Project: { async findFirst() { return { currentVersionId: 'version-proxy' } } },
    v2ProxyReview: { async findFirst(query) { lookups.push(query.where); return row } },
  })
  const at = { workspaceId: operation.workspaceId, projectId: operation.projectId, projectVersionId: 'version-proxy' }
  await assert.rejects(readCurrentProxyReview(clientOn(outputWorld()), at), refusal('output-variant-required'))
  await assert.rejects(readCurrentProxyReview(clientOn(outputWorld()), { ...at, variantId: 'variant-stranger' }), refusal('output-variant-unknown'))
  assert.equal(lookups.length, 0, 'nothing is looked up for a refused request')
  assert.equal(await readCurrentProxyReview(clientOn(outputWorld()), { ...at, variantId: 'variant-tall' }), null)
  assert.deepEqual(lookups[0], { workspaceId: operation.workspaceId, projectId: operation.projectId, projectVersionId: 'version-proxy', operation: { outputVariantId: 'variant-tall' } })
  // The head is resolved from the project when no Version is named.
  await readCurrentProxyReview(clientOn(outputWorld()), { workspaceId: operation.workspaceId, projectId: operation.projectId, variantId: 'variant-wide' })
  assert.equal(lookups[1].projectVersionId, 'version-proxy')
  assert.deepEqual(lookups[1].operation, { outputVariantId: 'variant-wide' })
  // One output: the variant is optional, and a review rendered before the output was recorded is its own.
  lookups.length = 0
  const solo = outputWorld([{ variantId: 'variant-solo', aspectRatio: '9:16' }])
  await readCurrentProxyReview(clientOn(solo), at)
  assert.deepEqual(lookups[0].operation, { OR: [{ outputVariantId: 'variant-solo' }, { outputVariantId: null }] })
})
