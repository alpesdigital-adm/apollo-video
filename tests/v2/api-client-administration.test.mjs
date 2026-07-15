import assert from 'node:assert/strict'
import test from 'node:test'

import {
  createApiClientAdministrationService,
  revokeApiCredentialService,
} from '../../src/v2/application/administer-api-clients.ts'
import { DomainError } from '../../src/v2/domain/errors.ts'
import { PrismaApiClientRepository } from '../../src/v2/infrastructure/prisma/api-client-repository.ts'
import { nodeApiCredentialCrypto } from '../../src/v2/infrastructure/security/api-credential.ts'

class InMemoryAdministrationRepository {
  constructor() {
    this.idempotency = new Map()
  }

  async listByWorkspace() {
    return []
  }

  async createOrReplay(bundle) {
    this.lastCreateBundle = bundle
    const identity = `${bundle.idempotency.workspaceId}:${bundle.idempotency.actorClientId}:${bundle.idempotency.key}`
    const existing = this.idempotency.get(identity)
    if (existing) return { ...existing, replayed: true }
    const result = {
      client: bundle.client,
      credential: bundle.credential,
      replayed: false,
    }
    this.idempotency.set(identity, result)
    return result
  }

  async rotateOrReplay() {
    throw new Error('not used')
  }

  async revokeCredential() {
    throw new Error('not used')
  }
}

function actor(scopes = ['clients:admin', 'projects:read']) {
  return {
    clientId: 'admin-client',
    credentialId: 'admin-credential',
    workspaceId: 'workspace-1',
    environment: 'sandbox',
    scopes: new Set(scopes),
  }
}

function dependencies(repository) {
  let counter = 0
  return {
    repository,
    credentialCrypto: nodeApiCredentialCrypto,
    clock: () => new Date('2026-07-12T23:45:00.000Z'),
    createId: (kind) => `${kind}-${++counter}`,
  }
}

test('client administration cannot grant a scope the administrator does not possess', async () => {
  const execute = createApiClientAdministrationService(
    dependencies(new InMemoryAdministrationRepository()),
  )

  await assert.rejects(
    () =>
      execute({
        actor: actor(),
        workspaceId: 'workspace-1',
        name: 'Escalated client',
        scopes: ['projects:write'],
        idempotencyKey: 'scope-escalation',
      }),
    (error) => error instanceof DomainError && error.code === 'AUTH_SCOPE_REQUIRED',
  )
})

test('idempotent client creation only returns the bearer token once', async () => {
  const repository = new InMemoryAdministrationRepository()
  const execute = createApiClientAdministrationService(dependencies(repository))
  const request = {
    actor: actor(),
    workspaceId: 'workspace-1',
    name: 'Read Agent',
    scopes: ['projects:read'],
    idempotencyKey: 'create-read-agent',
  }

  const first = await execute(request)
  const replay = await execute(request)

  assert.equal(first.replayed, false)
  assert.equal(first.secretAvailable, true)
  assert.match(first.token, /^apollo_v2\./)
  assert.equal(replay.replayed, true)
  assert.equal(replay.secretAvailable, false)
  assert.equal(replay.token, undefined)
  assert.equal(replay.client.id, first.client.id)
  assert.equal(replay.credential.id, first.credential.id)
})

test('API client creation retries concurrent write conflicts before failing explicitly', async () => {
  const source = new InMemoryAdministrationRepository()
  const execute = createApiClientAdministrationService(dependencies(source))
  await execute({
    actor: actor(),
    workspaceId: 'workspace-1',
    name: 'Read Agent',
    scopes: ['projects:read'],
    idempotencyKey: 'create-read-agent-retry-fixture',
  })
  let attempts = 0
  const repository = new PrismaApiClientRepository({
    async $transaction() {
      attempts += 1
      const error = new Error('concurrent write conflict')
      error.code = attempts % 2 === 0 ? 'P2002' : 'P2034'
      throw error
    },
  })

  await assert.rejects(
    () => repository.createOrReplay(source.lastCreateBundle),
    (error) => error instanceof DomainError && error.code === 'PERSISTENCE_CONFLICT',
  )
  assert.equal(attempts, 3)
})

test('credential used by the current request cannot revoke itself', async () => {
  const execute = revokeApiCredentialService({
    repository: new InMemoryAdministrationRepository(),
    clock: () => new Date('2026-07-12T23:45:00.000Z'),
  })

  await assert.rejects(
    () =>
      execute({
        actor: actor(),
        workspaceId: 'workspace-1',
        targetClientId: 'admin-client',
        credentialId: 'admin-credential',
      }),
    (error) => error instanceof DomainError && error.code === 'PERSISTENCE_CONFLICT',
  )
})
