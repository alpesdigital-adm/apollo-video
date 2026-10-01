// Unit test with controlled Prisma transactions, NOT a PostgreSQL integration or E2E test.
import assert from 'node:assert/strict'
import test from 'node:test'

import { calculateCanonicalHash } from '../../src/v2/domain/canonical-hash.ts'
import { createProviderJob } from '../../src/v2/domain/provider-job.ts'
import { createApiAccessAuditContext } from '../../src/v2/domain/api-access-control.ts'
import { PrismaProviderJobRepository } from '../../src/v2/infrastructure/prisma/provider-job-repository.ts'

const at = '2029-01-01T00:00:00.000Z'
const hash = (letter) => letter.repeat(64)
function fixture() {
  const body = {
    id: 'authorization-create', profileSnapshotId: 'profile-create:v1', profileSnapshotHash: hash('a'),
    artifactDecisions: [], evaluatedAt: at, expiresAt: '2030-01-01T00:00:00.000Z',
  }
  const job = createProviderJob({
    id: 'job-create', workspaceId: 'workspace-create', projectId: 'project-create',
    originProjectVersionId: 'version-create', operation: 'tts', adapterId: 'adapter-create',
    adapterVersion: 'version-1', providerInput: { text: 'authorized' }, idempotencyKey: 'key-create',
    authorization: { ...body, authorizationHash: calculateCanonicalHash(body) }, createdAt: at,
  })
  const authenticationAudit = createApiAccessAuditContext({
    clientId: 'client-create', credentialId: 'credential-create', workspaceId: job.workspaceId,
    environment: 'production', authenticationKind: 'bearer',
  })
  return { job, authenticationAudit, requestFingerprint: hash('f'), transitionId: 'transition-create' }
}
function controlledClient({ failureCode = 'P2034', releaseAfterTurn = true, revokeAfterConflict = false, replay = null } = {}) {
  let attempts = 0
  let released = false
  let authorityReads = 0
  let writes = 0
  let attemptedRow
  if (releaseAfterTurn) setTimeout(() => { released = true }, 0)
  const client = {
    async $transaction(callback, options) {
      attempts += 1
      assert.equal(options.isolationLevel, 'Serializable')
      const transaction = {
        v2Project: { async findFirst(query) {
          authorityReads += 1
          assert.equal(query.where.workspaceId, 'workspace-create')
          return revokeAfterConflict && attempts > 1 ? null : { id: 'project-create' }
        } },
        v2SyntheticPresenterProfile: { async findFirst() { return { id: 'profile-create:v1' } } },
        v2MediaArtifact: { async findMany() { return [] } },
        v2ApiClient: { async findFirst(query) {
          assert.equal(query.where.workspaceId, 'workspace-create')
          return { id: 'client-create' }
        } },
        v2ProviderJob: { async create({ data }) {
          writes += 1
          attemptedRow = data
          assert.equal(data.workspaceId, 'workspace-create')
          assert.equal(data.idempotencyKey, 'key-create')
          if (!released || !releaseAfterTurn) throw Object.assign(new Error('controlled conflict'), { code: failureCode })
          return data
        } },
      }
      return callback(transaction)
    },
    v2ProviderJob: { async findFirst({ where }) {
      assert.equal(where.workspaceId, 'workspace-create')
      assert.equal(where.idempotencyKey, 'key-create')
      return replay === 'matching' ? attemptedRow : replay
    } },
  }
  return { client, get attempts() { return attempts }, get authorityReads() { return authorityReads }, get writes() { return writes } }
}

test('unit: P2034 contention lasting until timer turn permits fresh Serializable create without exceeding four attempts', async () => {
  const fake = controlledClient()
  const result = await new PrismaProviderJobRepository(fake.client).create(fixture())
  assert.equal(result.replayed, false)
  assert.equal(result.persisted.job.id, 'job-create')
  assert.equal(fake.attempts, 2)
  assert.equal(fake.authorityReads, fake.attempts)
  assert.equal(fake.writes, fake.attempts)
})

test('unit: each P2034 retry rechecks authority in a fresh transaction before writing', async () => {
  const fake = controlledClient({ revokeAfterConflict: true })
  await assert.rejects(new PrismaProviderJobRepository(fake.client).create(fixture()), (error) => error.code === 'ASSET_RIGHTS_BLOCKED')
  assert.equal(fake.attempts, 2)
  assert.equal(fake.authorityReads, 2)
  assert.equal(fake.writes, 1)
})

test('unit: exhausted P2034 retains original error and four-attempt cap', async () => {
  const fake = controlledClient({ releaseAfterTurn: false })
  await assert.rejects(new PrismaProviderJobRepository(fake.client).create(fixture()), (error) => error.code === 'P2034' && error.message === 'controlled conflict')
  assert.equal(fake.attempts, 4)
  assert.equal(fake.authorityReads, 4)
})

test('unit: other Prisma errors are not retried', async () => {
  const fake = controlledClient({ releaseAfterTurn: false, failureCode: 'P2003' })
  await assert.rejects(new PrismaProviderJobRepository(fake.client).create(fixture()), (error) => error.code === 'P2003')
  assert.equal(fake.attempts, 1)
})

test('unit: P2002 replay remains scoped to workspace, actor context and idempotency', async () => {
  const input = fixture()
  const winner = controlledClient({ releaseAfterTurn: false, failureCode: 'P2002', replay: 'matching' })
  const result = await new PrismaProviderJobRepository(winner.client).create(input)
  assert.equal(result.replayed, true)
  assert.equal(result.persisted.job.id, input.job.id)
  assert.equal(winner.attempts, 1)
  const missing = controlledClient({ releaseAfterTurn: false, failureCode: 'P2002' })
  await assert.rejects(new PrismaProviderJobRepository(missing.client).create(input), (error) => error.code === 'VERSION_CONFLICT')
  assert.equal(missing.attempts, 1)
})
