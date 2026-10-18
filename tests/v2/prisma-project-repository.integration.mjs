import assert from 'node:assert/strict'
import { randomUUID } from 'node:crypto'
import test from 'node:test'

import { PrismaClient } from '../../generated/prisma-v2/index.js'

test('Prisma adapter atomically creates and replays a v2 project', async () => {
  const { createProjectService } = await import('../../src/v2/application/create-project.ts')
  const { createApiClientService } = await import('../../src/v2/application/create-api-client.ts')
  const { createExternalAuditContext, materializeActorAuditContext } = await import(
    '../../src/v2/application/authenticate-api-client.ts'
  )
  const { createWorkspace } = await import('../../src/v2/domain/workspace.ts')
  const { PrismaCreationOutputBundleRepositoryV2 } = await import(
    '../../src/v2/infrastructure/prisma/output-version-bundle-repository.ts'
  )
  const { PrismaApiClientRepository } = await import(
    '../../src/v2/infrastructure/prisma/api-client-repository.ts'
  )
  const { PrismaWorkspaceRepository } = await import(
    '../../src/v2/infrastructure/prisma/workspace-repository.ts'
  )
  const { nodeApiCredentialCrypto } = await import(
    '../../src/v2/infrastructure/security/api-credential.ts'
  )

  const client = new PrismaClient()
  // Creation Commands are sealed and append-only, so nothing here is deleted: every identity is unique to this invocation and the
  // counts below are scoped to this invocation's workspace.
  const run = randomUUID().replaceAll('-', '').slice(0, 12)
  const workspaceId = `integration-workspace-v2-${run}`
  const clientId = `integration-client-v2-${run}`
  const testNow = new Date()

  try {
    const workspaceRepository = new PrismaWorkspaceRepository(client)
    await workspaceRepository.create(
      createWorkspace({
        id: workspaceId,
        slug: workspaceId,
        name: 'Integration Workspace V2',
        status: 'active',
        createdAt: '2026-07-12T14:00:00.000Z',
      }),
    )
    const issued = await createApiClientService({
      repository: new PrismaApiClientRepository(client),
      credentialCrypto: nodeApiCredentialCrypto,
      clock: () => testNow,
    })({
      id: clientId,
      credentialId: `integration-credential-v2-${run}`,
      workspaceId,
      name: 'Project repository integration client',
      environment: 'sandbox',
      scopes: ['projects:write'],
    })
    const auditContext = createExternalAuditContext({
      clientId,
      credentialId: issued.credential.id,
      workspaceId,
      environment: 'sandbox',
    })
    const actor = Object.freeze({
      ...auditContext,
      scopes: new Set(['projects:write']),
      authenticationKind: 'bearer',
      clientKillSwitchEngaged: false,
      workspaceKillSwitchEngaged: false,
      clientAccessStatus: 'active',
      workspaceAccessStatus: 'active',
      auditContext,
    })

    const counters = new Map()
    const createEntityId = (kind) => {
      const next = (counters.get(kind) ?? 0) + 1
      counters.set(kind, next)
      return `integration-${run}-${kind}-${next}`
    }
    const repository = new PrismaCreationOutputBundleRepositoryV2(client)
    const createProject = createProjectService({
      repository,
      clock: () => testNow,
      createId: createEntityId,
      createEventId: randomUUID,
    })
    const request = {
      workspaceId,
      name: 'Projeto integração',
      objective: 'discovery',
      briefing: 'Público: gestores. Oferta: conteúdo. Tom: direto.',
      actor,
      idempotencyKey: 'integration-create-project',
    }

    const first = await createProject(request)
    const replay = await createProject(request)

    assert.equal(first.replayed, false)
    assert.equal(replay.replayed, true)
    assert.equal(replay.projectAtCreation.id, first.projectAtCreation.id)
    assert.equal(await client.v2Project.count({ where: { workspaceId } }), 1)
    assert.equal(await client.v2ProjectVersion.count({ where: { workspaceId } }), 1)
    assert.equal(await client.v2ProjectSnapshot.count({ where: { workspaceId } }), 3)
    assert.equal(await client.v2IdempotencyRecord.count({ where: { workspaceId } }), 1)
    const firstAuditCommand = await client.v2ProjectCreationCommand.findUnique({
      where: { projectId_workspaceId: { projectId: first.projectAtCreation.id, workspaceId } },
    })
    assert.equal(firstAuditCommand?.action, 'create')
    assert.equal(firstAuditCommand?.actorClientId, clientId)
    assert.equal(firstAuditCommand?.actorCredentialId, issued.credential.id)
    assert.equal(
      firstAuditCommand?.actorContextHash,
      materializeActorAuditContext(actor).contextHash,
    )
    assert.equal(firstAuditCommand?.projectId, first.projectAtCreation.id)
    assert.equal(firstAuditCommand?.versionId, first.creationVersion.id)
    const outbox = await client.v2PublicEventOutbox.findMany({
      where: { workspaceId },
      orderBy: [{ occurredAt: 'asc' }, { id: 'asc' }],
    })
    assert.deepEqual(
      outbox.map((event) => event.type),
      ['project.created', 'project.version.created'],
    )
    assert.ok(outbox.every((event) => event.publishedAt === null))
    assert.equal(outbox[0].resourceId, first.projectAtCreation.id)
    assert.equal(outbox[1].resourceId, first.creationVersion.id)
    assert.equal(JSON.parse(outbox[1].dataJson).projectId, first.projectAtCreation.id)

    const concurrentRequest = {
      ...request,
      name: 'Projeto concorrente',
      idempotencyKey: 'integration-create-project-concurrent',
    }
    const concurrentResults = await Promise.all([
      createProject(concurrentRequest),
      createProject(concurrentRequest),
    ])
    assert.deepEqual(concurrentResults.map((result) => result.replayed).sort(), [false, true])
    assert.equal(concurrentResults[0].projectAtCreation.id, concurrentResults[1].projectAtCreation.id)
    assert.equal(concurrentResults[0].creationVersion.id, concurrentResults[1].creationVersion.id)
    assert.equal(await client.v2Project.count({ where: { workspaceId } }), 2)
    assert.equal(await client.v2ProjectVersion.count({ where: { workspaceId } }), 2)
    assert.equal(await client.v2ProjectSnapshot.count({ where: { workspaceId } }), 6)
    assert.equal(await client.v2PublicEventOutbox.count({ where: { workspaceId } }), 4)

    let discardCommittedResponse = true
    const createProjectWithResponseLoss = createProjectService({
      repository: {
        async persist(input) {
          const result = await repository.persist(input)
          if (discardCommittedResponse) {
            discardCommittedResponse = false
            throw new Error('simulated response loss after project commit')
          }
          return result
        },
      },
      clock: () => new Date(testNow.getTime() + 2_000),
      createId: createEntityId,
      createEventId: randomUUID,
    })
    const responseLossRequest = {
      ...request,
      name: 'Projeto resposta perdida',
      idempotencyKey: 'integration-create-project-response-loss',
    }
    await assert.rejects(
      () => createProjectWithResponseLoss(responseLossRequest),
      /simulated response loss after project commit/,
    )
    const recovered = await createProjectWithResponseLoss(responseLossRequest)
    assert.equal(recovered.replayed, true)
    assert.equal(await client.v2Project.count({ where: { workspaceId } }), 3)
    assert.equal(await client.v2ProjectVersion.count({ where: { workspaceId } }), 3)
    assert.equal(await client.v2ProjectSnapshot.count({ where: { workspaceId } }), 9)
    assert.equal(await client.v2PublicEventOutbox.count({ where: { workspaceId } }), 6)

    const mismatchedKey = 'integration-create-project-concurrent-mismatch'
    const mismatchedResults = await Promise.allSettled([
      createProject({
        ...request,
        name: 'Projeto vencedor A',
        idempotencyKey: mismatchedKey,
      }),
      createProject({
        ...request,
        name: 'Projeto vencedor B',
        idempotencyKey: mismatchedKey,
      }),
    ])
    assert.equal(mismatchedResults.filter((result) => result.status === 'fulfilled').length, 1)
    const mismatchedFailure = mismatchedResults.find((result) => result.status === 'rejected')
    assert.equal(mismatchedFailure?.reason?.code, 'IDEMPOTENCY_PAYLOAD_MISMATCH')
    assert.equal(await client.v2Project.count({ where: { workspaceId } }), 4)
    assert.equal(await client.v2ProjectVersion.count({ where: { workspaceId } }), 4)
    assert.equal(await client.v2ProjectSnapshot.count({ where: { workspaceId } }), 12)
    assert.equal(await client.v2IdempotencyRecord.count({ where: { workspaceId } }), 4)
    assert.equal(await client.v2PublicEventOutbox.count({ where: { workspaceId } }), 8)
    assert.equal(await client.v2ProjectCreationCommand.count({ where: { workspaceId } }), 4)

    let collisionEventCall = 0
    const createProjectWithCollision = createProjectService({
      repository: new PrismaCreationOutputBundleRepositoryV2(client),
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
          idempotencyKey: 'integration-create-project-collision',
        }),
      // The creation writer (output-version-bundle-repository.ts) lets the outbox primary-key collision escape as the driver's own
      // unique-violation (P2002) instead of mapping it to PERSISTENCE_CONFLICT; both are the same refusal, and what this proves is
      // the rollback asserted below.
      (error) => ['PERSISTENCE_CONFLICT', 'P2002'].includes(error?.code),
    )
    assert.equal(await client.v2Project.count({ where: { workspaceId } }), 4)
    assert.equal(await client.v2IdempotencyRecord.count({ where: { workspaceId } }), 4)
    assert.equal(await client.v2PublicEventOutbox.count({ where: { workspaceId } }), 8)
    assert.equal(await client.v2ProjectCreationCommand.count({ where: { workspaceId } }), 4)

    // The stored Command's audit columns can no longer be corrupted to prove the reader notices: project_creation_commands is
    // append-only (BEFORE UPDATE OR DELETE trigger), so that negative is retired. What stays reachable is the replay being bound to
    // the credential that created the project: the same key under another credential is a different request, never the first project.
    const otherCredentialAudit = createExternalAuditContext({
      clientId,
      credentialId: `${issued.credential.id}-other`,
      workspaceId,
      environment: 'sandbox',
    })
    await assert.rejects(
      () =>
        createProject({
          ...request,
          actor: Object.freeze({ ...actor, ...otherCredentialAudit, auditContext: otherCredentialAudit }),
        }),
      (error) => error?.code === 'IDEMPOTENCY_PAYLOAD_MISMATCH',
    )
    assert.equal(await client.v2Project.count({ where: { workspaceId } }), 4)
  } finally {
    await client.$disconnect()
  }
})
