import assert from 'node:assert/strict'
import test from 'node:test'

import { DomainError } from '../../src/v2/domain/errors.ts'
import {
  assertMediaArtifactLifecycleTransition,
  mediaArtifactLifecycleTargets,
} from '../../src/v2/domain/media-artifact.ts'
import { transitionMediaArtifactLifecycleService } from '../../src/v2/application/transition-media-artifact-lifecycle.ts'
import { readArtifactContentService } from '../../src/v2/application/read-artifact-content.ts'
import { PrismaMediaArtifactLifecycleRepository } from '../../src/v2/infrastructure/prisma/media-artifact-lifecycle-repository.ts'
import { FOUNDATION_CAPABILITIES } from '../../src/v2/public-api/capability-registry.ts'
import {
  parseMediaArtifactLifecycleTransitionBody,
  presentMediaArtifactLifecycleTransition,
} from '../../src/v2/public-api/media-artifact-lifecycle-contract.ts'

function expectCode(callback, code) {
  assert.throws(callback, (error) => error instanceof DomainError && error.code === code)
}

function memoryPrisma() {
  const state = {
    workspace: { id: 'workspace-lifecycle-1', status: 'active' },
    artifact: {
      id: 'artifact-lifecycle-1', workspaceId: 'workspace-lifecycle-1',
      status: 'available', lifecycleRevision: 1,
    },
    idempotency: new Map(),
    transitions: new Map(),
  }
  const idempotencyKey = (where) => {
    const key = where.workspaceId_clientId_key
    return `${key.workspaceId}:${key.clientId}:${key.key}`
  }
  const transaction = {
    v2IdempotencyRecord: {
      async findUnique({ where }) {
        return state.idempotency.get(idempotencyKey(where)) ?? null
      },
      async delete({ where }) {
        for (const [key, row] of state.idempotency) if (row.id === where.id) state.idempotency.delete(key)
      },
      async create({ data }) {
        const key = `${data.workspaceId}:${data.clientId}:${data.key}`
        if (state.idempotency.has(key)) throw Object.assign(new Error('unique'), { code: 'P2002' })
        const row = { ...data, responseStatus: null, responseJson: null, updatedAt: data.createdAt }
        state.idempotency.set(key, row)
        return row
      },
      async update({ where, data }) {
        for (const [key, row] of state.idempotency) {
          if (row.id === where.id) {
            const next = { ...row, ...data }
            state.idempotency.set(key, next)
            return next
          }
        }
        throw new Error('idempotency row missing')
      },
    },
    v2Workspace: {
      async findUnique({ where }) { return where.id === state.workspace.id ? state.workspace : null },
    },
    v2MediaArtifact: {
      async findFirst({ where }) {
        return where.id === state.artifact.id && where.workspaceId === state.artifact.workspaceId
          ? { ...state.artifact }
          : null
      },
      async updateMany({ where, data }) {
        if (
          where.id !== state.artifact.id || where.workspaceId !== state.artifact.workspaceId ||
          where.status !== state.artifact.status ||
          where.lifecycleRevision !== state.artifact.lifecycleRevision
        ) return { count: 0 }
        state.artifact.status = data.status
        state.artifact.lifecycleRevision += data.lifecycleRevision.increment
        return { count: 1 }
      },
    },
    v2MediaArtifactLifecycleTransition: {
      async findUnique({ where }) { return state.transitions.get(where.id) ?? null },
      async create({ data }) {
        if (state.transitions.has(data.id)) throw Object.assign(new Error('unique'), { code: 'P2002' })
        const row = { ...data }
        state.transitions.set(row.id, row)
        return row
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

test('T-FR-236 artifact lifecycle matrix is exhaustive and deleted is terminal', () => {
  assert.deepEqual(mediaArtifactLifecycleTargets('available'), ['available', 'quarantined', 'deleted'])
  assert.deepEqual(mediaArtifactLifecycleTargets('quarantined'), ['available', 'quarantined', 'deleted'])
  assert.deepEqual(mediaArtifactLifecycleTargets('deleted'), ['deleted'])
  for (const from of ['available', 'quarantined']) {
    for (const target of ['available', 'quarantined', 'deleted']) {
      assert.doesNotThrow(() => assertMediaArtifactLifecycleTransition(from, target))
    }
  }
  assert.doesNotThrow(() => assertMediaArtifactLifecycleTransition('deleted', 'deleted'))
  expectCode(() => assertMediaArtifactLifecycleTransition('deleted', 'available'), 'MEDIA_ARTIFACT_TRANSITION_REJECTED')
  expectCode(() => mediaArtifactLifecycleTargets('stale'), 'INVALID_MEDIA_ARTIFACT')
})

test('T-FR-236 artifact lifecycle command is revision-fenced, idempotent and audited', async () => {
  const { client, state } = memoryPrisma()
  const repository = new PrismaMediaArtifactLifecycleRepository(client)
  let sequence = 0
  const execute = transitionMediaArtifactLifecycleService({
    repository,
    clock: () => new Date('2026-08-02T15:00:00.000Z'),
    createId: () => `123e4567-e89b-42d3-a456-${String(++sequence).padStart(12, '0')}`,
  })
  const base = {
    workspaceId: state.workspace.id,
    artifactId: state.artifact.id,
    actorClientId: 'client-lifecycle-1',
    reason: 'Integrity probe requires human inspection.',
  }
  const quarantined = await execute({
    ...base, baseRevision: 1, targetStatus: 'quarantined', idempotencyKey: 'lifecycle-command-1',
  })
  assert.equal(quarantined.replayed, false)
  assert.equal(quarantined.transition.changed, true)
  assert.equal(quarantined.transition.resultRevision, 2)
  assert.deepEqual(state.artifact, {
    id: state.artifact.id, workspaceId: state.workspace.id,
    status: 'quarantined', lifecycleRevision: 2,
  })
  await assert.rejects(
    readArtifactContentService({
      artifacts: {
        async findById() {
          return {
            ...state.artifact, artifactKey: 'private/artifact.mp4', sha256: 'a'.repeat(64),
            byteSize: 10n, mediaType: 'video', container: 'mp4', manifests: [],
            createdAt: '2026-08-02T15:00:00.000Z',
          }
        },
        async findColorProbe() { return null },
      },
      storage: { async open() { throw new Error('quarantined bytes must not be opened') } },
    })({ workspaceId: state.workspace.id, artifactId: state.artifact.id, rangeHeader: null }),
    (error) => error instanceof DomainError && error.code === 'MEDIA_ARTIFACT_NOT_FOUND',
  )
  const replay = await execute({
    ...base, baseRevision: 1, targetStatus: 'quarantined', idempotencyKey: 'lifecycle-command-1',
  })
  assert.equal(replay.replayed, true)
  assert.equal(replay.transition.id, quarantined.transition.id)
  assert.equal(state.transitions.size, 1)

  await assert.rejects(
    execute({
      ...base, reason: 'Different reason.', baseRevision: 1,
      targetStatus: 'quarantined', idempotencyKey: 'lifecycle-command-1',
    }),
    (error) => error instanceof DomainError && error.code === 'IDEMPOTENCY_PAYLOAD_MISMATCH',
  )
  await assert.rejects(
    execute({
      ...base, baseRevision: 1, targetStatus: 'available', idempotencyKey: 'lifecycle-command-stale',
    }),
    (error) => error instanceof DomainError && error.code === 'MEDIA_ARTIFACT_LIFECYCLE_REVISION_MISMATCH',
  )

  const restored = await execute({
    ...base, baseRevision: 2, targetStatus: 'available', idempotencyKey: 'lifecycle-command-2',
  })
  assert.equal(restored.transition.resultRevision, 3)
  const deleted = await execute({
    ...base, baseRevision: 3, targetStatus: 'deleted', idempotencyKey: 'lifecycle-command-3',
  })
  assert.equal(deleted.transition.resultRevision, 4)
  await assert.rejects(
    execute({
      ...base, baseRevision: 4, targetStatus: 'available', idempotencyKey: 'lifecycle-command-resurrect',
    }),
    (error) => error instanceof DomainError && error.code === 'MEDIA_ARTIFACT_TRANSITION_REJECTED',
  )
  const noop = await execute({
    ...base, baseRevision: 4, targetStatus: 'deleted', idempotencyKey: 'lifecycle-command-noop',
  })
  assert.equal(noop.transition.changed, false)
  assert.equal(noop.transition.resultRevision, 4)
  assert.equal(state.artifact.lifecycleRevision, 4)
})

test('T-FR-236 lifecycle public contract is exact, immutable and API-first', () => {
  assert.deepEqual(parseMediaArtifactLifecycleTransitionBody({
    baseRevision: 1, targetStatus: 'quarantined', reason: 'Needs inspection.',
  }), { baseRevision: 1, targetStatus: 'quarantined', reason: 'Needs inspection.' })
  expectCode(
    () => parseMediaArtifactLifecycleTransitionBody({
      baseRevision: 1, targetStatus: 'quarantined', reason: 'Needs inspection.', extra: true,
    }),
    'INVALID_ARGUMENT',
  )
  const presented = presentMediaArtifactLifecycleTransition({
    id: 'transition-1', workspaceId: 'workspace-1', artifactId: 'artifact-1',
    baseRevision: 1, resultRevision: 2, fromStatus: 'available',
    targetStatus: 'quarantined', changed: true, reason: 'Needs inspection.',
    actorClientId: 'client-1', idempotencyKey: 'lifecycle-key',
    requestFingerprint: 'a'.repeat(64), createdAt: '2026-08-02T15:00:00.000Z',
  })
  assert.equal(presented.visibleState.label, 'quarantined')
  assert.throws(() => presented.visibleState.availableActions.push('open-result'))
  const capability = FOUNDATION_CAPABILITIES.find((item) =>
    item.id === 'apollo.artifacts.lifecycle.transition')
  assert.equal(capability.version, '1.0.0')
  assert.deepEqual(capability.requiredScopes, ['artifacts:write'])
  assert.equal(capability.idempotency, 'required')
  assert.equal(capability.endpoint.path, '/v1/artifacts/{artifactId}/lifecycle-transitions')
})
