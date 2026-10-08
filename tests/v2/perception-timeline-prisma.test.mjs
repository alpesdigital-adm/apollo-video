import assert from 'node:assert/strict'
import { randomUUID } from 'node:crypto'
import test from 'node:test'

import { createExternalAuditContext } from '../../src/v2/application/authenticate-api-client.ts'
import { putPerceptionTimelineService, readPerceptionTimelineRangeService } from '../../src/v2/application/perception-timelines.ts'
import { calculateCanonicalHash } from '../../src/v2/domain/canonical-hash.ts'
import { PERCEPTION_GOLDEN_FIXTURES } from '../../src/v2/domain/perception-timeline.ts'
import { PrismaPerceptionTimelineRepository } from '../../src/v2/infrastructure/prisma/perception-timeline-repository.ts'

function actor() {
  const auditContext = createExternalAuditContext({
    clientId: 'client-perception', credentialId: 'credential-perception', workspaceId: 'workspace-perception', environment: 'production',
  })
  return Object.freeze({
    ...auditContext, scopes: new Set(['projects:write']), authenticationKind: 'bearer',
    clientKillSwitchEngaged: false, workspaceKillSwitchEngaged: false,
    clientAccessStatus: 'active', workspaceAccessStatus: 'active', auditContext,
  })
}

function controlledPrisma() {
  const state = { row: null, projectVersionReads: 0, actorReads: 0 }
  const perception = {
    async findUnique({ where }) {
      if (!state.row) return null
      const key = where.workspaceId_projectId_idempotencyKey
      return state.row.workspaceId === key.workspaceId && state.row.projectId === key.projectId && state.row.idempotencyKey === key.idempotencyKey ? state.row : null
    },
    async findFirst() { return state.row },
    async create({ data }) {
      state.row = { ...data, delegatedUserId: data.delegatedUserId ?? null, delegatedIdentityId: data.delegatedIdentityId ?? null, workspaceRole: data.workspaceRole ?? null }
      return state.row
    },
  }
  const transaction = {
    v2PerceptionTimeline: perception,
    v2ProjectVersion: { async findFirst() { state.projectVersionReads += 1; return { id: 'version-perception' } } },
    v2ApiClient: { async findFirst() { state.actorReads += 1; return { id: 'client-perception' } } },
  }
  return {
    state,
    client: {
      v2PerceptionTimeline: perception,
      v2Project: { async findFirst() { return { id: 'project-perception' } } },
      async $transaction(callback) { return callback(transaction) },
    },
  }
}

test('T-FR-050 Prisma adapter binds project version, actor audit, immutable JSON and replay', async () => {
  const controlled = controlledPrisma()
  const repository = new PrismaPerceptionTimelineRepository(controlled.client)
  const service = putPerceptionTimelineService({
    repository, clock: () => new Date('2026-08-12T21:00:00.000Z'), createId: () => 'perception-timeline-prisma-1',
  })
  const fixture = PERCEPTION_GOLDEN_FIXTURES.talkingHead
  const request = {
    workspaceId: 'workspace-perception', projectId: 'project-perception', projectVersionId: 'version-perception', baseRevision: null,
    durationMs: fixture.durationMs, observations: fixture.observations,
    coverage: fixture.coverage.map((entry) => ({ kind: entry.kind, ranges: entry.ranges })),
    idempotencyKey: 'perception-prisma-0001', actor: actor(),
  }
  const created = await service(request)
  assert.equal(created.replayed, false)
  assert.equal(controlled.state.projectVersionReads, 1)
  assert.equal(controlled.state.actorReads, 1)
  assert.equal(controlled.state.row.timelineHash, fixture.timelineHash)
  assert.equal(controlled.state.row.baseRevision, null)
  assert.equal(JSON.parse(controlled.state.row.timelineJson).inventedValues, 0)
  assert.equal(controlled.state.row.actorCredentialId, 'credential-perception')
  assert.deepEqual(created.timeline.origin, { kind: 'manual-controlled', trust: 'unverified', suppliedByClientId: 'client-perception' })
  assert.equal((await service(request)).replayed, true)
  assert.equal(controlled.state.projectVersionReads, 1)
  await assert.rejects(
    service({ ...request, idempotencyKey: 'perception-prisma-0002' }),
    (error) => error.code === 'VERSION_CONFLICT',
  )

  const latest = await repository.findLatest({ workspaceId: request.workspaceId, projectId: request.projectId })
  assert.equal(latest.timeline.timelineHash, fixture.timelineHash)
  controlled.state.row = { ...controlled.state.row, timelineHash: 'f'.repeat(64) }
  await assert.rejects(
    repository.findLatest({ workspaceId: request.workspaceId, projectId: request.projectId }),
    (error) => error.code === 'PERSISTENCE_CONFLICT',
  )
})

