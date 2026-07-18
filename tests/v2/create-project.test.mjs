import assert from 'node:assert/strict'
import test from 'node:test'

import { createProjectService } from '../../src/v2/application/create-project.ts'
import { DomainError } from '../../src/v2/domain/errors.ts'
import { createWorkspace } from '../../src/v2/domain/workspace.ts'
import { PrismaProjectCreationRepository } from '../../src/v2/infrastructure/prisma/project-creation-repository.ts'

class InMemoryProjectCreationRepository {
  constructor(workspaces) {
    this.workspaces = new Map(workspaces.map((workspace) => [workspace.id, workspace]))
    this.records = new Map()
    this.events = new Map()
    this.lastBundle = undefined
  }

  async createOrReplay(bundle) {
    const workspace = this.workspaces.get(bundle.project.workspaceId)
    if (!workspace || workspace.status !== 'active') {
      throw new DomainError('WORKSPACE_NOT_FOUND', 'Active workspace was not found')
    }

    const identity = [
      bundle.idempotency.workspaceId,
      bundle.idempotency.clientId,
      bundle.idempotency.key,
    ].join(':')
    const existing = this.records.get(identity)

    if (existing) {
      if (existing.fingerprint !== bundle.idempotency.requestFingerprint) {
        throw new DomainError(
          'IDEMPOTENCY_PAYLOAD_MISMATCH',
          'Idempotency key was already used with a different request',
        )
      }
      return { ...existing.result, replayed: true }
    }

    this.lastBundle = bundle
    for (const event of bundle.events) {
      if (this.events.has(event.id)) {
        throw new DomainError('PERSISTENCE_CONFLICT', 'Duplicate public event')
      }
      this.events.set(event.id, event)
    }
    const result = {
      project: bundle.project,
      version: bundle.version,
      replayed: false,
    }
    this.records.set(identity, {
      fingerprint: bundle.idempotency.requestFingerprint,
      result,
    })
    return result
  }
}

function createFixture() {
  const workspace = createWorkspace({
    id: 'workspace-1',
    slug: 'alpes-digital',
    name: '  Alpes   Digital ',
    status: 'active',
    createdAt: '2026-07-12T13:00:00.000Z',
  })
  const repository = new InMemoryProjectCreationRepository([workspace])
  const counters = new Map()
  let eventCounter = 0
  const service = createProjectService({
    repository,
    clock: () => new Date('2026-07-12T13:01:00.000Z'),
    createId: (kind) => {
      const next = (counters.get(kind) ?? 0) + 1
      counters.set(kind, next)
      return `${kind}-${next}`
    },
    createEventId: () => {
      eventCounter += 1
      return `00000000-0000-4000-8000-${String(eventCounter).padStart(12, '0')}`
    },
  })

  return { workspace, repository, service }
}

function request(overrides = {}) {
  return {
    workspaceId: 'workspace-1',
    name: '  Campanha   Julho  ',
    objective: 'discovery',
    format: '9:16',
    briefing: 'Público: gestores. Oferta: conteúdo. Tom: direto e natural.',
    actor: { type: 'api-client', id: 'client-1' },
    idempotency: { clientId: 'client-1', key: 'create-project-1' },
    ...overrides,
  }
}

test('workspace aggregate normalizes stable public fields', () => {
  const { workspace } = createFixture()

  assert.equal(workspace.slug, 'alpes-digital')
  assert.equal(workspace.name, 'Alpes Digital')
  assert.ok(Object.isFrozen(workspace))
})

test('create project persists an initial version and immutable snapshots', async () => {
  const { repository, service } = createFixture()
  const result = await service(request())

  assert.equal(result.replayed, false)
  assert.equal(result.project.name, 'Campanha Julho')
  assert.equal(result.project.status, 'draft')
  assert.equal(result.project.objective, 'discovery')
  assert.equal(result.project.format, '9:16')
  assert.equal(result.project.locale, 'pt-BR')
  assert.equal(result.project.currentVersionId, result.version.id)
  assert.equal(result.version.sequence, 1)
  assert.equal(repository.lastBundle.snapshots.length, 3)
  assert.deepEqual(
    repository.lastBundle.snapshots.map((snapshot) => snapshot.kind),
    ['brief', 'edit-plan', 'policies'],
  )
  assert.ok(repository.lastBundle.snapshots.every((snapshot) => snapshot.contentHash.length === 64))
  assert.equal(result.version.snapshotRefs.brief, repository.lastBundle.snapshots[0].id)
  assert.equal(result.version.snapshotRefs.editPlan, repository.lastBundle.snapshots[1].id)
  const brief = JSON.parse(repository.lastBundle.snapshots[0].contentJson)
  assert.equal(brief.productionBrief.ownerInput.trust, 'owner-authorized')
  assert.equal(brief.outputSpec.aspectRatio, '9:16')
  assert.equal(brief.objective, 'discovery')
  assert.deepEqual(
    repository.lastBundle.events.map((event) => event.type),
    ['project.created', 'project.version.created'],
  )
  assert.deepEqual(repository.lastBundle.events[0].actor, {
    clientId: 'client-1',
  })
  assert.deepEqual(repository.lastBundle.events[0].resource, {
    type: 'project',
    id: result.project.id,
  })
  assert.equal(repository.lastBundle.events[1].sequence, 1)
  assert.equal(repository.lastBundle.events[1].data.projectId, result.project.id)
  assert.equal(repository.events.size, 2)
})

test('same idempotency key and payload replays the original result', async () => {
  const { repository, service } = createFixture()
  const first = await service(request())
  const replay = await service(request())

  assert.equal(replay.replayed, true)
  assert.equal(replay.project.id, first.project.id)
  assert.equal(replay.version.id, first.version.id)
  assert.equal(repository.events.size, 2)
})

test('same idempotency key with a different payload is rejected', async () => {
  const { service } = createFixture()
  await service(request())

  await assert.rejects(
    () => service(request({ name: 'Outra campanha' })),
    (error) => error instanceof DomainError && error.code === 'IDEMPOTENCY_PAYLOAD_MISMATCH',
  )
})

test('project creation retries serialization conflicts before returning an explicit conflict', async () => {
  const { repository, service } = createFixture()
  await service(request())
  let attempts = 0
  const prismaRepository = new PrismaProjectCreationRepository({
    async $transaction() {
      attempts += 1
      const error = new Error('serialization conflict')
      error.code = 'P2034'
      throw error
    },
  })

  await assert.rejects(
    () => prismaRepository.createOrReplay(repository.lastBundle),
    (error) => error instanceof DomainError && error.code === 'PERSISTENCE_CONFLICT',
  )
  assert.equal(attempts, 3)
})

test('unknown workspace is rejected before a project is persisted', async () => {
  const { service } = createFixture()

  await assert.rejects(
    () => service(request({ workspaceId: 'workspace-missing' })),
    (error) => error instanceof DomainError && error.code === 'WORKSPACE_NOT_FOUND',
  )
})
