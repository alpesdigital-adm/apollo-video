import assert from 'node:assert/strict'
import test from 'node:test'

import {
  createApiClientAdministrationService,
  revokeApiCredentialService,
  rotateApiCredentialService,
} from '../../src/v2/application/administer-api-clients.ts'
import { createExternalAuditContext } from '../../src/v2/application/authenticate-api-client.ts'
import { createApiAccessAuditContext } from '../../src/v2/domain/api-access-control.ts'
import { createApiAdministrationCommand } from '../../src/v2/domain/api-administration-command.ts'
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
    if (existing) {
      if (existing.command.requestFingerprint !== bundle.command.requestFingerprint) {
        throw new DomainError('IDEMPOTENCY_PAYLOAD_MISMATCH', 'mismatch')
      }
      return { ...existing, replayed: true }
    }
    const result = {
      client: bundle.client,
      credential: bundle.credential,
      command: bundle.command,
      replayed: false,
    }
    this.idempotency.set(identity, result)
    return result
  }

  async rotateOrReplay(bundle) {
    this.lastRotateBundle = bundle
    const identity = `${bundle.idempotency.workspaceId}:${bundle.idempotency.actorClientId}:${bundle.idempotency.key}`
    const existing = this.idempotency.get(identity)
    if (existing) {
      if (existing.command.requestFingerprint !== bundle.command.requestFingerprint) {
        throw new DomainError('IDEMPOTENCY_PAYLOAD_MISMATCH', 'mismatch')
      }
      return { ...existing, replayed: true }
    }
    const result = {
      client: {
        id: bundle.targetClientId,
        workspaceId: bundle.workspaceId,
        name: 'Target client',
        type: 'service-account',
        status: 'active',
        allowedEnvironments: ['sandbox'],
        scopeGrants: ['projects:read'],
        createdBy: 'admin-client',
        createdAt: bundle.credential.createdAt,
      },
      credential: bundle.credential,
      command: bundle.command,
      replayed: false,
    }
    this.idempotency.set(identity, result)
    return result
  }

  async revokeCredential() {
    throw new Error('not used')
  }
}

function actor(scopes = ['clients:admin', 'projects:read'], identityOverrides = {}) {
  const auditContext = createExternalAuditContext({
    clientId: 'admin-client', credentialId: 'admin-credential',
    workspaceId: 'workspace-1', environment: 'sandbox',
    ...identityOverrides,
  })
  return {
    ...auditContext,
    scopes: new Set(scopes),
    authenticationKind: 'bearer', clientKillSwitchEngaged: false,
    workspaceKillSwitchEngaged: false, clientAccessStatus: 'active',
    workspaceAccessStatus: 'active', auditContext,
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
  assert.equal(repository.lastCreateBundle.idempotency.createdAt, '2026-07-12T23:45:00.000Z')
  assert.equal(repository.lastCreateBundle.command.action, 'api-client.create')
  assert.equal(repository.lastCreateBundle.command.audit.credentialId, 'admin-credential')
  assert.match(repository.lastCreateBundle.command.audit.contextHash, /^[a-f0-9]{64}$/)
  assert.equal(JSON.stringify(repository.lastCreateBundle).includes('apollo_v2.'), false)
})

test('client administration replay is bound to the authenticating credential', async () => {
  const repository = new InMemoryAdministrationRepository()
  const execute = createApiClientAdministrationService(dependencies(repository))
  const request = {
    actor: actor(), workspaceId: 'workspace-1', name: 'Bound Agent',
    scopes: ['projects:read'], idempotencyKey: 'create-bound-agent',
  }
  await execute(request)
  await assert.rejects(
    () => execute({
      ...request,
      actor: actor(undefined, { credentialId: 'admin-credential-other' }),
    }),
    (error) => error instanceof DomainError && error.code === 'IDEMPOTENCY_PAYLOAD_MISMATCH',
  )
})

