import assert from 'node:assert/strict'
import test from 'node:test'

import { createExternalAuditContext } from '../../src/v2/application/authenticate-api-client.ts'
import { putPerceptionTimelineService } from '../../src/v2/application/perception-timelines.ts'
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
