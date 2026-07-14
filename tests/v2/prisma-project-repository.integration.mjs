import assert from 'node:assert/strict'
import test from 'node:test'

test('Prisma adapter atomically creates and replays a v2 project', async () => {
  const clientPackage =
    process.env.APOLLO_V2_PERSISTENCE === 'postgres'
      ? '../../generated/prisma-v2/index.js'
      : '@prisma/client'
  const { PrismaClient } = await import(clientPackage)
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
    const createProject = createProjectService({
      repository: new PrismaProjectCreationRepository(client),
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
    assert.deepEqual(outbox.map((event) => event.type), [
      'project.created',
      'project.version.created',
    ])
    assert.ok(outbox.every((event) => event.publishedAt === null))
    assert.equal(outbox[0].resourceId, first.project.id)
    assert.equal(outbox[1].resourceId, first.version.id)
    assert.equal(JSON.parse(outbox[1].dataJson).projectId, first.project.id)

    let collisionEventCall = 0
    const createProjectWithCollision = createProjectService({
      repository: new PrismaProjectCreationRepository(client),
      clock: () => new Date(testNow.getTime() + 1_000),
      createId: createEntityId,
      createEventId: () => {
        collisionEventCall += 1
        return collisionEventCall === 1
          ? outbox[0].id
          : '00000000-0000-4000-8000-999999999999'
      },
    })
    await assert.rejects(
      () => createProjectWithCollision({
        ...request,
        name: 'Project that must roll back',
        idempotency: { ...request.idempotency, key: 'integration-create-project-collision' },
      }),
      (error) => error?.code === 'PERSISTENCE_CONFLICT',
    )
    assert.equal(await client.v2Project.count({ where: { workspaceId } }), 1)
    assert.equal(await client.v2IdempotencyRecord.count({ where: { workspaceId } }), 1)
    assert.equal(await client.v2PublicEventOutbox.count({ where: { workspaceId } }), 2)
  } finally {
    await client.v2PublicEventOutbox.deleteMany({ where: { workspaceId } })
    await client.v2IdempotencyRecord.deleteMany({ where: { workspaceId } })
    await client.v2Project.deleteMany({ where: { workspaceId } })
    await client.v2Workspace.deleteMany({ where: { id: workspaceId } })
    await client.$disconnect()
  }
})
