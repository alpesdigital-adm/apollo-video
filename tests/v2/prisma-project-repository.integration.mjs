import assert from 'node:assert/strict'
import test from 'node:test'

import { PrismaClient } from '../../generated/prisma-v2/index.js'

test('Prisma adapter atomically creates and replays a v2 project', async () => {
  const { createProjectService } = await import('../../src/v2/application/create-project.ts')
  const { createWorkspace } = await import('../../src/v2/domain/workspace.ts')
  const { PrismaProjectCreationRepository } = await import(
    '../../src/v2/infrastructure/prisma/project-creation-repository.ts'
  )
  const { PrismaWorkspaceRepository } = await import(
    '../../src/v2/infrastructure/prisma/workspace-repository.ts'
  )

  const client = new PrismaClient()
  const workspaceId = 'integration-workspace-v2'
  const clientId = 'integration-client-v2'
  const testNow = new Date()

  try {
    await client.v2PublicEventOutbox.deleteMany({ where: { workspaceId } })
    await client.v2IdempotencyRecord.deleteMany({ where: { workspaceId } })
    await client.v2Project.deleteMany({ where: { workspaceId } })
    await client.v2Workspace.deleteMany({ where: { id: workspaceId } })

    const workspaceRepository = new PrismaWorkspaceRepository(client)
    await workspaceRepository.create(
      createWorkspace({
        id: workspaceId,
        slug: 'integration-workspace-v2',
        name: 'Integration Workspace V2',
        status: 'active',
        createdAt: '2026-07-12T14:00:00.000Z',
      }),
    )

    const counters = new Map()
    const createEntityId = (kind) => {
      const next = (counters.get(kind) ?? 0) + 1
      counters.set(kind, next)
      return `integration-${kind}-${next}`
    }
    let eventCounter = 0
    const repository = new PrismaProjectCreationRepository(client)
    const createProject = createProjectService({
      repository,
      clock: () => testNow,
      createId: createEntityId,
      createEventId: () => {
        eventCounter += 1
        return `00000000-0000-4000-8000-${String(eventCounter).padStart(12, '0')}`
      },
    })
    const request = {
      workspaceId,
      name: 'Projeto integração',
      actor: { type: 'api-client', id: clientId },
      idempotency: { clientId, key: 'integration-create-project' },
    }

    const first = await createProject(request)
    const replay = await createProject(request)

    assert.equal(first.replayed, false)
    assert.equal(replay.replayed, true)
    assert.equal(replay.project.id, first.project.id)
    assert.equal(await client.v2Project.count({ where: { workspaceId } }), 1)
    assert.equal(await client.v2ProjectVersion.count({ where: { workspaceId } }), 1)
    assert.equal(await client.v2ProjectSnapshot.count({ where: { workspaceId } }), 2)
    assert.equal(await client.v2IdempotencyRecord.count({ where: { workspaceId } }), 1)
    const outbox = await client.v2PublicEventOutbox.findMany({
      where: { workspaceId },
      orderBy: [{ occurredAt: 'asc' }, { id: 'asc' }],
    })
    assert.deepEqual(
      outbox.map((event) => event.type),
      ['project.created', 'project.version.created'],
    )
    assert.ok(outbox.every((event) => event.publishedAt === null))
    assert.equal(outbox[0].resourceId, first.project.id)
    assert.equal(outbox[1].resourceId, first.version.id)
    assert.equal(JSON.parse(outbox[1].dataJson).projectId, first.project.id)

    const concurrentRequest = {
      ...request,
      name: 'Projeto concorrente',
      idempotency: {
        ...request.idempotency,
        key: 'integration-create-project-concurrent',
      },
    }
    const concurrentResults = await Promise.all([
      createProject(concurrentRequest),
      createProject(concurrentRequest),
    ])
    assert.deepEqual(concurrentResults.map((result) => result.replayed).sort(), [false, true])
    assert.equal(concurrentResults[0].project.id, concurrentResults[1].project.id)
    assert.equal(concurrentResults[0].version.id, concurrentResults[1].version.id)
    assert.equal(await client.v2Project.count({ where: { workspaceId } }), 2)
    assert.equal(await client.v2ProjectVersion.count({ where: { workspaceId } }), 2)
    assert.equal(await client.v2ProjectSnapshot.count({ where: { workspaceId } }), 4)
    assert.equal(await client.v2PublicEventOutbox.count({ where: { workspaceId } }), 4)

    let discardCommittedResponse = true
    const createProjectWithResponseLoss = createProjectService({
      repository: {
        async createOrReplay(bundle) {
          const result = await repository.createOrReplay(bundle)
          if (discardCommittedResponse) {
            discardCommittedResponse = false
            throw new Error('simulated response loss after project commit')
          }
          return result
        },
      },
      clock: () => new Date(testNow.getTime() + 2_000),
      createId: createEntityId,
      createEventId: () => {
        eventCounter += 1
        return `00000000-0000-4000-8000-${String(eventCounter).padStart(12, '0')}`
      },
    })
    const responseLossRequest = {
      ...request,
      name: 'Projeto resposta perdida',
      idempotency: {
        ...request.idempotency,
        key: 'integration-create-project-response-loss',
      },
    }
    await assert.rejects(
      () => createProjectWithResponseLoss(responseLossRequest),
      /simulated response loss after project commit/,
    )
    const recovered = await createProjectWithResponseLoss(responseLossRequest)
    assert.equal(recovered.replayed, true)
    assert.equal(await client.v2Project.count({ where: { workspaceId } }), 3)
    assert.equal(await client.v2ProjectVersion.count({ where: { workspaceId } }), 3)
    assert.equal(await client.v2ProjectSnapshot.count({ where: { workspaceId } }), 6)
    assert.equal(await client.v2PublicEventOutbox.count({ where: { workspaceId } }), 6)

    const mismatchedKey = 'integration-create-project-concurrent-mismatch'
    const mismatchedResults = await Promise.allSettled([
      createProject({
        ...request,
        name: 'Projeto vencedor A',
        idempotency: { ...request.idempotency, key: mismatchedKey },
      }),
      createProject({
        ...request,
        name: 'Projeto vencedor B',
        idempotency: { ...request.idempotency, key: mismatchedKey },
      }),
    ])
    assert.equal(mismatchedResults.filter((result) => result.status === 'fulfilled').length, 1)
    const mismatchedFailure = mismatchedResults.find((result) => result.status === 'rejected')
    assert.equal(mismatchedFailure?.reason?.code, 'IDEMPOTENCY_PAYLOAD_MISMATCH')
    assert.equal(await client.v2Project.count({ where: { workspaceId } }), 4)
    assert.equal(await client.v2ProjectVersion.count({ where: { workspaceId } }), 4)
    assert.equal(await client.v2ProjectSnapshot.count({ where: { workspaceId } }), 8)
    assert.equal(await client.v2IdempotencyRecord.count({ where: { workspaceId } }), 4)
    assert.equal(await client.v2PublicEventOutbox.count({ where: { workspaceId } }), 8)

    let collisionEventCall = 0
    const createProjectWithCollision = createProjectService({
      repository: new PrismaProjectCreationRepository(client),
      clock: () => new Date(testNow.getTime() + 1_000),
      createId: createEntityId,
      createEventId: () => {
        collisionEventCall += 1
        return collisionEventCall === 1 ? outbox[0].id : '00000000-0000-4000-8000-999999999999'
      },
    })
    await assert.rejects(
      () =>
        createProjectWithCollision({
          ...request,
          name: 'Project that must roll back',
          idempotency: {
            ...request.idempotency,
            key: 'integration-create-project-collision',
          },
        }),
      (error) => error?.code === 'PERSISTENCE_CONFLICT',
    )
    assert.equal(await client.v2Project.count({ where: { workspaceId } }), 4)
    assert.equal(await client.v2IdempotencyRecord.count({ where: { workspaceId } }), 4)
    assert.equal(await client.v2PublicEventOutbox.count({ where: { workspaceId } }), 8)
  } finally {
    await client.v2PublicEventOutbox.deleteMany({ where: { workspaceId } })
    await client.v2IdempotencyRecord.deleteMany({ where: { workspaceId } })
    await client.v2Project.deleteMany({ where: { workspaceId } })
    await client.v2Workspace.deleteMany({ where: { id: workspaceId } })
    await client.$disconnect()
  }
})