test('PostgreSQL seals manual perception origin and rejects stale or altered records', {
  skip: process.env.APOLLO_PERCEPTION_PG_TEST !== '1' && 'requires isolated local PostgreSQL',
}, async () => {
  const databaseUrl = new URL(process.env.V2_DATABASE_URL)
  assert.ok(['localhost', '127.0.0.1', '::1', '[::1]'].includes(databaseUrl.hostname))
  const { PrismaClient } = await import('../../generated/prisma-v2/index.js')
  const client = new PrismaClient()
  const suffix = randomUUID().slice(0, 12)
  const workspaceId = `perception-pg-${suffix}`
  const clientId = `perception-client-${suffix}`
  const projectId = `perception-project-${suffix}`
  const versionId = `perception-version-${suffix}`
  const createdAt = new Date('2026-08-12T21:00:00.000Z')
  const snapshotIds = ['brief', 'edit-plan', 'policies'].map((kind) => `perception-${kind}-${suffix}`)
  try {
    await client.v2Workspace.create({ data: { id: workspaceId, slug: workspaceId, name: 'Perception PG test' } })
    await client.v2ApiClient.create({ data: {
      id: clientId, workspaceId, name: 'Perception test client',
      allowedEnvironmentsJson: '["production"]', scopeGrantsJson: '["projects:write"]', createdBy: 'test',
    } })
    await client.v2Project.create({ data: {
      id: projectId, workspaceId, name: 'Perception test project', objective: 'discovery', format: '9:16',
      createdByType: 'api-client', createdById: clientId,
    } })
    for (const [index, kind] of ['brief', 'edit-plan', 'policies'].entries()) {
      const content = { kind, test: true }
      await client.v2ProjectSnapshot.create({ data: {
        id: snapshotIds[index], workspaceId, projectId, kind, schemaVersion: 1,
        contentJson: JSON.stringify(content), contentHash: calculateCanonicalHash(content), createdAt,
      } })
    }
    await client.v2ProjectVersion.create({ data: {
      id: versionId, workspaceId, projectId, sequence: 1,
      briefSnapshotId: snapshotIds[0], editPlanSnapshotId: snapshotIds[1], policiesSnapshotId: snapshotIds[2],
      baseHash: 'a'.repeat(64), createdBy: clientId, createdAt,
    } })
    const auditContext = createExternalAuditContext({
      clientId, credentialId: `perception-credential-${suffix}`, workspaceId, environment: 'production',
    })
    const actor = Object.freeze({ ...auditContext, scopes: new Set(['projects:write']), authenticationKind: 'bearer',
      clientKillSwitchEngaged: false, workspaceKillSwitchEngaged: false,
      clientAccessStatus: 'active', workspaceAccessStatus: 'active', auditContext })
    const repository = new PrismaPerceptionTimelineRepository(client)
    const put = putPerceptionTimelineService({ repository, clock: () => createdAt, createId: () => `perception-record-${suffix}` })
    const fixture = PERCEPTION_GOLDEN_FIXTURES.talkingHead
    const request = { workspaceId, projectId, projectVersionId: versionId, baseRevision: null,
      durationMs: fixture.durationMs, observations: fixture.observations,
      coverage: fixture.coverage.map(({ kind, ranges }) => ({ kind, ranges })),
      idempotencyKey: `perception-pg-${suffix}`, actor }
    const first = await put(request)
    assert.deepEqual(first.timeline.origin, { kind: 'manual-controlled', trust: 'unverified', suppliedByClientId: clientId })
    assert.equal(first.timeline.timeline.observations[0].provenance.source, 'fixture')
    assert.equal((await put(request)).replayed, true)
    const range = await readPerceptionTimelineRangeService({ repository })({ workspaceId, projectId, startMs: 0, endMs: 1500, kinds: ['face'] })
    assert.equal(range.origin.trust, 'unverified')
    await assert.rejects(put({ ...request, idempotencyKey: `perception-pg-stale-${suffix}` }),
      (error) => error.code === 'VERSION_CONFLICT')
    const row = await client.v2PerceptionTimeline.findFirstOrThrow({ where: { workspaceId, projectId } })
    await client.v2PerceptionTimeline.update({ where: { id: row.id }, data: { recordHash: 'f'.repeat(64) } })
    await assert.rejects(repository.findLatest({ workspaceId, projectId }),
      (error) => error.code === 'PERSISTENCE_CONFLICT')
  } finally {
    await client.v2PerceptionTimeline.deleteMany({ where: { workspaceId } })
    await client.v2ProjectVersion.deleteMany({ where: { workspaceId } })
    await client.v2ProjectSnapshot.deleteMany({ where: { workspaceId } })
    await client.v2Project.deleteMany({ where: { workspaceId } })
    await client.v2ApiClient.deleteMany({ where: { workspaceId } })
    await client.v2Workspace.deleteMany({ where: { id: workspaceId } })
    await client.$disconnect()
  }
})