test('idempotent credential rotation only returns the new bearer token once', async () => {
  const repository = new InMemoryAdministrationRepository()
  const execute = rotateApiCredentialService(dependencies(repository))
  const request = {
    actor: actor(), workspaceId: 'workspace-1', targetClientId: 'target-client',
    idempotencyKey: 'rotate-read-agent', overlapSeconds: 30,
  }

  const first = await execute(request)
  const replay = await execute(request)

  assert.equal(first.secretAvailable, true)
  assert.match(first.token, /^apollo_v2\./)
  assert.equal(replay.secretAvailable, false)
  assert.equal(replay.token, undefined)
  assert.equal(replay.credential.id, first.credential.id)
  assert.equal(repository.lastRotateBundle.idempotency.createdAt, '2026-07-12T23:45:00.000Z')
  assert.equal(repository.lastRotateBundle.overlapUntil, '2026-07-12T23:45:30.000Z')
  assert.equal(repository.lastRotateBundle.command.action, 'api-credential.rotate')
  assert.equal(repository.lastRotateBundle.command.audit.credentialId, 'admin-credential')
  assert.equal(JSON.stringify(repository.lastRotateBundle).includes('apollo_v2.'), false)
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

test('API credential rotation retries concurrent write conflicts before failing explicitly', async () => {
  const source = new InMemoryAdministrationRepository()
  const execute = rotateApiCredentialService(dependencies(source))
  await execute({
    actor: actor(),
    workspaceId: 'workspace-1',
    targetClientId: 'target-client',
    idempotencyKey: 'rotate-read-agent-retry-fixture',
    overlapSeconds: 30,
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
    () => repository.rotateOrReplay(source.lastRotateBundle),
    (error) => error instanceof DomainError && error.code === 'PERSISTENCE_CONFLICT',
  )
  assert.equal(attempts, 3)
})

test('API credential revocation retries serialization conflicts before failing explicitly', async () => {
  let attempts = 0
  const repository = new PrismaApiClientRepository({
    async $transaction() {
      attempts += 1
      const error = new Error('serialization conflict')
      error.code = 'P2034'
      throw error
    },
  })

  const audit = createApiAccessAuditContext({
    clientId: 'admin-client', credentialId: 'admin-credential',
    workspaceId: 'workspace-1', environment: 'sandbox', authenticationKind: 'bearer',
  })

  await assert.rejects(
    () => repository.revokeCredential({
      command: createApiAdministrationCommand({
        id: 'api-administration-command-revoke-retry', workspaceId: 'workspace-1',
        action: 'api-credential.revoke', targetClientId: 'target-client',
        targetCredentialId: 'target-credential', audit,
        requestFingerprint: 'f'.repeat(64), occurredAt: '2026-07-16T15:00:00.000Z',
      }),
      workspaceId: 'workspace-1',
      clientId: 'target-client',
      credentialId: 'target-credential',
      revokedAt: '2026-07-16T15:00:00.000Z',
    }),
    (error) => error instanceof DomainError && error.code === 'PERSISTENCE_CONFLICT',
  )
  assert.equal(attempts, 3)
})

test('credential revocation and its immutable audit command commit atomically and converge', async () => {
  let credential = {
    id: 'target-credential', workspaceId: 'workspace-1', clientId: 'target-client',
    status: 'active', secretSalt: 'a'.repeat(22), secretHash: 'b'.repeat(64),
    expiresAt: null, createdAt: new Date('2026-07-12T20:00:00.000Z'),
    lastUsedAt: null, revokedAt: null,
  }
  let storedCommand = null
  let commandCreateCount = 0
  const transaction = {
    v2ApiCredential: {
      async findFirst() { return credential },
      async updateMany({ data }) {
        credential = { ...credential, ...data }
        return { count: 1 }
      },
    },
    v2ApiAdministrationCommand: {
      async findUnique() { return storedCommand },
      async create({ data }) {
        commandCreateCount += 1
        storedCommand = { ...data, createdAt: new Date(data.occurredAt) }
        return storedCommand
      },
    },
  }
  const repository = new PrismaApiClientRepository({
    async $transaction(callback) { return callback(transaction) },
  })
  let commandSequence = 0
  const execute = revokeApiCredentialService({
    repository,
    clock: () => new Date('2026-07-16T15:00:00.000Z'),
    createId: () => `api-administration-command-revoke-${++commandSequence}`,
  })
  const request = {
    actor: actor(), workspaceId: 'workspace-1', targetClientId: 'target-client',
    credentialId: 'target-credential',
  }
  const first = await execute(request)
  const converged = await execute(request)
  assert.equal(first.status, 'revoked')
  assert.equal(converged.status, 'revoked')
  assert.equal(commandCreateCount, 1)
  assert.equal(storedCommand.action, 'api-credential.revoke')
  assert.equal(storedCommand.actorCredentialId, 'admin-credential')
  assert.equal(storedCommand.actorAuthenticationKind, 'bearer')
  assert.equal(storedCommand.idempotencyKey, undefined)
  assert.match(storedCommand.actorContextHash, /^[a-f0-9]{64}$/)
})

test('credential used by the current request cannot revoke itself', async () => {
  const execute = revokeApiCredentialService({
    repository: new InMemoryAdministrationRepository(),
    clock: () => new Date('2026-07-12T23:45:00.000Z'),
    createId: (kind) => `${kind}-self-revoke`,
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
