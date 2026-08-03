import assert from 'node:assert/strict'
import test from 'node:test'

import {
  authenticateApiClientService,
  requireScope,
} from '../../src/v2/application/authenticate-api-client.ts'
import { createApiClientService } from '../../src/v2/application/create-api-client.ts'
import { DomainError } from '../../src/v2/domain/errors.ts'
import {
  apiCredentialRef,
  createApiClient,
  createServiceAccount,
} from '../../src/v2/domain/api-client.ts'
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

test('service-account identity owns canonical grants, environments and credential refs', () => {
  const account = createServiceAccount({
    id: 'client-model-1', workspaceId: 'workspace-1', name: ' Model Agent ',
    status: 'active', scopeGrants: ['projects:write', 'projects:read'],
    allowedEnvironments: ['production', 'sandbox'], createdBy: 'client:administrator',
    createdAt: '2026-08-03T15:00:00.000Z',
  })
  assert.equal(account.schemaVersion, 2)
  assert.equal(account.type, 'service-account')
  assert.equal(account.name, 'Model Agent')
  assert.deepEqual(account.scopeGrants, ['projects:read', 'projects:write'])
  assert.deepEqual(account.allowedEnvironments, ['production', 'sandbox'])
  assert.equal(Object.isFrozen(account), true)
  assert.equal(Object.isFrozen(account.scopeGrants), true)
  assert.deepEqual(apiCredentialRef(account.id, 'credential-model-1'), {
    clientId: account.id, credentialId: 'credential-model-1',
  })

  const valid = { ...account, schemaVersion: undefined }
  delete valid.schemaVersion
  for (const mutation of [
    { type: 'unknown-client' },
    { allowedEnvironments: [] },
    { allowedEnvironments: ['sandbox', 'sandbox'] },
    { scopeGrants: ['projects:read', 'projects:read'] },
    { createdBy: 'unsafe creator' },
  ]) {
    assert.throws(
      () => createApiClient({ ...valid, ...mutation }),
      (error) => error instanceof DomainError && error.code === 'INVALID_API_CLIENT',
    )
  }
  assert.throws(
    () => apiCredentialRef('../client', 'credential-model-1'),
    (error) => error instanceof DomainError && error.code === 'INVALID_API_CLIENT',
  )
})

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
  assert.equal(Object.isFrozen(parsed), true)
  assert.match(parsed.secret, /^[A-Za-z0-9_-]{43}$/)
  assert.equal(Buffer.from(parsed.secret, 'base64url').byteLength, 32)
  assert.match(stored.secretSalt, /^[A-Za-z0-9_-]{22}$/)
  assert.equal(Buffer.from(stored.secretSalt, 'base64url').byteLength, 16)
  assert.match(stored.secretHash, /^[a-f0-9]{64}$/)
  assert.notEqual(stored.secretHash, parsed.secret)
  assert.equal(
    await nodeApiCredentialCrypto.verify(parsed.secret, stored.secretSalt, stored.secretHash),
    true,
  )
  assert.equal(
    await nodeApiCredentialCrypto.verify(parsed.secret, 'invalid salt', stored.secretHash),
    false,
  )
  assert.equal(
    await nodeApiCredentialCrypto.verify(parsed.secret, stored.secretSalt, 'not-a-hash'),
    false,
  )
  assert.equal(
    await nodeApiCredentialCrypto.verify(
      'aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa',
      'bbbbbbbbbbbbbbbbbbbbbb',
      'b0a5e1349475499bf3b5ecfc1ad0ab16ef8d220f6a55a8758d80c092f8034a10',
    ),
    true,
  )
  assert.throws(
    () => nodeApiCredentialCrypto.issue('../client', 'credential-test-1'),
    (error) => error instanceof DomainError && error.code === 'INVALID_API_CLIENT',
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
  const parsed = nodeApiCredentialCrypto.parse(issued.token)
  for (const malformed of [
    `${issued.token}=`,
    `${issued.token}.extra`,
    `apollo_v2.${issued.client.id}.${issued.credential.id}.${'a'.repeat(42)}`,
    `apollo_v2.${issued.client.id}.${issued.credential.id}.${'a'.repeat(44)}`,
  ]) {
    assert.throws(
      () => nodeApiCredentialCrypto.parse(malformed),
      (error) => error instanceof DomainError && error.code === 'AUTH_INVALID',
    )
  }
  await assert.rejects(
    () => sandboxAuth(`Bearer  ${issued.token}`),
    (error) => error instanceof DomainError && error.code === 'AUTH_INVALID',
  )
  await assert.rejects(
    () => sandboxAuth(`Bearer ${issued.token}${'a'.repeat(256)}`),
    (error) => error instanceof DomainError && error.code === 'AUTH_INVALID',
  )
  await assert.rejects(
    () => productionAuth(`Bearer ${issued.token}`),
    (error) => error instanceof DomainError && error.code === 'AUTH_INVALID',
  )

  const actor = await sandboxAuth(`bearer ${issued.token}`)
  assert.throws(
    () => requireScope(actor, 'projects:approve'),
    (error) => error instanceof DomainError && error.code === 'AUTH_SCOPE_REQUIRED',
  )

  const key = `${issued.client.id}:${issued.credential.id}`
  const stored = repository.credentials.get(key)
  repository.credentials.set(key, { ...stored, secretSalt: 'corrupted' })
  await assert.rejects(
    () => sandboxAuth(`Bearer ${issued.token}`),
    (error) => error instanceof DomainError && error.code === 'AUTH_INVALID',
  )
  assert.equal(parsed.secret.length, 43)
})
