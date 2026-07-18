import assert from 'node:assert/strict'
import test from 'node:test'

import {
  authenticateApiClientService,
  requireScope,
} from '../../src/v2/application/authenticate-api-client.ts'
import { createApiClientService } from '../../src/v2/application/create-api-client.ts'
import { DomainError } from '../../src/v2/domain/errors.ts'
import { nodeApiCredentialCrypto } from '../../src/v2/infrastructure/security/api-credential.ts'

class InMemoryApiClientRepository {
  constructor() {
    this.credentials = new Map()
    this.lastUsed = new Map()
  }

  async findCredentialById(clientId, credentialId) {
    return this.credentials.get(`${clientId}:${credentialId}`) ?? null
  }

  async createCredential(credential) {
    this.credentials.set(`${credential.client.id}:${credential.credential.id}`, credential)
    return { client: credential.client, credential: credential.credential }
  }

  async touchLastUsed(clientId, credentialId, usedAt) {
    this.lastUsed.set(`${clientId}:${credentialId}`, usedAt)
  }
}

async function createFixture() {
  const repository = new InMemoryApiClientRepository()
  const clock = () => new Date('2026-07-12T15:00:00.000Z')
  const createClient = createApiClientService({
    repository,
    credentialCrypto: nodeApiCredentialCrypto,
    clock,
  })
  const issued = await createClient({
    id: 'client-test-1',
    workspaceId: 'workspace-1',
    name: 'Integration Agent',
    environment: 'sandbox',
    scopes: ['projects:read', 'projects:write'],
  })

  return { repository, clock, issued }
}

test('issued API secret verifies and is only returned as an opaque token', async () => {
  const { repository, issued } = await createFixture()
  const stored = await repository.findCredentialById(
    issued.client.id,
    issued.credential.id,
  )
  const parsed = nodeApiCredentialCrypto.parse(issued.token)

  assert.equal(parsed.clientId, issued.client.id)
  assert.equal(parsed.credentialId, issued.credential.id)
  assert.notEqual(stored.secretHash, parsed.secret)
  assert.equal(
    await nodeApiCredentialCrypto.verify(parsed.secret, stored.secretSalt, stored.secretHash),
    true,
  )
})

test('authentication returns workspace-scoped actor and updates last use', async () => {
  const { repository, clock, issued } = await createFixture()
  const authenticate = authenticateApiClientService({
    repository,
    credentialCrypto: nodeApiCredentialCrypto,
    clock,
    environment: 'sandbox',
  })
  const actor = await authenticate(`Bearer ${issued.token}`)

  assert.equal(actor.clientId, issued.client.id)
  assert.equal(actor.workspaceId, 'workspace-1')
  assert.equal(actor.scopes.has('projects:write'), true)
  assert.equal(
    repository.lastUsed.get(`${issued.client.id}:${issued.credential.id}`),
    '2026-07-12T15:00:00.000Z',
  )
})

test('invalid token, wrong environment and missing scope are denied', async () => {
  const { repository, clock, issued } = await createFixture()
  const sandboxAuth = authenticateApiClientService({
    repository,
    credentialCrypto: nodeApiCredentialCrypto,
    clock,
    environment: 'sandbox',
  })
  const productionAuth = authenticateApiClientService({
    repository,
    credentialCrypto: nodeApiCredentialCrypto,
    clock,
    environment: 'production',
  })

  await assert.rejects(
    () => sandboxAuth('Bearer invalid'),
    (error) => error instanceof DomainError && error.code === 'AUTH_INVALID',
  )
  assert.throws(
    () => nodeApiCredentialCrypto.parse(`apollo_v2.${issued.client.id}.obsolete-secret-format`),
    (error) => error instanceof DomainError && error.code === 'AUTH_INVALID',
  )
  await assert.rejects(
    () => productionAuth(`Bearer ${issued.token}`),
    (error) => error instanceof DomainError && error.code === 'AUTH_INVALID',
  )

  const actor = await sandboxAuth(`Bearer ${issued.token}`)
  assert.throws(
    () => requireScope(actor, 'projects:approve'),
    (error) => error instanceof DomainError && error.code === 'AUTH_SCOPE_REQUIRED',
  )
})
